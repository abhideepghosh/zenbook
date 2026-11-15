import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tree } from '../../shared/api'
import type { PageEditor } from './editors'

// editors.ts reaches the store (which reads matchMedia) and window.zenbook: stub both.
const saveConflictCopy = vi.fn<(id: string, json: string | null, md: string) => Promise<string>>()
const media = { matches: false, addEventListener: () => undefined }
;(globalThis as unknown as { window: unknown }).window = {
  matchMedia: () => media,
  zenbook: {
    page: { saveConflictCopy, open: vi.fn() },
    prefs: { set: () => Promise.resolve() },
  },
}

let mod: typeof import('./editors')
let store: typeof import('./store')

beforeAll(async () => {
  store = await import('./store')
  mod = await import('./editors')
})

const page = (id: string) => ({ id, name: id === 'a1' ? 'Ideas' : id, conflict: false })
const tree: Tree = {
  spaces: [
    {
      id: 'A',
      name: 'A',
      color: 'sage',
      pinned: [],
      chapters: [{ id: 'ca', name: 'c', pages: [page('a1')] }],
    },
    {
      id: 'B',
      name: 'B',
      color: 'sage',
      pinned: [],
      chapters: [{ id: 'cb', name: 'c', pages: [page('b1')] }],
    },
  ],
}

function fakeEditor(pageId: string | null, opts: { dirty?: boolean; failed?: boolean } = {}) {
  const state = { dirty: opts.dirty ?? false, failed: opts.failed ?? false }
  const editor: PageEditor & { state: typeof state } = {
    state,
    currentPage: () => pageId,
    isDirty: () => state.dirty,
    hasFailedSave: () => state.failed,
    flush: () => Promise.resolve(),
    snapshot: () => Promise.resolve(`snap-${pageId}`),
    reload: vi.fn(() => Promise.resolve()),
    suspend: vi.fn(() => Promise.resolve()),
    resume: vi.fn(),
    discardUnsaved: vi.fn(() => {
      state.dirty = false
      state.failed = false
    }),
    recheckAfterLoad: vi.fn(),
  }
  return editor
}

beforeEach(() => {
  saveConflictCopy.mockReset()
  store.set({ tree, pageId: 'a1', spaceId: 'A', toast: null, banners: {} })
  mod.editors.canvas = null
  mod.editors.notes = null
})

describe('keepPage', () => {
  it('puts the sidebar back on the kept page’s Space, even if the page never changed', () => {
    store.set({ spaceId: 'B' }) // switchSpace sets this before the save is known to fail
    mod.keepPage('a1')
    expect(store.get().pageId).toBe('a1')
    expect(store.get().spaceId).toBe('A')
  })
})

describe('mayLeave', () => {
  it('keeps edits that can’t be saved in a conflict copy, then lets the user go', async () => {
    const canvas = fakeEditor('a1', { dirty: true, failed: true })
    const notes = fakeEditor('a1', { dirty: true })
    mod.editors.canvas = canvas
    mod.editors.notes = notes
    saveConflictCopy.mockResolvedValue('copy')
    expect(mod.unsavedPage()).toBe('a1')
    expect(await mod.mayLeave('a1')).toBe(true)
    expect(saveConflictCopy).toHaveBeenCalledWith('a1', 'snap-a1', 'snap-a1')
    expect(canvas.discardUnsaved).toHaveBeenCalledWith('a1')
    expect(notes.discardUnsaved).not.toHaveBeenCalled() // still saves normally
    expect(store.get().toast?.message).toContain('“Ideas”')
  })

  it('stays on the page when even the copy fails', async () => {
    mod.editors.canvas = fakeEditor('a1', { dirty: true, failed: true })
    saveConflictCopy.mockRejectedValue(new Error('EPERM'))
    store.set({ spaceId: 'B' })
    expect(await mod.mayLeave('a1')).toBe(false)
    expect(store.get().spaceId).toBe('A')
    expect(store.get().toast?.message).toContain('stays open')
  })

  it('makes one copy when several callers rescue the same page at once', async () => {
    mod.editors.canvas = fakeEditor('a1', { dirty: true, failed: true })
    saveConflictCopy.mockResolvedValue('copy')
    const results = await Promise.all([mod.rescueUnsaved('a1'), mod.rescueUnsaved('a1')])
    expect(results).toEqual([true, true])
    expect(saveConflictCopy).toHaveBeenCalledTimes(1)
  })
})

describe('handleExternalChange', () => {
  it('asks an editor still loading the page to check again, and reloads the ones showing it', async () => {
    const loading = fakeEditor(null)
    const showing = fakeEditor('a1')
    mod.editors.canvas = loading
    mod.editors.notes = showing
    await mod.handleExternalChange('a1')
    expect(loading.recheckAfterLoad).toHaveBeenCalledWith('a1')
    expect(showing.suspend).toHaveBeenCalled()
    expect(showing.reload).toHaveBeenCalledWith('a1')
    expect(showing.resume).toHaveBeenCalled()
    expect(saveConflictCopy).not.toHaveBeenCalled()
  })

  it('keeps local edits as one copy and does not reload when the copy fails', async () => {
    const showing = fakeEditor('a1', { dirty: true })
    mod.editors.canvas = showing
    saveConflictCopy.mockRejectedValue(new Error('disk full'))
    await mod.handleExternalChange('a1')
    expect(saveConflictCopy).toHaveBeenCalledTimes(1)
    expect(showing.reload).not.toHaveBeenCalled()
    expect(showing.resume).toHaveBeenCalled()
  })
})
