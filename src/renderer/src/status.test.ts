import { describe, expect, it } from 'vitest'
import type { PageData } from '../../shared/api'
import { createPageOpener } from './pageOpen'
import { combineSave, recordViewport, topBanner } from './status'

describe('combineSave', () => {
  it('reports the worst state of the two editors', () => {
    expect(combineSave('saved', 'saved')).toBe('saved')
    expect(combineSave('saved', 'dirty')).toBe('dirty')
    expect(combineSave('dirty', 'saving')).toBe('saving')
    expect(combineSave('error', 'saved')).toBe('error')
    expect(combineSave('saving', 'error')).toBe('error')
  })
})

describe('topBanner', () => {
  it('shows save errors before other notices, and nothing when empty', () => {
    expect(topBanner({})).toBeNull()
    expect(topBanner({ conflict: 'c', notes: 'n' })).toBe('notes')
    expect(topBanner({ conflict: 'c', unreadable: 'u' })).toBe('unreadable')
    expect(topBanner({ canvas: 'a', notes: 'n' })).toBe('canvas')
  })
})

describe('recordViewport', () => {
  const vp = (zoom: number) => ({ scrollX: 0, scrollY: 0, zoom })

  it('moves a revisited page to the most recent end', () => {
    const next = recordViewport({ a: vp(1), b: vp(1) }, 'a', vp(2), 10)
    expect(Object.keys(next)).toEqual(['b', 'a'])
    expect(next.a).toEqual(vp(2))
  })

  it('keeps only the most recent pages', () => {
    let map: Record<string, ReturnType<typeof vp>> = {}
    for (const id of ['a', 'b', 'c', 'd']) map = recordViewport(map, id, vp(1), 3)
    map = recordViewport(map, 'b', vp(1), 3)
    expect(Object.keys(map)).toEqual(['c', 'd', 'b'])
  })
})

describe('createPageOpener', () => {
  const data = (notes: string): PageData => ({ scene: null, notes, modified: 0 })

  it('shares one in-flight read per page between callers', async () => {
    let calls = 0
    let resolve!: (d: PageData) => void
    const opener = createPageOpener(() => {
      calls++
      return new Promise<PageData>((r) => (resolve = r))
    })
    const a = opener.open('p1')
    const b = opener.open('p1')
    expect(a).toBe(b)
    expect(calls).toBe(1)
    resolve(data('x'))
    expect((await a).notes).toBe('x')
    // Settled requests are forgotten: the next open reads the file again.
    void opener.open('p1')
    expect(calls).toBe(2)
  })

  it('reads again after invalidate, and forgets failed reads', async () => {
    let calls = 0
    const opener = createPageOpener(() => {
      calls++
      return calls === 1 ? Promise.reject(new Error('busy')) : Promise.resolve(data('ok'))
    })
    await expect(opener.open('p1')).rejects.toThrow('busy')
    expect((await opener.open('p1')).notes).toBe('ok')
    const pending = opener.open('p2')
    opener.invalidate('p2')
    expect(opener.open('p2')).not.toBe(pending)
  })
})
