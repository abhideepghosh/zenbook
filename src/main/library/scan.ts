import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import type { WriteQueue } from './fsx'
import { exists, isLockError, isMissingError, readJsonFile, readText, renameWithRetry } from './fsx'
import {
  accentFor,
  CHAPTER_FILE,
  FORMAT,
  isAccent,
  isId,
  LIBRARY_FILE,
  sceneId,
  SCENE_EXT,
  SPACE_FILE,
  type ChapterRec,
  type Model,
  type PageRec,
  type SpaceRec,
} from './model'

export class FormatError extends Error {}
/** zenbook.json or the library folder itself can't be read: nothing is scanned or written. */
export class UnreadableLibraryError extends Error {}

export interface ScanProblem {
  /** Absolute path. */
  path: string
  /** Library-relative path with forward slashes, for messages ("Work/space.json"). */
  rel: string
  /** A folder that couldn't be listed (otherwise a metadata file that couldn't be read). */
  folder?: boolean
}

export interface ScanResult {
  model: Model
  /** Metadata files or folders that exist but couldn't be read. They were not rewritten. */
  unreadable: ScanProblem[]
  /** Reconciled metadata that couldn't be written back (best effort; tried again next scan). */
  writeFailures: Array<ScanProblem & { error: unknown }>
  /** One-off messages for the user (e.g. a damaged zenbook.json was rebuilt). */
  notices: string[]
}

interface Ctx {
  root: string
  queue: WriteQueue
  previous: Model
  used: Set<string>
  unreadable: ScanProblem[]
  writeFailures: Array<ScanProblem & { error: unknown }>
}

const obj = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter(isId) : [])
const relOf = (ctx: Ctx, path: string) => relative(ctx.root, path).split(sep).join('/')

/** Directory entries, [] if the folder is missing, or null if it exists but can't be read. */
async function entriesOf(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch (err) {
    return isMissingError(err) ? [] : null
  }
}

async function listDirs(dir: string): Promise<string[] | null> {
  const entries = await entriesOf(dir)
  return (
    entries?.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name) ?? null
  )
}

async function listScenes(dir: string): Promise<string[] | null> {
  const entries = await entriesOf(dir)
  if (!entries) return null
  return entries
    .filter(
      (e) => e.isFile() && e.name.toLowerCase().endsWith(SCENE_EXT) && !e.name.startsWith('.'),
    )
    .map((e) => e.name.slice(0, -SCENE_EXT.length))
}

