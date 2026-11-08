import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { WriteQueue } from './fsx'
import { readJson, readText } from './fsx'
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

const obj = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter(isId) : [])

async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name)
  } catch {
    return []
  }
}

async function listScenes(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter(
        (e) => e.isFile() && e.name.toLowerCase().endsWith(SCENE_EXT) && !e.name.startsWith('.'),
      )
      .map((e) => e.name.slice(0, -SCENE_EXT.length))
  } catch {
    return []
  }
}

/** Sorts items by a saved ID order; anything unknown keeps its place at the end. */
function ordered<T extends { id: string }>(items: T[], order: string[]): T[] {
  const rank = new Map(order.map((id, i) => [id, i]))
  return [...items].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity))
}

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`

/** Writes a metadata file only if its content actually changed. */
async function writeIfChanged(queue: WriteQueue, path: string, before: unknown, after: unknown) {
  if (JSON.stringify(before) !== JSON.stringify(after)) await queue.write(path, json(after))
}

/** IDs are unique across the library; a copied file with a duplicate ID gets a new one. */
function claim(used: Set<string>, id: string | null): string {
  const final = id && !used.has(id) ? id : randomUUID()
  used.add(final)
  return final
}

async function scanChapter(
  queue: WriteQueue,
  spaceDir: string,
  name: string,
  used: Set<string>,
): Promise<ChapterRec> {
  const dir = join(spaceDir, name)
  const raw = obj(await readJson(join(dir, CHAPTER_FILE)))
  const files = new Set(await listScenes(dir))

  const pages: PageRec[] = []
  const listed = Array.isArray(raw.pages) ? raw.pages : []
  for (const entry of listed) {
    const { id, file } = obj(entry)
    if (typeof file !== 'string' || !files.has(file)) continue // file is gone
    files.delete(file)
    pages.push({ id: claim(used, isId(id) ? id : null), name: file })
  }
  // Files that appeared on disk (copied in, synced, restored from the trash) go at the end.
  // Reuse the ID embedded in the file so links and history survive.
  for (const file of [...files].sort((a, b) => a.localeCompare(b))) {
    const embedded = sceneId(await readText(join(dir, file + SCENE_EXT)))
    pages.push({ id: claim(used, embedded), name: file })
  }

  const id = claim(used, isId(raw.id) ? raw.id : null)
  const after = { id, pages: pages.map((p) => ({ id: p.id, file: p.name })) }
  await writeIfChanged(queue, join(dir, CHAPTER_FILE), raw, after)
  return { id, name, pages }
}

async function scanSpace(
  queue: WriteQueue,
  root: string,
  name: string,
  used: Set<string>,
): Promise<SpaceRec> {
  const dir = join(root, name)
  const raw = obj(await readJson(join(dir, SPACE_FILE)))
  const id = claim(used, isId(raw.id) ? raw.id : null)
  const chapterDirs = await listDirs(dir)
  const chapters = ordered(
    await Promise.all(chapterDirs.map((c) => scanChapter(queue, dir, c, used))),
    ids(raw.chapters),
  )
  const pageIds = new Set(chapters.flatMap((c) => c.pages.map((p) => p.id)))
  const pinned = ids(raw.pinned).filter((p) => pageIds.has(p))
  const color = isAccent(raw.color) ? raw.color : accentFor(id)

  const after = { id, color, chapters: chapters.map((c) => c.id), pinned }
  await writeIfChanged(queue, join(dir, SPACE_FILE), raw, after)
  return { id, name, color, chapters, pinned }
}

/**
 * Reads the whole library structure: zenbook.json, space.json and chapter.json
 * files plus directory listings, all in parallel. Page files are never opened,
 * except for unknown ones whose embedded ID we try to recover. Reconciled
 * metadata is written back only when it changed.
 */
export async function scan(root: string, queue: WriteQueue): Promise<Model> {
  const raw = obj(await readJson(join(root, LIBRARY_FILE)))
  const format = typeof raw.format === 'number' ? raw.format : FORMAT
  if (format > FORMAT) {
    throw new FormatError(
      'This library was created by a newer version of Zenbook. Please update the app.',
    )
  }
  const used = new Set<string>()
  const spaceDirs = await listDirs(root)
  // Spaces are scanned one after another so ID claims are deterministic.
  const spaces: SpaceRec[] = []
  for (const name of spaceDirs) spaces.push(await scanSpace(queue, root, name, used))
  const sorted = ordered(spaces, ids(raw.spaces))
  await writeIfChanged(queue, join(root, LIBRARY_FILE), raw, {
    format: FORMAT,
    spaces: sorted.map((s) => s.id),
  })
  return { spaces: sorted }
}
