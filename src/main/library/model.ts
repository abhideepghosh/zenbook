import { createHash } from 'node:crypto'
import { ACCENTS, type Accent } from '../../shared/api'

// In-memory model of the library. Names are folder/file names (the single
// source of truth for display names); IDs and order live in the JSON files.

export const FORMAT = 1
export const SCENE_EXT = '.excalidraw'
export const NOTES_EXT = '.md'
export const ASSETS_DIR = '.assets'
export const TRASH_DIR = '.trash'
export const LIBRARY_FILE = 'zenbook.json'
export const SPACE_FILE = 'space.json'
export const CHAPTER_FILE = 'chapter.json'
export const SHAPES_FILE = 'library.excalidrawlib'
export const SOURCE = 'https://github.com/abhideepghosh/zenbook'

export interface PageRec {
  id: string
  name: string
}

export interface ChapterRec {
  id: string
  name: string
  pages: PageRec[]
}

export interface SpaceRec {
  id: string
  name: string
  color: Accent
  chapters: ChapterRec[]
  pinned: string[]
}

export interface Model {
  spaces: SpaceRec[]
}

export type Found =
  | { kind: 'space'; space: SpaceRec }
  | { kind: 'chapter'; space: SpaceRec; chapter: ChapterRec }
  | { kind: 'page'; space: SpaceRec; chapter: ChapterRec; page: PageRec }

export function find(model: Model, id: string): Found | null {
  for (const space of model.spaces) {
    if (space.id === id) return { kind: 'space', space }
    for (const chapter of space.chapters) {
      if (chapter.id === id) return { kind: 'chapter', space, chapter }
      for (const page of chapter.pages) {
        if (page.id === id) return { kind: 'page', space, chapter, page }
      }
    }
  }
  return null
}

export function isAccent(v: unknown): v is Accent {
  return typeof v === 'string' && (ACCENTS as readonly string[]).includes(v)
}

/** A stable accent for spaces that don't have one yet. */
export function accentFor(id: string): Accent {
  const n = createHash('sha1').update(id).digest()[0] ?? 0
  return ACCENTS[n % ACCENTS.length] as Accent
}

const ID = /^[A-Za-z0-9_-]{8,64}$/
export const isId = (v: unknown): v is string => typeof v === 'string' && ID.test(v)

/** An empty page in the standard .excalidraw format, plus Zenbook's own metadata. */
export function emptyScene(id: string): string {
  return JSON.stringify({
    type: 'excalidraw',
    version: 2,
    source: SOURCE,
    elements: [],
    appState: { viewBackgroundColor: '#ffffff', gridSize: 20 },
    files: {},
    zenbook: { id, paper: 'plain' },
  })
}

/** Rewrites the embedded page ID (used by duplicate, import and conflict copies). */
export function withSceneId(json: string | null, id: string): string {
  if (!json) return emptyScene(id)
  try {
    const data = JSON.parse(json) as Record<string, unknown>
    const meta = typeof data.zenbook === 'object' && data.zenbook !== null ? data.zenbook : {}
    return JSON.stringify({ ...data, zenbook: { ...meta, id } })
  } catch {
    return emptyScene(id)
  }
}

/** Reads `zenbook.id` from a scene without trusting anything else in it. */
export function sceneId(json: string | null): string | null {
  if (!json) return null
  try {
    const data = JSON.parse(json) as { zenbook?: { id?: unknown } }
    return isId(data.zenbook?.id) ? data.zenbook.id : null
  } catch {
    return null
  }
}

/** File IDs referenced by image elements in a scene. */
export function sceneFileIds(json: string | null): string[] {
  if (!json) return []
  try {
    const data = JSON.parse(json) as {
      elements?: Array<{ type?: string; fileId?: unknown; isDeleted?: boolean }>
    }
    const ids = new Set<string>()
    for (const el of data.elements ?? []) {
      if (el.type === 'image' && !el.isDeleted && typeof el.fileId === 'string') ids.add(el.fileId)
    }
    return [...ids]
  } catch {
    return []
  }
}
