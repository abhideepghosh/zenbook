import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import type { Prefs } from '../shared/api'

// Per-device state. Lives in userData, never in the (possibly synced) library.

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

export interface UiState {
  version: 1
  window: { bounds?: Bounds; maximized?: boolean }
  libraryPath: string | null
  prefs: Prefs
}

const id = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/)
const viewport = z.object({ scrollX: z.number(), scrollY: z.number(), zoom: z.number().positive() })

/** Schema per preference. Used for IPC patches (strict) and for reading the file (lenient). */
export const prefFields = {
  lastPageId: id.nullable(),
  recent: z.array(id).max(50),
  theme: z.enum(['system', 'light', 'dark']),
  sidebarOpen: z.boolean(),
  notesOpen: z.boolean(),
  sidebarWidth: z.number().min(200).max(360),
  notesWidth: z.number().min(280).max(560),
  collapsed: z.array(id).max(5000),
  viewports: z.record(id, viewport),
  autoUpdate: z.boolean(),
}
export const PrefsPatch = z.object(prefFields).partial().strict()

export const defaultPrefs = (): Prefs => ({
  lastPageId: null,
  recent: [],
  theme: 'system',
  sidebarOpen: true,
  notesOpen: true,
  sidebarWidth: 248,
  notesWidth: 340,
  collapsed: [],
  viewports: {},
  autoUpdate: true,
})

const MAX_VIEWPORTS = 200

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const obj = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

function parseBounds(raw: unknown): Bounds | undefined {
  const { x, y, width, height } = obj(raw)
  if (![x, y, width, height].every(isFiniteNumber)) return undefined
  return { x: x as number, y: y as number, width: width as number, height: height as number }
}

/** Keeps each valid preference and falls back to the default for anything invalid. */
export function parsePrefs(raw: unknown): Prefs {
  const source = obj(raw)
  const out = defaultPrefs() as unknown as Record<string, unknown>
  for (const [key, schema] of Object.entries(prefFields)) {
    const result = schema.safeParse(source[key])
    if (result.success) out[key] = result.data
  }
  return out as unknown as Prefs
}

/** Accepts anything (a hand-edited or corrupt file) and returns a valid state. */
export function parseState(raw: unknown): UiState {
  const source = obj(raw)
  const window = obj(source.window)
  const bounds = parseBounds(window.bounds)
  return {
    version: 1,
    window: {
      ...(bounds && { bounds }),
      ...(window.maximized === true && { maximized: true }),
    },
    libraryPath:
      typeof source.libraryPath === 'string' && source.libraryPath ? source.libraryPath : null,
    prefs: parsePrefs(source.prefs),
  }
}

/** Applies a validated patch, keeping only the most recent viewports. */
export function applyPrefs(prefs: Prefs, patch: Partial<Prefs>): Prefs {
  const next = { ...prefs, ...patch }
  const keys = Object.keys(next.viewports)
  if (keys.length > MAX_VIEWPORTS) {
    next.viewports = Object.fromEntries(
      keys.slice(-MAX_VIEWPORTS).map((k) => [k, next.viewports[k]!]),
    )
  }
  return next
}

/** The state file, kept in memory and written (debounced) with tmp + rename. */
export class StateStore {
  data: UiState
  private timer: NodeJS.Timeout | undefined

  constructor(private readonly file: string) {
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      raw = undefined
    }
    this.data = parseState(raw)
  }

  update(fn: (state: UiState) => void): void {
    fn(this.data)
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.saveNow(), 400)
  }

  /** Synchronous so it can run while the app quits; the file is tiny. */
  saveNow(): void {
    clearTimeout(this.timer)
    const tmp = `${this.file}.tmp`
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(tmp, JSON.stringify(this.data))
      renameSync(tmp, this.file)
    } catch {
      // UI state is a convenience; never block over it.
    }
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
