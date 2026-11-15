import type { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { editors, handleExternalChange, mayLeave, type PageEditor } from '../editors'
import { openPageData } from '../pageOpen'
import { get, set, setBanner, useStore } from '../store'
import { locatePage } from '../tree'
import { createState, EditorView as View } from './editor'

const SAVE_DELAY_MS = 600
const WORDS_DELAY_MS = 300
const RETRY_DELAY_MS = 3000
const CACHE_PAGES = 20

export interface NotesInfo {
  words: number
  modified: number
}

const countWords = (text: string) => (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length

/** A page's editor state kept while it isn't shown, with the text last saved for it. */
interface Cached {
  state: EditorState
  saved: string
}

/**
 * One CodeMirror view for every page. Each page keeps its own EditorState in a
 * small cache, so undo history and the cursor survive switching away and back.
 */
class NotesController implements PageEditor {
  private view: EditorView | null = null
  private pageId: string | null = null
  private saved = ''
  private timer: ReturnType<typeof setTimeout> | undefined
  private wordsTimer: ReturnType<typeof setTimeout> | undefined
  private saving: Promise<void> | null = null
  private failed = false
  private suspended = 0
  private cacheTimer: ReturnType<typeof setTimeout> | undefined
  /** The page a load is in progress for, and whether it changed on disk meanwhile. */
  private loadingPageId: string | null = null
  private recheck: string | null = null
  private resumed: Promise<void> | null = null
  private resolveResumed: (() => void) | null = null
  private loadToken = 0
  private readonly states = new Map<string, Cached>()
  private info: NotesInfo = { words: 0, modified: 0 }
  private readonly infoListeners = new Set<(info: NotesInfo) => void>()
  private unsubscribe: (() => void) | null = null

  mount(parent: HTMLElement): void {
    this.view = new View({ parent, state: createState('', this.onDocChange, true) })
    editors.notes = this
    // Follow the current page without React re-rendering the panel.
    this.unsubscribe = useStore.subscribe((s, prev) => {
      if (s.pageId === prev.pageId) return
      if (s.pageId) void this.load(s.pageId)
      else void this.unload()
    })
    const pageId = get().pageId
    if (pageId) void this.load(pageId)
  }

  /**
   * Detaches synchronously (so a panel mounted right after gets a clean controller);
   * unsaved text is captured now and written in the background.
   */
  async unmount(): Promise<void> {
    const view = this.view
    if (!view) return
    this.unsubscribe?.()
    this.unsubscribe = null
    this.loadToken++
    this.loadingPageId = null
    this.recheck = null
    // Unsaved text goes to the cache, and every unsaved cache entry is written (after a
    // suspend, if one is on). It stays cached until written, with a retry.
    if (this.pageId) this.remember(this.pageId, view.state, this.saved)
    if (editors.notes === this) editors.notes = null
    clearTimeout(this.timer)
    clearTimeout(this.wordsTimer)
    this.view = null
    this.pageId = null
    this.saved = ''
    this.failed = false
    view.destroy()
    await this.flushCached()
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

  /** Runs on every keystroke: only flags the change and (re)starts timers. */
  private readonly onDocChange = (): void => {
    if (!this.pageId) return
    const state = get().notesSave
    if (state !== 'dirty' && state !== 'error') set({ notesSave: 'dirty' })
    clearTimeout(this.timer)
    if (this.suspended === 0) this.timer = setTimeout(this.onSaveTimer, SAVE_DELAY_MS)
    clearTimeout(this.wordsTimer)
    this.wordsTimer = setTimeout(this.updateWords, WORDS_DELAY_MS)
  }

  private readonly onSaveTimer = (): void => {
    if (this.isDirty()) void this.save()
    else if (!this.failed && !this.saving) set({ notesSave: 'saved' }) // typed, then undone
  }

  private readonly updateWords = (): void => {
    this.setInfo({ ...this.info, words: countWords(this.text()) })
  }

  private text(): string {
    return this.view?.state.doc.toString() ?? ''
  }

  currentPage(): string | null {
    return this.view ? this.pageId : null
  }

  isDirty(): boolean {
    return Boolean(this.view && this.pageId && this.text() !== this.saved)
  }

  hasFailedSave(): boolean {
    return this.failed
  }

  async snapshot(): Promise<string | null> {
    return this.view && this.pageId ? this.text() : null
  }

  async suspend(): Promise<void> {
    if (this.suspended++ === 0) {
      this.resumed = new Promise<void>((resolve) => (this.resolveResumed = resolve))
    }
    clearTimeout(this.timer)
    if (this.saving) await this.saving
  }

  resume(): void {
    if (this.suspended === 0 || --this.suspended > 0) return
    this.resolveResumed?.()
    this.resolveResumed = null
    this.resumed = null
    if (this.isDirty()) {
      clearTimeout(this.timer)
      this.timer = setTimeout(this.onSaveTimer, SAVE_DELAY_MS)
    }
  }

  async flush(): Promise<void> {
    if (this.resumed) await this.resumed
    if (this.saving) await this.saving
    if (this.isDirty()) await this.save()
    await this.flushCached()
  }

  /** Runs `job` after every write already queued (and after a suspend ends): writes stay in order. */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const task = Promise.all([this.saving, this.resumed]).then(job)
    const tracked = task.then(
      () => undefined,
      () => undefined,
    )
    this.saving = tracked
    void tracked.then(() => {
      if (this.saving === tracked) this.saving = null
    })
    return task
  }

  /** Captures the text now and writes it after any save already in flight. */
  private save(): Promise<void> {
    clearTimeout(this.timer)
    const pageId = this.pageId
    const view = this.view
    if (!pageId || !view || this.suspended > 0) return this.saving ?? Promise.resolve()
    const text = view.state.doc.toString()
    return this.enqueue(() => this.write(pageId, text))
  }

  /**
   * Writes cached pages whose text was never saved (a failed save, or a panel closed
   * mid-save), and keeps retrying those that fail.
   */
  private async flushCached(): Promise<void> {
    clearTimeout(this.cacheTimer)
    const shown = this.view ? this.pageId : null
    const jobs: Promise<boolean>[] = []
    for (const [id, cached] of this.states) {
      const text = cached.state.doc.toString()
      if (id === shown || text === cached.saved || !locatePage(get().tree, id)) continue
      jobs.push(this.enqueue(() => this.writeCached(id, text)))
    }
    if (jobs.length === 0) {
      if (!this.view) {
        setBanner('notes', null) // panel closed with nothing left to write
        set({ notesSave: 'saved' })
      }
      return
    }
    const ok = (await Promise.all(jobs)).every(Boolean)
    if (!ok) {
      this.cacheTimer = setTimeout(() => void this.flushCached(), RETRY_DELAY_MS)
      if (!this.view) {
        setBanner('notes', 'Couldn’t save some notes. Retrying in a moment…')
        set({ notesSave: 'error' })
      }
    } else if (!this.view) {
      setBanner('notes', null)
      set({ notesSave: 'saved' })
    }
  }

  private async writeCached(pageId: string, text: string): Promise<boolean> {
    try {
      await window.zenbook.page.saveNotes(pageId, text)
    } catch (err) {
      console.error('[notes] save failed', err)
      return false
    }
    const cached = this.states.get(pageId)
    if (cached && cached.state.doc.toString() === text) cached.saved = text
    return true
  }

  private async write(pageId: string, text: string): Promise<void> {
    const current = () => this.view !== null && this.pageId === pageId
    if (current() && text === this.saved && !this.failed) return // already written
    if (current()) set({ notesSave: 'saving' })
    try {
      await window.zenbook.page.saveNotes(pageId, text)
      const cached = this.states.get(pageId)
      if (cached && cached.state.doc.toString() === text) cached.saved = text
      if (!current()) {
        if (!this.view) set({ notesSave: 'saved' }) // written after the panel closed
        return
      }
      this.saved = text
      this.failed = false
      this.setInfo({ ...this.info, modified: Date.now() })
      setBanner('notes', null)
      set({ notesSave: this.isDirty() ? 'dirty' : 'saved' })
    } catch (err) {
      console.error('[notes] save failed', err)
      if (!current()) {
        // Left already: the text is in the cache, which is written (and retried) from there.
        clearTimeout(this.cacheTimer)
        this.cacheTimer = setTimeout(() => void this.flushCached(), RETRY_DELAY_MS)
        return
      }
      this.failed = true
      const missing = !locatePage(get().tree, pageId)
      setBanner(
        'notes',
        missing
          ? 'This page can’t be found on disk right now, so your latest notes aren’t saved yet. Retrying…'
          : 'Couldn’t save these notes. Retrying in a moment…',
      )
      set({ notesSave: 'error' })
      clearTimeout(this.timer)
      this.timer = setTimeout(() => void this.save(), RETRY_DELAY_MS)
    }
  }

  private remember(pageId: string, state: EditorState, saved: string): void {
    this.states.delete(pageId)
    this.states.set(pageId, { state, saved })
    if (this.states.size <= CACHE_PAGES) return
    // Evict the oldest page without unsaved text (never drop unsaved text).
    for (const [id, cached] of this.states) {
      if (cached.state.doc.toString() === cached.saved) {
        this.states.delete(id)
        return
      }
    }
  }

  /** The previous page couldn't be saved: stay on it rather than lose its notes. */
  private blocked(previous: string): boolean {
    return this.failed && this.isDirty() && locatePage(get().tree, previous) !== null
  }

  async load(pageId: string, discardLocal = false): Promise<void> {
    const view = this.view
    if (!view) return
    const token = ++this.loadToken
    if (!discardLocal && this.pageId === pageId) return // already showing it
    const stale = () => token !== this.loadToken || this.view !== view
    const previous = this.pageId
    if (!discardLocal) {
      await this.flush()
      if (stale()) return
      if (previous && previous !== pageId && this.blocked(previous)) {
        if (!(await mayLeave(previous))) return
        if (stale()) return
      }
    }
    this.loadingPageId = pageId

    let data
    try {
      data = await openPageData(pageId)
    } catch {
      if (stale()) return
      if (!discardLocal) this.leave(view) // a reload drops local text on purpose
      this.showEmpty(view) // the canvas shows the "couldn't read" banner
      this.loaded(pageId)
      return
    }
    if (stale()) return
    if (this.pageId !== pageId) this.leave(view)

    // Reuse the cached state (with its undo history) if the file hasn't changed since,
    // or if it holds text that was never saved (that text wins, and is saved now).
    const cached = discardLocal ? undefined : this.states.get(pageId)
    const cachedText = cached?.state.doc.toString()
    const unsaved = cached !== undefined && cachedText !== cached.saved
    const state =
      cached && (cachedText === data.notes || unsaved)
        ? cached.state
        : createState(data.notes, this.onDocChange)
    clearTimeout(this.timer)
    clearTimeout(this.wordsTimer)
    this.pageId = pageId
    this.saved = data.notes
    this.failed = false
    view.setState(state)
    this.setInfo({ words: countWords(state.doc.toString()), modified: data.modified })
    setBanner('notes', null)
    if (unsaved && state.doc.toString() !== data.notes) {
      set({ notesSave: 'dirty' })
      void this.save()
    } else {
      set({ notesSave: 'saved' })
    }
    this.loaded(pageId)
  }

  /** A load finished: if the page changed on disk meanwhile, handle that now. */
  private loaded(pageId: string): void {
    if (this.loadingPageId === pageId) this.loadingPageId = null
    if (this.recheck !== pageId) return
    this.recheck = null
    void handleExternalChange(pageId)
  }

  recheckAfterLoad(pageId: string): void {
    if (this.loadingPageId === pageId) this.recheck = pageId
  }

  discardUnsaved(pageId: string): void {
    if (this.currentPage() !== pageId) return
    clearTimeout(this.timer)
    this.saved = this.text()
    this.failed = false
    setBanner('notes', null)
    set({ notesSave: 'saved' })
  }

  /** Leaves the shown page: text typed while the next page was opening is saved, then cached. */
  private leave(view: EditorView): void {
    const pageId = this.pageId
    if (!pageId) return
    if (this.isDirty()) void this.save()
    this.remember(pageId, view.state, this.saved)
  }

  /** No page: an empty editor that can't be typed into. */
  private showEmpty(view: EditorView): void {
    clearTimeout(this.timer)
    clearTimeout(this.wordsTimer)
    this.pageId = null
    this.saved = ''
    this.failed = false
    view.setState(createState('', this.onDocChange, true))
    this.setInfo({ words: 0, modified: 0 })
    setBanner('notes', null)
    set({ notesSave: 'saved' })
  }

  /** No page is open (an empty Space, or the last page was deleted). */
  async unload(): Promise<void> {
    const view = this.view
    if (!view) return
    const token = ++this.loadToken
    const previous = this.pageId
    await this.flush()
    if (token !== this.loadToken || this.view !== view) return
    if (previous && this.blocked(previous)) {
      if (!(await mayLeave(previous))) return
      if (token !== this.loadToken || this.view !== view) return
    }
    this.loadingPageId = null
    this.leave(view)
    this.showEmpty(view)
  }

  reload(pageId: string): Promise<void> {
    if (this.currentPage() !== pageId) return Promise.resolve()
    this.states.delete(pageId)
    return this.load(pageId, true)
  }
}

export const notes = new NotesController()
