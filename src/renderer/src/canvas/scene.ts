import { PAPERS, type Paper } from '../../../shared/api'

// Pure helpers for the .excalidraw file format and the paper pattern.

export const SOURCE = 'https://github.com/abhideepghosh/zenbook'

/** Parts of the file's appState we keep as read, so excalidraw.com shows the page the same way. */
const KEPT_APP_STATE = ['viewBackgroundColor', 'gridSize', 'gridStep'] as const
export type KeptAppState = Partial<Record<(typeof KEPT_APP_STATE)[number], unknown>>

export interface ParsedScene {
  elements: unknown[]
  appState: KeptAppState
  files: Record<string, { id: string; mimeType: string; dataURL: string; created?: number }>
  paper: Paper
}

export class SceneParseError extends Error {}

/** Parses a page file. Throws on anything that isn't an Excalidraw scene (never guesses). */
export function parseScene(json: string | null): ParsedScene {
  if (json === null)
    return { elements: [], appState: { viewBackgroundColor: '#ffffff' }, files: {}, paper: 'plain' }
  let data: Record<string, unknown>
  try {
    data = JSON.parse(json) as Record<string, unknown>
  } catch {
    throw new SceneParseError('This page file is not valid JSON.')
  }
  if (typeof data !== 'object' || data === null || !Array.isArray(data.elements)) {
    throw new SceneParseError('This page file is not an Excalidraw drawing.')
  }
  const rawState = (
    typeof data.appState === 'object' && data.appState !== null ? data.appState : {}
  ) as Record<string, unknown>
  const appState: KeptAppState = {}
  for (const key of KEPT_APP_STATE) if (key in rawState) appState[key] = rawState[key]
  const meta = (typeof data.zenbook === 'object' && data.zenbook !== null ? data.zenbook : {}) as {
    paper?: unknown
  }
  const paper = (PAPERS as readonly unknown[]).includes(meta.paper)
    ? (meta.paper as Paper)
    : 'plain'
  const files = (
    typeof data.files === 'object' && data.files !== null ? data.files : {}
  ) as ParsedScene['files']
  return { elements: data.elements, appState, files, paper }
}

/**
 * Builds the file we write: standard .excalidraw (opens on excalidraw.com) with
 * images stripped out (they live in the Space's .assets folder) and Zenbook's
 * own metadata under a top-level `zenbook` key, which other tools ignore.
 */
export function serializeScene(
  pageId: string,
  elements: readonly unknown[],
  appState: KeptAppState,
  paper: Paper,
): string {
  return JSON.stringify({
    type: 'excalidraw',
    version: 2,
    source: SOURCE,
    elements,
    appState: { viewBackgroundColor: '#ffffff', ...appState },
    files: {},
    zenbook: { id: pageId, paper },
  })
}

/** Paper cell size in scene units. */
export const PAPER_CELL = 24

/** Background position and size for the paper pattern at a given scroll/zoom. */
export function paperGeometry(scrollX: number, scrollY: number, zoom: number) {
  const size = PAPER_CELL * zoom
  const mod = (n: number) => ((n % size) + size) % size
  return {
    size,
    x: mod(scrollX * zoom),
    y: mod(scrollY * zoom),
    // Patterns get noisy when zoomed far out: fade them away.
    opacity: Math.max(0, Math.min(1, (zoom - 0.3) / 0.25)),
  }
}
