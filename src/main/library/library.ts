import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { copyFile, lstat, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import type { Accent, AssetFile, NodeKind, PageData, Tree } from '../../shared/api'
import {
  describeLockError,
  exists,
  fingerprint,
  isLockError,
  isMissing,
  readFileWithRetry,
  readText,
  readTextStrict,
  renameWithRetry,
  TEMP_FILE,
  WriteQueue,
} from './fsx'
import {
  ASSETS_DIR,
  CHAPTER_FILE,
  emptyScene,
  find,
  FORMAT,
  LIBRARY_FILE,
  MAX_SCENE_BYTES,
  NOTES_EXT,
  sceneFileIds,
  SCENE_EXT,
  SHAPES_FILE,
  SPACE_FILE,
  TRASH_DIR,
  withSceneId,
  type ChapterRec,
  type Found,
  type Model,
  type PageRec,
  type SpaceRec,
  accentFor,
} from './model'
import {
  assertInsideRoot,
  conflictStamp,
  isConflictName,
  sanitizeName,
  uniqueName,
  withSuffix,
} from './paths'
import {
  FormatError,
  scan,
  UnreadableLibraryError,
  type ScanProblem,
  type ScanResult,
} from './scan'

export interface LibraryDeps {
  /** Moves a file or folder to the OS trash. Injected so tests can fake it. */
  trash(path: string): Promise<void>
  /** How long to wait for the OS trash before using the library's `.trash/` folder. */
  trashTimeoutMs?: number
}

/** The OS trash can hang (seen on headless macOS); a delete must never wait on it forever. */
const TRASH_TIMEOUT_MS = 10_000

export interface LibraryEvents {
  tree: [Tree]
  pageChanged: [string]
  /** A page's scene or notes were saved or removed; `text` is the drawing text if known. */
  pageSaved: [id: string]
  pageRemoved: [id: string]
  /** Something the user should hear about that didn't come back from their own request. */
  notice: [message: string]
}

const UNDO_WINDOW_MS = 6000
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
  'image/x-icon': 'ico',
}
const EXT_MIME = Object.fromEntries(Object.entries(MIME_EXT).map(([m, e]) => [e, m]))

function clampIndex(index: number, length: number): number {
  return Math.max(0, Math.min(Number.isFinite(index) ? Math.trunc(index) : length, length))
}

/** `index` is a position in `list` once the item is taken out. */
function moveWithin<T extends { id: string }>(list: T[], id: string, index: number): void {
  const from = list.findIndex((x) => x.id === id)
  if (from < 0) return
  const [item] = list.splice(from, 1)
  if (item) list.splice(clampIndex(index, list.length), 0, item)
}

/** Lower-cased on the case-insensitive file systems of Windows and macOS. */
function pathKey(path: string): string {
  const abs = resolve(path)
  return process.platform === 'win32' || process.platform === 'darwin' ? abs.toLowerCase() : abs
}

const pageIdsOf = (model: Model) =>
  new Set(model.spaces.flatMap((s) => s.chapters.flatMap((c) => c.pages.map((p) => p.id))))

/** A trash that stopped part-way. Says what went to the trash and where everything else is now. */
class TrashError extends Error {
  constructor(
    readonly reason: unknown,
    /** Original paths that reached the trash. */
    readonly trashed: string[],
    /** Everything else: `now` is where it is (its original path, unless it couldn't be put back). */
    readonly left: Array<{ original: string; now: string }>,
  ) {
    super(reason instanceof Error ? reason.message : String(reason))
  }
}

const COULD_NOT_DELETE = ' (could not delete)'

/**
 * The library on disk. All structural operations and rescans run one at a time
 * (see `exclusive`), so the in-memory model always matches the folders.
 */
export class Library extends EventEmitter<LibraryEvents> {
  model: Model = { spaces: [] }
  readonly queue = new WriteQueue()
  private lock: Promise<unknown> = Promise.resolve()
  private readonly removals = new Map<string, NodeJS.Timeout>()
  private lastTree = ''
  /** Metadata files and folders the last scan couldn't read: Zenbook won't write over them. */
  private unreadable: ScanProblem[] = []
  /** Set while zenbook.json can't be read or is from a newer version: no metadata is written. */
  private frozen: string | null = null
  /** Notices already shown, so a problem that persists across rescans is reported once. */
  private readonly reported = new Set<string>()
  /** Notices raised before anyone listened (during open). */
  private backlog: string[] = []
  /** Normalised scene/notes path → page ID, rebuilt lazily after the model changes. */
  private pathIndex: Map<string, string> | null = null

  private constructor(
    readonly root: string,
    private readonly deps: LibraryDeps,
  ) {
    super()
  }

  /** Opens an existing library folder, or initialises an empty one. */
  static async open(root: string, deps: LibraryDeps): Promise<Library> {
    // Always absolute: own-write detection and the watcher compare absolute paths.
    const abs = resolve(root)
    const lib = new Library(abs, deps)
    await mkdir(abs, { recursive: true })
    if (await isMissing(join(abs, LIBRARY_FILE))) {
      await lib.queue.write(join(abs, LIBRARY_FILE), json({ format: FORMAT, spaces: [] }))
    }
    await lib.rescan()
    void lib.sweepTempFiles().catch(() => undefined)
    return lib
  }

