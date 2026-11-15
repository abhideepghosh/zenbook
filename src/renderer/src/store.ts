import { create } from 'zustand'
import type { Prefs, Tree, UpdateStatus } from '../../shared/api'
import type { BannerKey, Banners, SaveState } from './status'

export type { SaveState } from './status'

export interface Toast {
  message: string
  action?: { label: string; run: () => void }
}

export interface UiState {
  status: 'loading' | 'none' | 'ready' | 'error'
  error: string | null
  root: string | null
  tree: Tree
  spaceId: string | null
  pageId: string | null
  prefs: Prefs
  dark: boolean
  /** Window narrower than 1200 px: notes become an overlay. */
  narrow: boolean
  /** Each editor reports its own save state; the title strip shows them combined. */
  canvasSave: SaveState
  notesSave: SaveState
  /** The item whose name is being edited inline (page, chapter or space). */
  renamingId: string | null
  focus: boolean
  paletteOpen: boolean
  paletteSeed: string
  toast: Toast | null
  /** Persistent notices above the canvas, one slot per source. */
  banners: Banners
  update: UpdateStatus
  /** A page just created whose tree update hasn't arrived yet. */
  pendingPageId: string | null
  /** A button that should take focus once it has rendered (by aria-label). */
  focusRequest: string | null
}

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')
const narrowQuery = window.matchMedia('(max-width: 1199px)')

export const useStore = create<UiState>()(() => ({
  status: 'loading',
  error: null,
  root: null,
  tree: { spaces: [] },
  spaceId: null,
  pageId: null,
  prefs: {
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
  },
  dark: darkQuery.matches,
  narrow: narrowQuery.matches,
  canvasSave: 'saved',
  notesSave: 'saved',
  renamingId: null,
  focus: false,
  paletteOpen: false,
  paletteSeed: '',
  toast: null,
  banners: {},
  update: { kind: 'idle' },
  pendingPageId: null,
  focusRequest: null,
}))

darkQuery.addEventListener('change', (e) => useStore.setState({ dark: e.matches }))
narrowQuery.addEventListener('change', (e) => useStore.setState({ narrow: e.matches }))

export const get = useStore.getState
export const set = useStore.setState

/** Updates preferences locally and persists them in the main process. */
export function setPrefs(patch: Partial<Prefs>): void {
  set((s) => ({ prefs: { ...s.prefs, ...patch } }))
  window.zenbook.prefs.set(patch).catch((err: unknown) => {
    console.warn('Couldn’t save preferences', err)
  })
}

/** Shows (or, with null, clears) one banner slot. A no-op when nothing changes. */
export function setBanner(key: BannerKey, message: string | null): void {
  const banners = get().banners
  if ((banners[key] ?? null) === message) return
  const next = { ...banners }
  if (message === null) delete next[key]
  else next[key] = message
  set({ banners: next })
}

/**
 * A ref callback that focuses its button when it mounts in answer to a focus request
 * (e.g. "Hide sidebar" gets focus after "Show sidebar" was clicked and unmounted).
 */
export function focusWhenRequested(label: string): (el: HTMLElement | null) => void {
  return (el) => {
    if (!el || get().focusRequest !== label) return
    set({ focusRequest: null })
    el.focus()
  }
}

let toastTimer: ReturnType<typeof setTimeout> | undefined
export function showToast(toast: Toast, ms = 6000): void {
  clearTimeout(toastTimer)
  set({ toast })
  toastTimer = setTimeout(() => set({ toast: null }), ms)
}
