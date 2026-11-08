import type { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { editors, type PageEditor } from '../editors'
import { get, set, useStore } from '../store'
import { locatePage } from '../tree'
import { createState, EditorView as View } from './editor'

const SAVE_DELAY_MS = 600
const CACHE_PAGES = 20

export interface NotesInfo {
  words: number
  modified: number
}

const countWords = (text: string) => (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length

/**
 * One CodeMirror view for every page. Each page keeps its own EditorState in a
 * small cache, so undo history and the cursor survive switching away and back.
 */
class NotesController implements PageEditor {
  private view: EditorView | null = null
  private pageId: string | null = null
  private saved = ''
  private timer: ReturnType<typeof setTimeout> | undefined
  private saving: Promise<void> | null = null
  private loadToken = 0
  private readonly states = new Map<string, EditorState>()
  private info: NotesInfo = { words: 0, modified: 0 }
  private readonly infoListeners = new Set<(info: NotesInfo) => void>()
  private unsubscribe: (() => void) | null = null

  mount(parent: HTMLElement): void {
    this.view = new View({ parent, state: createState('', this.onDocChange) })
    editors.notes = this
    // Follow the current page without React re-rendering the panel.
    this.unsubscribe = useStore.subscribe((s, prev) => {
      if (s.pageId && s.pageId !== prev.pageId) void this.load(s.pageId)
    })
    const pageId = get().pageId
    if (pageId) void this.load(pageId)
  }

  async unmount(): Promise<void> {
    this.unsubscribe?.()
    this.unsubscribe = null
    await this.flush()
    if (this.pageId && this.view) this.remember(this.pageId, this.view.state)
    if (editors.notes === this) editors.notes = null
    this.view?.destroy()
    this.view = null
    this.pageId = null
  }

  focus(): void {
    this.view?.focus()
  }

  onInfo(cb: (info: NotesInfo) => void): () => void {
    this.infoListeners.add(cb)
    cb(this.info)
    return () => this.infoListeners.delete(cb)
  }

  private setInfo(info: NotesInfo): void {
    this.info = info
    for (const cb of this.infoListeners) cb(info)
  }

  private readonly onDocChange = (doc: string): void => {
    if (!this.pageId) return
    this.setInfo({ ...this.info, words: countWords(doc) })
    clearTimeout(this.timer)
    if (doc === this.saved) return
    if (get().saveState !== 'dirty') set({ saveState: 'dirty' })
    this.timer = setTimeout(() => void this.save(), SAVE_DELAY_MS)
  }

  private text(): string {
    return this.view?.state.doc.toString() ?? ''
  }

  isDirty(): boolean {
    return Boolean(this.view && this.pageId && this.text() !== this.saved)
  }

  snapshot(): string | null {
    return this.view ? this.text() : null
  }

  async flush(): Promise<void> {
    if (this.saving) await this.saving
    if (this.isDirty()) await this.save()
  }

  private save(): Promise<void> {
    clearTimeout(this.timer)
    if (this.saving) return this.saving.then(() => (this.isDirty() ? this.save() : undefined))
    const pageId = this.pageId
    if (!pageId || !this.view) return Promise.resolve()
    const text = this.text()
    const task = (async () => {
      set({ saveState: 'saving' })
      try {
        await window.zenbook.page.saveNotes(pageId, text)
        if (this.pageId === pageId) {
          this.saved = text
          this.setInfo({ ...this.info, modified: Date.now() })
        }
        set({ saveState: this.isDirty() ? 'dirty' : 'saved' })
      } catch {
        if (!locatePage(get().tree, pageId)) return void set({ saveState: 'saved' })
        set({ saveState: 'error', banner: 'Couldn’t save these notes. Retrying in a moment…' })
        this.timer = setTimeout(() => void this.save(), 3000)
      }
    })()
    this.saving = task.finally(() => {
      this.saving = null
    })
    return this.saving
  }

  private remember(pageId: string, state: EditorState): void {
    this.states.delete(pageId)
    this.states.set(pageId, state)
    if (this.states.size > CACHE_PAGES) this.states.delete(this.states.keys().next().value!)
  }

  async load(pageId: string, discardLocal = false): Promise<void> {
    const view = this.view
    if (!view) return
    const token = ++this.loadToken
    if (!discardLocal) await this.flush()
    if (token !== this.loadToken || !this.view) return
    if (this.pageId && this.pageId !== pageId) this.remember(this.pageId, view.state)

    let data
    try {
      data = await window.zenbook.page.open(pageId)
    } catch {
      return // the canvas shows the "couldn't read" banner
    }
    if (token !== this.loadToken || !this.view) return

    // Reuse the cached state (with its undo history) if the file hasn't changed since.
    const cached = this.states.get(pageId)
    const state =
      cached && !discardLocal && cached.doc.toString() === data.notes
        ? cached
        : createState(data.notes, this.onDocChange)
    clearTimeout(this.timer)
    this.pageId = pageId
    this.saved = data.notes
    this.view.setState(state)
    this.setInfo({ words: countWords(data.notes), modified: data.modified })
  }

  reload(): Promise<void> {
    const pageId = this.pageId
    if (!pageId) return Promise.resolve()
    this.states.delete(pageId)
    return this.load(pageId, true)
  }
}

export const notes = new NotesController()