  /** Shows a notice once; the same `key` stays quiet until the problem has gone away. */
  private noticeOnce(key: string, message: string): void {
    if (this.reported.has(key)) return
    this.reported.add(key)
    this.notify(message)
  }

  private notify(message: string): void {
    if (this.listenerCount('notice') === 0) this.backlog.push(message)
    else this.emit('notice', message)
  }

  /** Re-emits notices raised before the first listener was attached (e.g. while opening). */
  replayNotices(): void {
    const pending = this.backlog
    this.backlog = []
    for (const message of pending) this.notify(message)
  }

  /** Reports a failed background rescan (from the watcher) instead of dropping it. */
  reportRescanFailure(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err)
    const known = err instanceof FormatError || err instanceof UnreadableLibraryError
    this.noticeOnce('rescan', known ? message : `Couldn’t refresh the library: ${message}`)
  }

  /**
   * Removes temp files that interrupted atomic writes left behind (a crash, a full
   * disk), if they are more than `maxAgeMs` old. Only Zenbook's own temp-file names
   * in the folders Zenbook writes to are touched, never anything else.
   */
  async sweepTempFiles(maxAgeMs = 60 * 60 * 1000): Promise<number> {
    const dirs = [this.root]
    for (const s of this.model.spaces) {
      dirs.push(join(this.root, s.name), join(this.root, s.name, ASSETS_DIR))
      for (const c of s.chapters) dirs.push(join(this.root, s.name, c.name))
    }
    const now = Date.now()
    let removed = 0
    for (const dir of dirs) {
      for (const name of await this.siblingsOnDisk(dir)) {
        if (!TEMP_FILE.test(name)) continue
        const path = join(dir, name)
        try {
          const info = await lstat(path)
          if (!info.isFile() || now - info.mtimeMs < maxAgeMs) continue
          await rm(path, { force: true })
          removed++
        } catch {
          // In use or already gone: try again next time.
        }
      }
    }
    return removed
  }

  // ---------- plumbing ----------

  /** Runs `fn` after every earlier operation has finished. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn)
    this.lock = run.catch(() => undefined)
    return run
  }

  private p(...parts: string[]): string {
    return assertInsideRoot(this.root, join(this.root, ...parts))
  }
  spaceDir(s: SpaceRec): string {
    return this.p(s.name)
  }
  chapterDir(s: SpaceRec, c: ChapterRec): string {
    return this.p(s.name, c.name)
  }
  scenePath(s: SpaceRec, c: ChapterRec, page: PageRec): string {
    return this.p(s.name, c.name, page.name + SCENE_EXT)
  }
  notesPath(s: SpaceRec, c: ChapterRec, page: PageRec): string {
    return this.p(s.name, c.name, page.name + NOTES_EXT)
  }
  private assetsDir(s: SpaceRec): string {
    return this.p(s.name, ASSETS_DIR)
  }

  private get(id: string): Found {
    const found = find(this.model, id)
    if (!found || this.removals.has(id)) throw new Error(`Unknown item: ${id}`)
    return found
  }
  private getPage(id: string) {
    const f = this.get(id)
    if (f.kind !== 'page') throw new Error(`Not a page: ${id}`)
    return f
  }
  private getChapter(id: string) {
    const f = this.get(id)
    if (f.kind !== 'chapter') throw new Error(`Not a chapter: ${id}`)
    return f
  }
  private getSpace(id: string) {
    const f = this.get(id)
    if (f.kind !== 'space') throw new Error(`Not a space: ${id}`)
    return f
  }

  private nameOf(f: Found): string {
    if (f.kind === 'space') return f.space.name
    if (f.kind === 'chapter') return f.chapter.name
    return f.page.name
  }

  /**
   * Refuses to write metadata over a file (or into a folder) the last scan couldn't
   * read: it may hold IDs, order, colours or pins that Zenbook can't see. A parent's
   * metadata is refused too while one of its children's can't be read, because it
   * lists that child by an ID the scan may have had to make up.
   */
  private assertWritable(path: string): void {
    if (this.frozen) throw new Error(this.frozen)
    const key = pathKey(path)
    const dir = dirname(key)
    for (const u of this.unreadable) {
      const blocked = pathKey(u.path)
      const childOfDir = u.folder ? dirname(blocked) === dir : dirname(dirname(blocked)) === dir
      if (key === blocked || key.startsWith(blocked + sep) || childOfDir) {
        throw new Error(
          `Couldn’t read “${u.rel}”, so Zenbook won’t change it. Fix the file, or close the program that is using it, then try again.`,
        )
      }
    }
  }

  private async writeMeta(path: string, data: string): Promise<void> {
    this.assertWritable(path)
    await this.queue.write(path, data)
  }

  private spaceMeta(s: SpaceRec): string {
    return join(this.spaceDir(s), SPACE_FILE)
  }
  private chapterMeta(s: SpaceRec, c: ChapterRec): string {
    return join(this.chapterDir(s, c), CHAPTER_FILE)
  }

  private writeLibraryJson() {
    return this.writeMeta(
      join(this.root, LIBRARY_FILE),
      json({ format: FORMAT, spaces: this.model.spaces.map((s) => s.id) }),
    )
  }
  private writeSpaceJson(s: SpaceRec) {
    return this.writeMeta(
      this.spaceMeta(s),
      json({ id: s.id, color: s.color, chapters: s.chapters.map((c) => c.id), pinned: s.pinned }),
    )
  }
  private writeChapterJson(s: SpaceRec, c: ChapterRec) {
    return this.writeMeta(
      this.chapterMeta(s, c),
      json({ id: c.id, pages: c.pages.map((p) => ({ id: p.id, file: p.name })) }),
    )
  }

  /** The tree the renderer sees: pending deletions are already hidden. */
  tree(): Tree {
    const hidden = this.removals
    return {
      spaces: this.model.spaces
        .filter((s) => !hidden.has(s.id))
        .map((s) => ({
          id: s.id,
          name: s.name,
          color: s.color,
          pinned: s.pinned.filter((id) => !hidden.has(id)),
          chapters: s.chapters
            .filter((c) => !hidden.has(c.id))
            .map((c) => ({
              id: c.id,
              name: c.name,
              pages: c.pages
                .filter((pg) => !hidden.has(pg.id))
                .map((pg) => ({ id: pg.id, name: pg.name, conflict: isConflictName(pg.name) })),
            })),
        })),
    }
  }

  private publish(): void {
    const tree = this.tree()
    const key = JSON.stringify(tree)
    if (key === this.lastTree) return
    this.lastTree = key
    this.emit('tree', tree)
  }

  /** True while the item (a space, chapter or page) is hidden in its undo window. */
  isPendingRemoval(id: string): boolean {
    return this.removals.has(id)
  }

  /** Re-reads the folders (after external changes) and publishes the tree if it changed. */
  rescan(): Promise<void> {
    return this.exclusive(() => this.reload())
  }

  /** The body of rescan; call only from inside `exclusive`. */
  private async reload(): Promise<void> {
    let result: ScanResult
    try {
      result = await scan(this.root, this.queue, this.model)
    } catch (err) {
      // The model stays as it was. Until the library file can be read again (or the
      // app is updated), nothing writes metadata: a newer format must never be downgraded.
      if (err instanceof FormatError || err instanceof UnreadableLibraryError) {
        this.frozen = err.message
      }
      throw err
    }
    this.frozen = null
    const before = pageIdsOf(this.model)
    this.model = result.model
    this.pathIndex = null
    this.unreadable = result.unreadable
    for (const message of result.notices) this.notify(message)

    const current = new Set<string>()
    for (const u of result.unreadable) {
      const key = `read:${u.rel}`
      current.add(key)
      this.noticeOnce(key, `Couldn’t read “${u.rel}”; it was left as it is.`)
    }
    for (const w of result.writeFailures) {
      const key = `write:${w.rel}`
      current.add(key)
      const why = isLockError(w.error)
        ? 'it’s open in another program'
        : w.error instanceof Error
          ? w.error.message
          : String(w.error)
      this.noticeOnce(key, `Couldn’t update “${w.rel}”: ${why}. Zenbook will try again later.`)
    }
    // Problems that have gone away may be reported again if they come back.
    for (const key of [...this.reported]) if (!current.has(key)) this.reported.delete(key)

    const after = pageIdsOf(this.model)
    for (const id of before) if (!after.has(id)) this.emit('pageRemoved', id)
    this.publish()
  }

  private async mutate<T>(fn: () => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      const snapshot = structuredClone(this.model)
      let result: T
      try {
        result = await fn()
      } catch (err) {
        // Drop the half-applied change, then re-read the folders, since part of it may
        // have reached the disk: the model (and the sidebar) match the folders again.
        this.model = snapshot
        this.pathIndex = null
        await this.reload().catch(() => undefined)
        this.publish()
        throw err
      }
      this.pathIndex = null
      this.publish()
      return result
    })
  }

  private async siblingsOnDisk(dir: string): Promise<string[]> {
    try {
      return await readdir(dir)
    } catch {
      return []
    }
  }

  /** Page names already used in a chapter folder (by either the scene or the notes file). */
  private async pageNamesIn(dir: string): Promise<string[]> {
    return (await this.siblingsOnDisk(dir))
      .filter((f) => f.toLowerCase().endsWith(SCENE_EXT) || f.toLowerCase().endsWith(NOTES_EXT))
      .map((f) => f.replace(/\.(excalidraw|md)$/i, ''))
  }

  // ---------- create ----------

  create(kind: NodeKind, parentId: string | null, name?: string): Promise<string> {
    return this.mutate(async () => {
      if (kind === 'space') return this.createSpace(name)
      if (!parentId) throw new Error('A parent is required')
      if (kind === 'chapter') return this.createChapter(this.getSpace(parentId).space, name)
      const f = this.get(parentId)
      // A page can be created "after" another page, or at the end of a chapter.
      if (f.kind === 'page') return this.createPage(f.space, f.chapter, name, f.page.id)
      if (f.kind === 'chapter') return this.createPage(f.space, f.chapter, name)
      throw new Error('Pages belong in chapters')
    })
  }

  private async createSpace(name?: string): Promise<string> {
    this.assertWritable(join(this.root, LIBRARY_FILE)) // before touching the disk
    const taken = await this.siblingsOnDisk(this.root)
    const space: SpaceRec = {
      id: randomUUID(),
      name: uniqueName(sanitizeName(name ?? 'Untitled Space'), taken),
      color: 'sage',
      chapters: [],
      pinned: [],
    }
    space.color = accentFor(space.id)
    await mkdir(this.spaceDir(space), { recursive: true })
    this.model.spaces.push(space)
    await this.writeSpaceJson(space)
    await this.writeLibraryJson()
    return space.id
  }

  private async createChapter(space: SpaceRec, name?: string): Promise<string> {
    this.assertWritable(this.spaceMeta(space))
    const taken = await this.siblingsOnDisk(this.spaceDir(space))
    const chapter: ChapterRec = {
      id: randomUUID(),
      name: uniqueName(sanitizeName(name ?? 'Untitled Chapter'), taken),
      pages: [],
    }
    await mkdir(this.chapterDir(space, chapter), { recursive: true })
    space.chapters.push(chapter)
    await this.writeChapterJson(space, chapter)
    await this.writeSpaceJson(space)
    return chapter.id
  }

  private async createPage(
    space: SpaceRec,
    chapter: ChapterRec,
    name?: string,
    afterId?: string,
    scene?: string | null,
    notes?: string,
  ): Promise<string> {
    this.assertWritable(this.chapterMeta(space, chapter))
    const dir = this.chapterDir(space, chapter)
    const page: PageRec = {
      id: randomUUID(),
      name: uniqueName(sanitizeName(name ?? 'Untitled'), await this.pageNamesIn(dir)),
    }
    await this.queue.write(
      this.scenePath(space, chapter, page),
      withSceneId(scene ?? emptyScene(page.id), page.id),
    )
    if (notes && notes.trim()) await this.queue.write(this.notesPath(space, chapter, page), notes)
    const after = afterId ? chapter.pages.findIndex((x) => x.id === afterId) : -1
    chapter.pages.splice(after >= 0 ? after + 1 : chapter.pages.length, 0, page)
    await this.writeChapterJson(space, chapter)
    return page.id
  }

  // ---------- rename ----------

  rename(id: string, rawName: string): Promise<void> {
    return this.mutate(async () => {
      const f = this.get(id)
      try {
        await this.renameFound(f, sanitizeName(rawName))
      } catch (err) {
        throw describeLockError(err, this.nameOf(f))
      }
    })
  }

  private async renameFound(f: Found, name: string): Promise<void> {
    if (f.kind === 'space') {
      const target = uniqueName(
        name,
        (await this.siblingsOnDisk(this.root)).filter((n) => n !== f.space.name),
      )
      if (target === f.space.name) return
      await renameWithRetry(this.spaceDir(f.space), this.p(target))
      f.space.name = target
    } else if (f.kind === 'chapter') {
      const dir = this.spaceDir(f.space)
      const target = uniqueName(
        name,
        (await this.siblingsOnDisk(dir)).filter((n) => n !== f.chapter.name),
      )
      if (target === f.chapter.name) return
      await renameWithRetry(this.chapterDir(f.space, f.chapter), join(dir, target))
      f.chapter.name = target
    } else {
      const { space, chapter, page } = f
      const taken = (await this.pageNamesIn(this.chapterDir(space, chapter))).filter(
        (n) => n !== page.name,
      )
      const target = uniqueName(name, taken)
      if (target === page.name) return
      this.assertWritable(this.chapterMeta(space, chapter))
      await this.movePageFiles(space, chapter, page, space, chapter, target)
      await this.writeChapterJson(space, chapter)
    }
  }

  /** Renames or moves a page's scene and notes files together. */
  private async movePageFiles(
    fromSpace: SpaceRec,
    fromChapter: ChapterRec,
    page: PageRec,
    toSpace: SpaceRec,
    toChapter: ChapterRec,
    newName: string,
  ): Promise<void> {
    const target: PageRec = { id: page.id, name: newName }
    const oldScene = this.scenePath(fromSpace, fromChapter, page)
    const oldNotes = this.notesPath(fromSpace, fromChapter, page)
    const newScene = this.scenePath(toSpace, toChapter, target)
    await this.queue.drain()
    await renameWithRetry(oldScene, newScene)
    await this.queue.remember(newScene)
    if (await exists(oldNotes)) {
      const newNotes = this.notesPath(toSpace, toChapter, target)
      try {
        await renameWithRetry(oldNotes, newNotes)
      } catch (err) {
        // Keep the page whole: put the drawing back next to its notes. If even that
        // fails, `mutate` re-reads the folders, so the page is still found by its ID
        // (embedded in the drawing). Either way the caller hears the original error.
        await renameWithRetry(newScene, oldScene)
          .then(() => this.queue.remember(oldScene))
          .catch(() => undefined)
        throw err
      }
      await this.queue.remember(newNotes)
    }
    page.name = newName
  }

  /**
   * The renderer computes drop indexes from the tree it sees, where items in their
   * undo window are hidden. Maps such an index (a position among the visible
   * siblings, with the moved item taken out) to a position in `list` without it.
   */
  private modelIndex<T extends { id: string }>(list: T[], id: string, index: number): number {
    const others = list.filter((x) => x.id !== id)
    const visible = others.filter((x) => !this.removals.has(x.id))
    const at = clampIndex(index, visible.length)
    const anchor = visible[at]
    return anchor ? others.indexOf(anchor) : others.length
  }

  // ---------- move / reorder ----------

  move(id: string, parentId: string | null, index: number): Promise<void> {
    return this.mutate(async () => {
      const f = this.get(id)
      try {
        await this.moveFound(f, id, parentId, index)
      } catch (err) {
        throw describeLockError(err, this.nameOf(f))
      }
    })
  }

  private async moveFound(
    f: Found,
    id: string,
    parentId: string | null,
    index: number,
  ): Promise<void> {
    if (f.kind === 'space') {
      moveWithin(this.model.spaces, id, this.modelIndex(this.model.spaces, id, index))
      await this.writeLibraryJson()
    } else if (f.kind === 'chapter') {
      const to = parentId ? this.getSpace(parentId).space : f.space
      if (to === f.space) {
        moveWithin(f.space.chapters, id, this.modelIndex(f.space.chapters, id, index))
        await this.writeSpaceJson(f.space)
        return
      }
      this.assertWritable(this.spaceMeta(f.space))
      this.assertWritable(this.spaceMeta(to))
      const name = uniqueName(f.chapter.name, await this.siblingsOnDisk(this.spaceDir(to)))
      await this.copyAssets(
        f.space,
        to,
        f.chapter.pages.map((pg) => this.scenePath(f.space, f.chapter, pg)),
      )
      await this.queue.drain()
      await renameWithRetry(this.chapterDir(f.space, f.chapter), join(this.spaceDir(to), name))
      f.chapter.name = name
      f.space.chapters = f.space.chapters.filter((c) => c.id !== id)
      const moved = new Set(f.chapter.pages.map((pg) => pg.id))
      f.space.pinned = f.space.pinned.filter((pid) => !moved.has(pid))
      to.chapters.splice(this.modelIndex(to.chapters, id, index), 0, f.chapter)
      await this.writeSpaceJson(f.space)
      await this.writeSpaceJson(to)
    } else {
      if (!parentId) throw new Error('A page must move into a chapter')
      const dest = this.getChapter(parentId)
      const { space, chapter, page } = f
      if (dest.chapter === chapter) {
        moveWithin(chapter.pages, id, this.modelIndex(chapter.pages, id, index))
        await this.writeChapterJson(space, chapter)
        return
      }
      this.assertWritable(this.chapterMeta(space, chapter))
      this.assertWritable(this.chapterMeta(dest.space, dest.chapter))
      if (dest.space !== space) {
        await this.copyAssets(space, dest.space, [this.scenePath(space, chapter, page)])
      }
      const name = uniqueName(
        page.name,
        await this.pageNamesIn(this.chapterDir(dest.space, dest.chapter)),
      )
      await this.movePageFiles(space, chapter, page, dest.space, dest.chapter, name)
      chapter.pages = chapter.pages.filter((pg) => pg.id !== id)
      dest.chapter.pages.splice(this.modelIndex(dest.chapter.pages, id, index), 0, page)
      await this.writeChapterJson(space, chapter)
      await this.writeChapterJson(dest.space, dest.chapter)
      // Pins are per space; unpin only once the files have actually moved. Best effort:
      // the page has moved, and a scan drops pins to pages a space no longer has.
      if (dest.space !== space && space.pinned.includes(id)) {
        space.pinned = space.pinned.filter((pid) => pid !== id)
        await this.writeSpaceJson(space).catch(() => undefined)
      }
    }
  }

  // ---------- duplicate / pin / colour ----------

  duplicate(id: string): Promise<string> {
    return this.mutate(async () => {
      const { space, chapter, page } = this.getPage(id)
      const scene = await readText(this.scenePath(space, chapter, page))
      const notes = (await readText(this.notesPath(space, chapter, page))) ?? ''
      return this.createPage(space, chapter, withSuffix(page.name, ' copy'), page.id, scene, notes)
    })
  }

  pin(id: string, pinned: boolean): Promise<void> {
    return this.mutate(async () => {
      const { space } = this.getPage(id)
      space.pinned = space.pinned.filter((p) => p !== id)
      if (pinned) space.pinned.push(id)
      await this.writeSpaceJson(space)
    })
  }

  setColor(id: string, color: Accent): Promise<void> {
    return this.mutate(async () => {
      const { space } = this.getSpace(id)
      space.color = color
      await this.writeSpaceJson(space)
    })
  }

  // ---------- delete with undo ----------

  /** Hides the item now; it goes to the trash after the undo window. */
  remove(id: string): Promise<void> {
    return this.mutate(async () => {
      this.get(id)
      this.removals.set(
        id,
        setTimeout(() => void this.commitRemoval(id).catch(() => undefined), UNDO_WINDOW_MS),
      )
    })
  }

  undoRemove(id: string): Promise<void> {
    return this.mutate(async () => {
      const timer = this.removals.get(id)
      if (timer) clearTimeout(timer)
      this.removals.delete(id)
    })
  }

  /** Trashes everything still waiting in its undo window (called before quitting). */
  async commitAllRemovals(): Promise<void> {
    for (const id of [...this.removals.keys()]) await this.commitRemoval(id)
  }

  private commitRemoval(id: string): Promise<void> {
    return this.mutate(async () => {
      const timer = this.removals.get(id)
      if (timer) clearTimeout(timer)
      if (!this.removals.delete(id)) return
      const f = find(this.model, id)
      if (!f) return
      await this.queue.drain()
      try {
        await this.trashFound(f, id)
      } catch (err) {
        this.notify(this.describeTrashFailure(f, err))
        // Files may have been trashed or renamed part-way: re-read the folders so the
        // sidebar shows exactly what is left (published by `mutate`).
        await this.reload().catch(() => undefined)
      }
    })
  }

  /** A notice that says what really happened to an item that couldn't be (fully) deleted. */
  private describeTrashFailure(f: Found, err: unknown): string {
    const name = this.nameOf(f)
    const reason = err instanceof TrashError ? err.reason : err
    const why = isLockError(reason)
      ? 'something in it is open in another program (an Explorer window, a sync tool or antivirus)'
      : reason instanceof Error
        ? reason.message
        : String(reason)
    const q = (path: string) => `“${basename(path)}”`
    if (!(err instanceof TrashError)) {
      return `Couldn’t delete “${name}”: ${why}. It’s back in the sidebar.`
    }
    if (err.trashed.length > 0) {
      const left = err.left.map((l) => q(l.now)).join(' and ')
      return `Deleted “${name}”, but couldn’t delete ${left}: ${why}. It’s still in its folder.`
    }
    const moved = err.left.filter((l) => l.now !== l.original)
    if (moved.length === 0) return `Couldn’t delete “${name}”: ${why}. It’s back in the sidebar.`
    const where = moved
      .map((l) =>
        basename(l.now).startsWith('.')
          ? `${q(l.original)} was left under the hidden name ${q(l.now)}; rename it to get it back`
          : `${q(l.original)} is now called ${q(l.now)}`,
      )
      .join('; ')
    return `Couldn’t delete “${name}”: ${why}. It’s still in its folder, but ${where}.`
  }

  private async trashFound(f: Found, id: string): Promise<void> {
    // Once the files are in the trash the deletion has happened: metadata updates are
    // best effort (the next scan reconciles them), so they can't turn it into a failure.
    const meta = (write: Promise<void>) => write.catch(() => undefined)
    if (f.kind === 'space') {
      await this.trash([this.spaceDir(f.space)])
      this.model.spaces = this.model.spaces.filter((s) => s.id !== id)
      await meta(this.writeLibraryJson())
      for (const c of f.space.chapters) for (const pg of c.pages) this.emit('pageRemoved', pg.id)
    } else if (f.kind === 'chapter') {
      await this.trash([this.chapterDir(f.space, f.chapter)])
      f.space.chapters = f.space.chapters.filter((c) => c.id !== id)
      const gone = new Set(f.chapter.pages.map((pg) => pg.id))
      f.space.pinned = f.space.pinned.filter((p) => !gone.has(p))
      await meta(this.writeSpaceJson(f.space))
      for (const pid of gone) this.emit('pageRemoved', pid)
    } else {
      const { space, chapter, page } = f
      const notes = this.notesPath(space, chapter, page)
      const paths = [this.scenePath(space, chapter, page)]
      if (await exists(notes)) paths.push(notes)
      await this.trash(paths)
      chapter.pages = chapter.pages.filter((pg) => pg.id !== id)
      if (space.pinned.includes(id)) {
        space.pinned = space.pinned.filter((p) => p !== id)
        await meta(this.writeSpaceJson(space))
      }
      await meta(this.writeChapterJson(space, chapter))
      this.emit('pageRemoved', id)
    }
  }

  /**
   * Moves items to the OS trash, or to a `.trash/` folder in the library when there
   * is none (some Linux setups). Every item is claimed first (see `claim`), and
   * nothing is trashed unless all of it can be moved: on Windows, handing a locked
   * folder to the Recycle Bin pops up an "administrator permission" dialog.
   *
   * On failure it throws a TrashError, after putting every item that wasn't trashed
   * back under its own name (or, if that fails, a visible "(could not delete)" name),
   * so nothing is left under a hidden name unless every rename fails.
   */
  private async trash(paths: string[]): Promise<void> {
    // Items whose rename back failed during the claim: original path → hidden path.
    const hidden = new Map<string, string>()
    const trashed: string[] = []
    const fail = async (reason: unknown): Promise<never> => {
      const left: Array<{ original: string; now: string }> = []
      for (const path of paths) {
        if (trashed.includes(path)) continue
        const at = hidden.get(path)
        left.push({ original: path, now: at ? await this.unhide(at, path) : path })
      }
      throw new TrashError(reason, trashed, left)
    }

    for (const path of paths) {
      try {
        const at = await this.claim(path)
        if (at !== path) hidden.set(path, at)
      } catch (err) {
        return fail(err)
      }
    }
    for (const path of paths) {
      try {
        await this.toTrash(hidden.get(path) ?? path, basename(path))
      } catch (err) {
        return fail(err)
      }
      hidden.delete(path)
      trashed.push(path)
    }
  }

  /** One item to the OS trash, falling back to the library's `.trash/` folder. */
  private async toTrash(path: string, name: string): Promise<void> {
    try {
      const trashing = this.deps.trash(path)
      trashing.catch(() => undefined) // it may still settle after we gave up on it
      let timer: NodeJS.Timeout | undefined
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('the system trash didn’t respond')),
          this.deps.trashTimeoutMs ?? TRASH_TIMEOUT_MS,
        )
      })
      try {
        await Promise.race([trashing, timeout])
      } finally {
        clearTimeout(timer)
      }
    } catch (err) {
      try {
        const dir = this.p(TRASH_DIR)
        await mkdir(dir, { recursive: true })
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        await renameWithRetry(path, join(dir, `${stamp} ${name}`))
      } catch {
        // The OS trash may have taken it after all and still reported an error.
        if (!(await exists(path))) return
        throw err
      }
    }
  }

  /**
   * Proves nothing holds `path` open by renaming it to a hidden sibling and back
   * (retrying briefly for antivirus and indexers); throws if it's locked, in which
   * case nothing moved. Returns the path to trash: normally the original, or the
   * hidden name if renaming back failed. `trash` tracks that hidden name and puts
   * the item back if the deletion doesn't go ahead.
   */
  private async claim(path: string): Promise<string> {
    const hidden = join(dirname(path), `.${basename(path)}.zb-${randomUUID().slice(0, 8)}`)
    await renameWithRetry(path, hidden)
    try {
      await renameWithRetry(hidden, path)
      return path
    } catch {
      return hidden
    }
  }

  /**
   * Puts a claimed item back: under its own name if possible, otherwise under a
   * visible "<name> (could not delete)" name in the same folder. Returns where it
   * ended up (the hidden path only if every rename failed).
   */
  private async unhide(at: string, original: string): Promise<string> {
    try {
      await renameWithRetry(at, original)
      return original
    } catch {
      // Something now holds the original name, or the item is locked: try another name.
    }
    const dir = dirname(original)
    const base = basename(original)
    const ext = /\.(excalidraw|md)$/i.exec(base)?.[0] ?? ''
    const label = withSuffix(ext ? base.slice(0, -ext.length) : base, COULD_NOT_DELETE)
    const taken = new Set((await this.siblingsOnDisk(dir)).map((n) => n.toLowerCase()))
    for (let n = 1; n <= 20; n++) {
      const candidate = `${n === 1 ? label : `${label} ${n}`}${ext}`
      if (taken.has(candidate.toLowerCase())) continue
      try {
        await renameWithRetry(at, join(dir, candidate))
        return join(dir, candidate)
      } catch {
        break
      }
    }
    return at
  }

  // ---------- page content ----------

  /**
   * Reads a page. Throws if the scene file (or an existing notes file) can't be
   * read: the renderer must never mistake an unreadable page or note for an empty
   * one and then autosave over it.
   */
  readPage(id: string): Promise<PageData> {
    return this.exclusive(async () => {
      const { space, chapter, page } = this.getPage(id)
      const scenePath = this.scenePath(space, chapter, page)
      const notesPath = this.notesPath(space, chapter, page)
      const [scene, notes, sf, nf] = await Promise.all([
        readFileWithRetry(scenePath),
        readTextStrict(notesPath),
        fingerprint(scenePath),
        fingerprint(notesPath),
      ])
      const modified = Math.max(sf?.mtimeMs ?? 0, nf?.mtimeMs ?? 0)
      return { scene: scene.trim() ? scene : null, notes: notes ?? '', modified }
    })
  }

  // Saves run in the same queue as renames and moves, so they always hit the current path.
  saveScene(id: string, scene: string): Promise<void> {
    return this.exclusive(async () => {
      const { space, chapter, page } = this.getPage(id)
      await this.queue.write(this.scenePath(space, chapter, page), scene)
      this.emit('pageSaved', id)
    })
  }

  /** Writes the note, or removes the file when the note is emptied (no empty files). */
  saveNotes(id: string, markdown: string): Promise<void> {
    return this.exclusive(async () => {
      const { space, chapter, page } = this.getPage(id)
      const path = this.notesPath(space, chapter, page)
      if (markdown.trim()) {
        await this.queue.write(path, markdown)
      } else if (await exists(path)) {
        await this.queue.remove(path)
      }
      this.emit('pageSaved', id)
    })
  }

  saveConflictCopy(id: string, scene: string | null, notes: string): Promise<string> {
    return this.mutate(async () => {
      const { space, chapter, page } = this.getPage(id)
      return this.createPage(
        space,
        chapter,
        withSuffix(page.name, ` (conflict ${conflictStamp()})`),
        page.id,
        scene,
        notes,
      )
    })
  }

  /** Copies .excalidraw files into a chapter as new pages. */
  importFiles(chapterId: string, paths: string[]): Promise<number> {
    return this.mutate(async () => {
      const { space, chapter } = this.getChapter(chapterId)
      let count = 0
      for (const path of paths) {
        if (!path.toLowerCase().endsWith(SCENE_EXT)) continue
        const info = await stat(path).catch(() => null)
        if (!info?.isFile() || info.size > MAX_SCENE_BYTES) continue
        const text = await readFile(path, 'utf8').catch(() => null)
        if (!text) continue
        try {
          if ((JSON.parse(text) as { type?: unknown }).type !== 'excalidraw') continue
        } catch {
          continue
        }
        await this.createPage(
          space,
          chapter,
          basename(path).slice(0, -SCENE_EXT.length),
          undefined,
          text,
        )
        count++
      }
      return count
    })
  }

  /** Path of any item, for "Reveal in Explorer/Finder". */
  pathOf(id: string): string {
    const f = this.get(id)
    if (f.kind === 'space') return this.spaceDir(f.space)
    if (f.kind === 'chapter') return this.chapterDir(f.space, f.chapter)
    return this.scenePath(f.space, f.chapter, f.page)
  }

  /** Maps a changed file back to its page (used by the watcher). */
  pageIdForPath(path: string): string | null {
    if (!this.pathIndex) {
      // Rebuilt once per model change, so a burst of watcher events costs O(1) each.
      const index = new Map<string, string>()
      for (const s of this.model.spaces) {
        for (const c of s.chapters) {
          for (const pg of c.pages) {
            const base = join(this.root, s.name, c.name, pg.name)
            index.set(pathKey(base + SCENE_EXT), pg.id)
            index.set(pathKey(base + NOTES_EXT), pg.id)
          }
        }
      }
      this.pathIndex = index
    }
    return this.pathIndex.get(pathKey(path)) ?? null
  }

  // ---------- assets ----------

  private async assetIndex(space: SpaceRec): Promise<Map<string, string>> {
    const files = await this.siblingsOnDisk(this.assetsDir(space))
    return new Map(files.map((f) => [f.replace(/\.[^.]+$/, ''), f]))
  }

  putAssets(pageId: string, files: AssetFile[]): Promise<void> {
    return this.exclusive(() => this.writeAssets(pageId, files))
  }

  private async writeAssets(pageId: string, files: AssetFile[]): Promise<void> {
    const { space } = this.getPage(pageId)
    const dir = this.assetsDir(space)
    await mkdir(dir, { recursive: true })
    const have = await this.assetIndex(space)
    for (const file of files) {
      if (have.has(file.id)) continue // content-addressed: same ID, same bytes
      const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(file.dataURL)
      if (!match) continue
      const ext = MIME_EXT[file.mimeType] ?? MIME_EXT[match[1] ?? ''] ?? 'bin'
      const data = match[2]
        ? Buffer.from(match[3] ?? '', 'base64')
        : Buffer.from(decodeURIComponent(match[3] ?? ''))
      await this.queue.write(join(dir, `${file.id}.${ext}`), data)
      have.set(file.id, `${file.id}.${ext}`)
    }
  }

  getAssets(pageId: string, ids: string[]): Promise<AssetFile[]> {
    return this.exclusive(() => this.readAssets(pageId, ids))
  }

  private async readAssets(pageId: string, ids: string[]): Promise<AssetFile[]> {
    const { space } = this.getPage(pageId)
    const index = await this.assetIndex(space)
    const out: AssetFile[] = []
    for (const id of ids) {
      const file = index.get(id)
      if (!file) continue
      const ext = file.split('.').pop()?.toLowerCase() ?? ''
      const mimeType = EXT_MIME[ext] ?? 'application/octet-stream'
      const data = await readFile(join(this.assetsDir(space), file)).catch(() => null)
      if (data)
        out.push({ id, mimeType, dataURL: `data:${mimeType};base64,${data.toString('base64')}` })
    }
    return out
  }

  /** Copies the images some pages use into another space (moving across spaces). */
  private async copyAssets(from: SpaceRec, to: SpaceRec, scenePaths: string[]): Promise<void> {
    const ids = new Set<string>()
    // Strict: if a scene can't be read, the move fails rather than leaving its images behind.
    for (const path of scenePaths) {
      for (const id of sceneFileIds(await readTextStrict(path))) ids.add(id)
    }
    if (ids.size === 0) return
    const source = await this.assetIndex(from)
    const target = await this.assetIndex(to)
    await mkdir(this.assetsDir(to), { recursive: true })
    for (const id of ids) {
      const file = source.get(id)
      if (file && !target.has(id))
        await copyFile(join(this.assetsDir(from), file), join(this.assetsDir(to), file))
    }
  }

  // ---------- shape library ----------

  loadShapes(): Promise<string | null> {
    return readText(join(this.root, SHAPES_FILE))
  }

  saveShapes(text: string): Promise<void> {
    return this.queue.write(join(this.root, SHAPES_FILE), text)
  }

  /** Waits for every queued write (used before quitting). */
  async close(): Promise<void> {
    await this.commitAllRemovals()
    await this.lock
    await this.queue.drain()
  }
}
