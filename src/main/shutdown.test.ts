import { afterEach, describe, expect, it, vi } from 'vitest'
import { createShutdown } from './shutdown'
import type { StateStore } from './state'

vi.mock('./window', () => ({
  flushRenderer: vi.fn(() => Promise.resolve()),
  saveWindowState: vi.fn(),
}))

function deps(close: () => Promise<void>) {
  const store = { saveNow: vi.fn() } as unknown as StateStore & {
    saveNow: ReturnType<typeof vi.fn>
  }
  return { store, session: { close: vi.fn(close) }, window: () => null }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('createShutdown', () => {
  it('runs once, however many times it is asked', async () => {
    const d = deps(() => Promise.resolve())
    const shutdown = createShutdown(d)
    expect(shutdown.phase()).toBe('idle')
    const first = shutdown.run()
    expect(shutdown.phase()).toBe('running')
    expect(shutdown.run()).toBe(first)
    await first
    expect(shutdown.phase()).toBe('done')
    expect(d.session.close).toHaveBeenCalledTimes(1)
    expect(d.store.saveNow).toHaveBeenCalledTimes(1)
  })

  it('still finishes (and saves the state) when closing the library fails', async () => {
    const d = deps(() => Promise.reject(new Error('locked')))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const shutdown = createShutdown(d)
    await shutdown.run()
    expect(shutdown.phase()).toBe('done')
    expect(d.store.saveNow).toHaveBeenCalledTimes(1)
  })

  it('gives up on a hung close after the timeout', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const d = deps(() => new Promise<void>(() => undefined))
    const shutdown = createShutdown(d)
    const done = shutdown.run()
    await vi.advanceTimersByTimeAsync(10_000)
    await done
    expect(shutdown.phase()).toBe('done')
    expect(d.store.saveNow).toHaveBeenCalledTimes(1)
  })
})
