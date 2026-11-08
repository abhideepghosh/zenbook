import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { copyFile, mkdir, readdir, readFile, rename, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { Accent, AssetFile, NodeKind, PageData, Tree } from '../../shared/api'
import { exists, fingerprint, readText, renameWithRetry, WriteQueue } from './fsx'
import {
  ASSETS_DIR,
  CHAPTER_FILE,
  emptyScene,
  find,
  FORMAT,
  LIBRARY_FILE,
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
import { assertInsideRoot, conflictStamp, isConflictName, sanitizeName, uniqueName } from './paths'
import { scan } from './scan'

export interface LibraryDeps {
  /** Moves a file or folder to the OS trash. Injected so tests can fake it. */
  trash(path: string): Promise<void>
}

export interface LibraryEvents {
  tree: [Tree]
  pageChanged: [string]
  /** A page's scene or notes were saved or removed; `text` is the drawing text if known. */
  pageSaved: [id: string]
  pageRemoved: [id: string]
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

function moveWithin<T extends { id: string }>(list: T[], id: string, index: number): void {
  const from = list.findIndex((x) => x.id === id)
  if (from < 0) return
  const [item] = list.splice(from, 1)
  if (item) list.splice(clampIndex(index, list.length), 0, item)
}

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

  private constructor(
    readonly root: string,
    private readonly deps: LibraryDeps,
  ) {
    super()
  }

  /** Opens an existing library folder, or initialises an empty one. */
  static async open(root: string, deps: LibraryDeps): Promise<Library> {
    const lib = new Library(root, deps)
    await mkdir(root, { recursive: true })
    if (!(await exists(join(root, LIBRARY_FILE)))) {
      await lib.queue.write(join(root, LIBRARY_FILE), json({ format: FORMAT, spaces: [] }))
    }
    await lib.rescan()
    return lib
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

  private writeLibraryJson() {
    return this.queue.write(
      join(this.root, LIBRARY_FILE),
      json({ format: FORMAT, spaces: this.model.spaces.map((s) => s.id) }),
    )
  }
  private writeSpaceJson(s: SpaceRec) {
    return this.queue.write(
      join(this.spaceDir(s), SPACE_FILE),
      json({ id: s.id, color: s.color, chapters: s.chapters.map((c) => c.id), pinned: s.pinned }),
    )
  }
  private writeChapterJson(s: SpaceRec, c: ChapterRec) {
    return this.queue.write(
      join(this.chapterDir(s, c), CHAPTER_FILE),
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

  /** Re-reads the folders (after external changes) and publishes the tree if it changed. */
  rescan(): Promise<void> {
    return this.exclusive(async () => {
      this.model = await scan(this.root, this.queue)
      this.publish()
    })
  }

  private async mutate<T>(fn: () => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      const result = await fn()
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
      const name = sanitizeName(rawName)
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
        await this.movePageFiles(space, chapter, page, space, chapter, target)
        await this.writeChapterJson(space, chapter)
      }
    })
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
      await renameWithRetry(oldNotes, newNotes)
      await this.queue.remember(newNotes)
    }
    page.name = newName
  }

  // ---------- move / reorder ----------

  move(id: string, parentId: string | null, index: number): Promise<void> {
    return this.mutate(async () => {
      const f = this.get(id)
      if (f.kind === 'space') {
        moveWithin(this.model.spaces, id, index)
        await this.writeLibraryJson()
      } else if (f.kind === 'chapter') {
        const to = parentId ? this.getSpace(parentId).space : f.space
        if (to === f.space) {
          moveWithin(f.space.chapters, id, index)
          await this.writeSpaceJson(f.space)
          return
        }
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
        to.chapters.splice(clampIndex(index, to.chapters.length), 0, f.chapter)
        await this.writeSpaceJson(f.space)
        await this.writeSpaceJson(to)
      } else {
        if (!parentId) throw new Error('A page must move into a chapter')
        const dest = this.getChapter(parentId)
        const { space, chapter, page } = f
        if (dest.chapter === chapter) {
          moveWithin(chapter.pages, id, index)
          await this.writeChapterJson(space, chapter)
          return
        }
        if (dest.space !== space) {
          await this.copyAssets(space, dest.space, [this.scenePath(space, chapter, page)])
          space.pinned = space.pinned.filter((pid) => pid !== id)
          await this.writeSpaceJson(space)
        }
        const name = uniqueName(
          page.name,
          await this.pageNamesIn(this.chapterDir(dest.space, dest.chapter)),
        )
        await this.movePageFiles(space, chapter, page, dest.space, dest.chapter, name)
        chapter.pages = chapter.pages.filter((pg) => pg.id !== id)
        dest.chapter.pages.splice(clampIndex(index, dest.chapter.pages.length), 0, page)
        await this.writeChapterJson(space, chapter)
        await this.writeChapterJson(dest.space, dest.chapter)
      }
    })
  }

  // ---------- duplicate / pin / colour ----------

  duplicate(id: string): Promise<string> {
    return this.mutate(async () => {
      const { space, chapter, page } = this.getPage(id)
      const scene = await readText(this.scenePath(space, chapter, page))
      const notes = (await readText(this.notesPath(space, chapter, page))) ?? ''
      return this.createPage(space, chapter, `${page.name} copy`, page.id, scene, notes)
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
        setTimeout(() => void this.commitRemoval(id), UNDO_WINDOW_MS),
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
      if (f.kind === 'space') {
        await this.trash(this.spaceDir(f.space))
        this.model.spaces = this.model.spaces.filter((s) => s.id !== id)
        await this.writeLibraryJson()
        for (const c of f.space.chapters) for (const pg of c.pages) this.emit('pageRemoved', pg.id)
      } else if (f.kind === 'chapter') {
        await this.trash(this.chapterDir(f.space, f.chapter))
        f.space.chapters = f.space.chapters.filter((c) => c.id !== id)
        const gone = new Set(f.chapter.pages.map((pg) => pg.id))
        f.space.pinned = f.space.pinned.filter((p) => !gone.has(p))
        await this.writeSpaceJson(f.space)
        for (const pid of gone) this.emit('pageRemoved', pid)
      } else {
        const { space, chapter, page } = f
        const notes = this.notesPath(space, chapter, page)
        await this.trash(this.scenePath(space, chapter, page))
        if (await exists(notes)) await this.trash(notes)
        chapter.pages = chapter.pages.filter((pg) => pg.id !== id)
        if (space.pinned.includes(id)) {
          space.pinned = space.pinned.filter((p) => p !== id)
          await this.writeSpaceJson(space)
        }
        await this.writeChapterJson(space, chapter)
        this.emit('pageRemoved', id)
      }
    })
  }

  /** The OS trash, or a `.trash/` folder in the library when there is none (some Linux setups). */
  private async trash(path: string): Promise<void> {
    try {
      await this.deps.trash(path)
    } catch {
      const dir = this.p(TRASH_DIR)
      await mkdir(dir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      await rename(path, join(dir, `${stamp} ${basename(path)}`))
    }
  }

  // ---------- page content ----------

  /**
   * Reads a page. Throws if the scene file can't be read: the renderer must never
   * mistake an unreadable page for an empty one and then autosave over it.
   */
  readPage(id: string): Promise<PageData> {
    return this.exclusive(async () => {
      const { space, chapter, page } = this.getPage(id)
      const scenePath = this.scenePath(space, chapter, page)
      const notesPath = this.notesPath(space, chapter, page)
      const [scene, notes, sf, nf] = await Promise.all([
        readFile(scenePath, 'utf8'),
        readText(notesPath),
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
        `${page.name} (conflict ${conflictStamp()})`,
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
        if (!info?.isFile() || info.size > 100 * 1024 * 1024) continue
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
    const norm = (p: string) => (process.platform === 'linux' ? p : p.toLowerCase())
    const target = norm(path)
    for (const space of this.model.spaces) {
      for (const chapter of space.chapters) {
        for (const page of chapter.pages) {
          if (
            norm(this.scenePath(space, chapter, page)) === target ||
            norm(this.notesPath(space, chapter, page)) === target
          ) {
            return page.id
          }
        }
      }
    }
    return null
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
    for (const path of scenePaths) for (const id of sceneFileIds(await readText(path))) ids.add(id)
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
