import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {} }))

const { fitBounds, parseState } = await import('./state')

describe('parseState', () => {
  it('returns defaults for missing or corrupt input', () => {
    expect(parseState(undefined)).toEqual({ version: 1, window: {} })
    expect(parseState('nonsense')).toEqual({ version: 1, window: {} })
    expect(parseState({ window: { bounds: { x: 'a', y: 0, width: 10, height: 10 } } })).toEqual({
      version: 1,
      window: {},
    })
  })

  it('keeps valid bounds and the maximized flag', () => {
    const bounds = { x: 10, y: 20, width: 1200, height: 800 }
    expect(parseState({ window: { bounds, maximized: true } })).toEqual({
      version: 1,
      window: { bounds, maximized: true },
    })
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
