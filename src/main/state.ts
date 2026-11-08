import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'

// Per-device UI state. Lives in userData, never in the (possibly synced) library.

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

export interface UiState {
  version: 1
  window: { bounds?: Bounds; maximized?: boolean }
}

function statePath(): string {
  return join(app.getPath('userData'), 'state.json')
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function parseBounds(raw: unknown): Bounds | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const { x, y, width, height } = raw as Record<string, unknown>
  if (![x, y, width, height].every(isFiniteNumber)) return undefined
  return { x: x as number, y: y as number, width: width as number, height: height as number }
}

/** Accepts anything (a hand-edited or corrupt file) and returns a valid state. */
export function parseState(raw: unknown): UiState {
  const window = (typeof raw === 'object' && raw !== null && 'window' in raw ? raw.window : {}) as
    Record<string, unknown> | undefined
  const bounds = parseBounds(window?.bounds)
  return {
    version: 1,
    window: {
      ...(bounds && { bounds }),
      ...(window?.maximized === true && { maximized: true }),
    },
  }
}

export function loadState(): UiState {
  try {
    return parseState(JSON.parse(readFileSync(statePath(), 'utf8')))
  } catch {
    return parseState(undefined)
  }
}

/**
 * Written synchronously because it runs while the window closes; the file is tiny.
 * The tmp + rename keeps it whole even if the process dies mid-write.
 */
export function saveState(state: UiState): void {
  const file = statePath()
  const tmp = `${file}.tmp`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmp, JSON.stringify(state))
    renameSync(tmp, file)
  } catch {
    // UI state is a convenience; never block closing over it.
  }
}

/**
 * Returns the saved bounds if enough of the window is still on a connected
 * display (monitors get unplugged), shrunk to fit that display. Otherwise
 * undefined, so the OS centres a default-sized window.
 */
export function fitBounds(saved: Bounds | undefined, workAreas: Bounds[]): Bounds | undefined {
  if (!saved) return undefined
  let best: { area: Bounds; overlap: number } | undefined
  for (const area of workAreas) {
    const w = Math.min(saved.x + saved.width, area.x + area.width) - Math.max(saved.x, area.x)
    const h = Math.min(saved.y + saved.height, area.y + area.height) - Math.max(saved.y, area.y)
    if (w >= 120 && h >= 40 && (!best || w * h > best.overlap)) best = { area, overlap: w * h }
  }
  if (!best) return undefined
  const width = Math.min(saved.width, best.area.width)
  const height = Math.min(saved.height, best.area.height)
  const x = Math.min(Math.max(saved.x, best.area.x), best.area.x + best.area.width - width)
  const y = Math.min(Math.max(saved.y, best.area.y), best.area.y + best.area.height - height)
  return { x, y, width, height }
}