/** Sorts items by a saved ID order; anything unknown keeps its place at the end. */
function ordered<T extends { id: string }>(items: T[], order: string[]): T[] {
  const rank = new Map(order.map((id, i) => [id, i]))
  return [...items].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity))
}

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`

/**
 * Writes a metadata file only if its content actually changed. Best effort: a
 * failure (a lock, a full disk) is recorded and the scan carries on, since the
 * model is right either way and the next scan tries again.
 */
async function writeIfChanged(ctx: Ctx, path: string, before: unknown, after: unknown) {
  if (JSON.stringify(before) === JSON.stringify(after)) return
  try {
    await ctx.queue.write(path, json(after))
  } catch (error) {
    ctx.writeFailures.push({ path, rel: relOf(ctx, path), error })
  }
}

/** IDs are unique across the library; a copied file with a duplicate ID gets a new one. */
function claim(used: Set<string>, id: string | null): string {
  const final = id && !used.has(id) ? id : randomUUID()
  used.add(final)
  return final
}

const byName = <T extends { name: string }>(items: readonly T[] | undefined, name: string) =>
  items?.find((x) => x.name === name)

interface Scanned<T> {
  rec: T
  /** Something in here couldn't be read, so the parent's metadata isn't rewritten either. */
  degraded: boolean
}

async function scanChapter(
  ctx: Ctx,
  spaceDir: string,
  name: string,
  prev: ChapterRec | undefined,
): Promise<Scanned<ChapterRec>> {
  const dir = join(spaceDir, name)
  const metaPath = join(dir, CHAPTER_FILE)
  const [meta, listing] = await Promise.all([readJsonFile(metaPath), listScenes(dir)])

  if (listing === null) {
    // Can't list the folder: keep what we knew about it, and touch nothing.
    ctx.unreadable.push({ path: dir, rel: relOf(ctx, dir), folder: true })
    const pages = (prev?.pages ?? []).map((p) => ({ id: claim(ctx.used, p.id), name: p.name }))
    return { rec: { id: claim(ctx.used, prev?.id ?? null), name, pages }, degraded: true }
  }

  let raw: Record<string, unknown> = {}
  let degraded = false
  if (meta.status === 'ok') raw = meta.value
  else if (meta.status === 'unreadable') {
    ctx.unreadable.push({ path: metaPath, rel: relOf(ctx, metaPath) })
    degraded = true
    // Fall back to what the last scan knew, so IDs and order survive.
    if (prev) raw = { id: prev.id, pages: prev.pages.map((p) => ({ id: p.id, file: p.name })) }
  }

  const files = new Set(listing)
  const pages: PageRec[] = []
  const listed = Array.isArray(raw.pages) ? raw.pages : []
  for (const entry of listed) {
    const { id, file } = obj(entry)
    if (typeof file !== 'string' || !files.has(file)) continue // file is gone
    files.delete(file)
    pages.push({ id: claim(ctx.used, isId(id) ? id : null), name: file })
  }
  // Files that appeared on disk (copied in, synced, restored from the trash) go at the end.
  // Reuse the ID embedded in the file so links and history survive.
  for (const file of [...files].sort((a, b) => a.localeCompare(b))) {
    const embedded = sceneId(await readText(join(dir, file + SCENE_EXT)))
    pages.push({ id: claim(ctx.used, embedded), name: file })
  }

  const id = claim(ctx.used, isId(raw.id) ? raw.id : null)
  if (!degraded) {
    const after = { id, pages: pages.map((p) => ({ id: p.id, file: p.name })) }
    await writeIfChanged(ctx, metaPath, raw, after)
  }
  return { rec: { id, name, pages }, degraded }
}

async function scanSpace(
  ctx: Ctx,
  name: string,
  prev: SpaceRec | undefined,
): Promise<Scanned<SpaceRec>> {
  const dir = join(ctx.root, name)
  const metaPath = join(dir, SPACE_FILE)
  const [meta, chapterDirs] = await Promise.all([readJsonFile(metaPath), listDirs(dir)])

  let raw: Record<string, unknown> = {}
  let degraded = false
  if (meta.status === 'ok') raw = meta.value
  else if (meta.status === 'unreadable') {
    ctx.unreadable.push({ path: metaPath, rel: relOf(ctx, metaPath) })
    degraded = true
    if (prev) {
      raw = {
        id: prev.id,
        color: prev.color,
        chapters: prev.chapters.map((c) => c.id),
        pinned: prev.pinned,
      }
    }
  }
  const id = claim(ctx.used, isId(raw.id) ? raw.id : null)
  const color = isAccent(raw.color) ? raw.color : accentFor(id)

  let chapters: ChapterRec[]
  if (chapterDirs === null) {
    ctx.unreadable.push({ path: dir, rel: relOf(ctx, dir), folder: true })
    degraded = true
    chapters = (prev?.chapters ?? []).map((c) => ({
      id: claim(ctx.used, c.id),
      name: c.name,
      pages: c.pages.map((p) => ({ id: claim(ctx.used, p.id), name: p.name })),
    }))
  } else {
    const scanned = await Promise.all(
      chapterDirs.map((c) => scanChapter(ctx, dir, c, byName(prev?.chapters, c))),
    )
    if (scanned.some((s) => s.degraded)) degraded = true
    chapters = ordered(
      scanned.map((s) => s.rec),
      ids(raw.chapters),
    )
  }

  const pageIds = new Set(chapters.flatMap((c) => c.pages.map((p) => p.id)))
  const pinned = ids(raw.pinned).filter((p) => pageIds.has(p))
  if (!degraded) {
    const after = { id, color, chapters: chapters.map((c) => c.id), pinned }
    await writeIfChanged(ctx, metaPath, raw, after)
  }
  return { rec: { id, name, color, chapters, pinned }, degraded }
}

/**
 * Reads the whole library structure: zenbook.json, space.json and chapter.json
 * files plus directory listings. Page files are never opened, except for unknown
 * ones whose embedded ID we try to recover. Reconciled metadata is written back
 * only when it changed, and never over a file that couldn't be read: for those,
 * the record from `previous` (the last scan) is kept so IDs, colours and pins survive.
 */
export async function scan(root: string, queue: WriteQueue, previous?: Model): Promise<ScanResult> {
  const libraryFile = join(root, LIBRARY_FILE)
  const notices: string[] = []
  const meta = await readJsonFile(libraryFile)
  if (meta.status === 'unreadable' && !meta.corrupt) {
    // Can't read it at all (still locked after the retries, or no permission): can't
    // tell which format it is, so don't risk treating a newer library as ours.
    throw new UnreadableLibraryError(describeUnreadable(meta.error))
  }
  if (meta.status === 'unreadable') {
    // Damaged (invalid, empty, not an object), even after a second look. It only holds
    // the format and the Space order, so keep it aside and rebuild it.
    notices.push(await setAside(libraryFile))
  }
  const raw = meta.status === 'ok' ? meta.value : {}
  const format = typeof raw.format === 'number' ? raw.format : FORMAT
  if (format > FORMAT) {
    throw new FormatError(
      'This library was created by a newer version of Zenbook. Please update the app.',
    )
  }
  const spaceDirs = await listDirs(root)
  if (spaceDirs === null) {
    throw new UnreadableLibraryError('Couldn’t read the library folder. Check that it’s available.')
  }
  const ctx: Ctx = {
    root,
    queue,
    previous: previous ?? { spaces: [] },
    used: new Set<string>(),
    unreadable: [],
    writeFailures: [],
  }
  // Spaces are scanned one after another so ID claims are deterministic.
  const scanned: Array<Scanned<SpaceRec>> = []
  for (const name of spaceDirs) {
    scanned.push(await scanSpace(ctx, name, byName(ctx.previous.spaces, name)))
  }
  const sorted = ordered(
    scanned.map((s) => s.rec),
    ids(raw.spaces),
  )
  // A rebuilt (damaged) zenbook.json is written regardless: its Space order is gone anyway.
  if (!scanned.some((s) => s.degraded) || meta.status === 'unreadable') {
    await writeIfChanged(ctx, libraryFile, raw, {
      format: FORMAT,
      spaces: sorted.map((s) => s.id),
    })
  }
  return {
    model: { spaces: sorted },
    unreadable: ctx.unreadable,
    writeFailures: ctx.writeFailures,
    notices,
  }
}

/** The message for a zenbook.json that can't be read at all, by cause. */
function describeUnreadable(error: unknown): string {
  if (isLockError(error)) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'EBUSY'
      ? `“${LIBRARY_FILE}” is in use by another program (a sync tool or antivirus), so the library wasn’t opened. Close that program and try again.`
      : `Zenbook isn’t allowed to read “${LIBRARY_FILE}”, so the library wasn’t opened. Check the folder’s permissions, or close any program that is using it, and try again.`
  }
  const why = error instanceof Error ? error.message : String(error)
  return `Couldn’t read “${LIBRARY_FILE}” (${why}), so the library wasn’t opened.`
}

/** "20261115-143005" */
function fileStamp(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
}

/**
 * Moves a damaged zenbook.json aside (never deletes it) so a fresh one can be written.
 * Throws if it can't be moved: then nothing is rewritten.
 */
async function setAside(path: string): Promise<string> {
  const base = `${LIBRARY_FILE}.corrupt-${fileStamp()}`
  for (let n = 1; n <= 20; n++) {
    const name = n === 1 ? base : `${base}-${n}`
    const target = join(dirname(path), name)
    if (await exists(target)) continue
    try {
      await renameWithRetry(path, target)
    } catch (err) {
      throw new UnreadableLibraryError(
        `“${LIBRARY_FILE}” is damaged and couldn’t be moved aside to rebuild it (${err instanceof Error ? err.message : String(err)}), so the library wasn’t opened.`,
        { cause: err },
      )
    }
    return `“${LIBRARY_FILE}” was damaged, so Zenbook rebuilt it. The old file was kept as “${name}”.`
  }
  throw new UnreadableLibraryError(
    `“${LIBRARY_FILE}” is damaged and couldn’t be moved aside to rebuild it, so the library wasn’t opened.`,
  )
}
