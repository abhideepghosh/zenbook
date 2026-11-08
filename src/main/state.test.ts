import { describe, expect, it } from 'vitest'
import { applyPrefs, defaultPrefs, fitBounds, parsePrefs, parseState, PrefsPatch } from './state'

describe('parseState', () => {
  it('returns defaults for missing or corrupt input', () => {
    const empty = { version: 1, window: {}, libraryPath: null, prefs: defaultPrefs() }
    expect(parseState(undefined)).toEqual(empty)
    expect(parseState('nonsense')).toEqual(empty)
    expect(parseState({ window: { bounds: { x: 'a', y: 0, width: 10, height: 10 } } })).toEqual(
      empty,
    )
  })

  it('keeps valid bounds, the maximized flag and the library path', () => {
    const bounds = { x: 10, y: 20, width: 1200, height: 800 }
    const state = parseState({ window: { bounds, maximized: true }, libraryPath: 'D:\\Notes' })
    expect(state.window).toEqual({ bounds, maximized: true })
    expect(state.libraryPath).toBe('D:\\Notes')
  })
})

describe('prefs', () => {
  it('keeps valid fields and replaces invalid ones with defaults', () => {
    const prefs = parsePrefs({
      theme: 'dark',
      sidebarWidth: 9999,
      recent: ['not valid!'],
      notesOpen: false,
    })
    expect(prefs.theme).toBe('dark')
    expect(prefs.sidebarWidth).toBe(248)
    expect(prefs.recent).toEqual([])
    expect(prefs.notesOpen).toBe(false)
  })

  it('rejects unknown or malformed patches from the renderer', () => {
    expect(PrefsPatch.safeParse({ theme: 'dark' }).success).toBe(true)
    expect(PrefsPatch.safeParse({ theme: 'neon' }).success).toBe(false)
    expect(PrefsPatch.safeParse({ libraryPath: 'C:\\' }).success).toBe(false)
  })

  it('keeps only the most recent 200 viewports', () => {
    const viewports = Object.fromEntries(
      Array.from({ length: 250 }, (_, i) => [
        `page-${String(i).padStart(4, '0')}`,
        { scrollX: 0, scrollY: 0, zoom: 1 },
      ]),
    )
    const next = applyPrefs(defaultPrefs(), { viewports })
    expect(Object.keys(next.viewports)).toHaveLength(200)
    expect(Object.keys(next.viewports)[0]).toBe('page-0050')
  })
})

describe('fitBounds', () => {
  const laptop = { x: 0, y: 0, width: 1440, height: 900 }
  const external = { x: 1440, y: 0, width: 2560, height: 1440 }

  it('keeps a window that is on screen', () => {
    const saved = { x: 100, y: 80, width: 1280, height: 800 }
    expect(fitBounds(saved, [laptop])).toEqual(saved)
  })

  it('drops a window whose monitor was unplugged', () => {
    expect(fitBounds({ x: 2000, y: 100, width: 1280, height: 800 }, [laptop])).toBeUndefined()
  })

  it('shrinks and moves a window that no longer fits', () => {
    expect(fitBounds({ x: 1500, y: 100, width: 3000, height: 1600 }, [laptop, external])).toEqual(
      external,
    )
  })

  it('returns undefined when nothing was saved', () => {
    expect(fitBounds(undefined, [laptop])).toBeUndefined()
  })
})
