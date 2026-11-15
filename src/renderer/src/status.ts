// Pure helpers for save state and banners (no React, no IPC), so they're easy to test.

export type SaveState = 'saved' | 'dirty' | 'saving' | 'error'

/** One banner slot per source, so the canvas and the notes never clear each other's message. */
export type BannerKey = 'canvas' | 'notes' | 'conflict' | 'unreadable'
export type Banners = Partial<Record<BannerKey, string>>

const BANNER_ORDER: readonly BannerKey[] = ['canvas', 'notes', 'unreadable', 'conflict']

/** What the title strip shows for the two editors together: error > saving/dirty > saved. */
export function combineSave(a: SaveState, b: SaveState): SaveState {
  if (a === 'error' || b === 'error') return 'error'
  if (a === 'saving' || b === 'saving') return 'saving'
  if (a === 'dirty' || b === 'dirty') return 'dirty'
  return 'saved'
}

/** The banner shown when several are pending: save errors first. */
export function topBanner(banners: Banners): BannerKey | null {
  return BANNER_ORDER.find((key) => banners[key]) ?? null
}

/** Remembers a page's viewport as the most recent one, keeping at most `max` pages. */
export function recordViewport<T>(
  viewports: Readonly<Record<string, T>>,
  pageId: string,
  viewport: T,
  max: number,
): Record<string, T> {
  const next: Record<string, T> = { ...viewports }
  delete next[pageId] // re-inserted last, so the most recently used pages are kept
  next[pageId] = viewport
  const keys = Object.keys(next)
  if (keys.length <= max) return next
  return Object.fromEntries(keys.slice(-max).map((k) => [k, next[k]!]))
}
