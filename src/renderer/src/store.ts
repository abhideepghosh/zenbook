import { create } from 'zustand'
import type { Prefs, Tree, UpdateStatus } from '../../shared/api'

export type SaveState = 'saved' | 'dirty' | 'saving' | 'error'

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
  saveState: SaveState
  /** The item whose name is being edited inline (page, chapter or space). */
  renamingId: string | null
  focus: boolean
  paletteOpen: boolean
  paletteSeed: string
  toast: Toast | null
  banner: string | null
  update: UpdateStatus
  /** A page just created whose tree update hasn't arrived yet. */
  pendingPageId: string | null
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
  saveState: 'saved',
  renamingId: null,
  focus: false,
  paletteOpen: false,
  paletteSeed: '',
  toast: null,
  banner: null,
  update: { kind: 'idle' },
  pendingPageId: null,
}))

darkQuery.addEventListener('change', (e) => useStore.setState({ dark: e.matches }))
narrowQuery.addEventListener('change', (e) => useStore.setState({ narrow: e.matches }))

export const get = useStore.getState
export const set = useStore.setState

/** Updates preferences locally and persists them in the main process. */
export function setPrefs(patch: Partial<Prefs>): void {
  set((s) => ({ prefs: { ...s.prefs, ...patch } }))
  void window.zenbook.prefs.set(patch)
}

let toastTimer: ReturnType<typeof setTimeout> | undefined
export function showToast(toast: Toast, ms = 6000): void {
  clearTimeout(toastTimer)
  set({ toast })
  toastTimer = setTimeout(() => set({ toast: null }), ms)
}
