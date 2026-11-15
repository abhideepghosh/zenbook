import {
  CaptureUpdateAction,
  getTextFromElements,
  hashElementsVersion,
  restoreElements,
} from '@excalidraw/excalidraw'
import type {
  ExcalidrawElement,
  NonDeletedExcalidrawElement,
} from '@excalidraw/excalidraw/element/types'
import type {
  AppState,
  BinaryFileData,
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from '@excalidraw/excalidraw/types'
import type { PageData, Paper, Viewport } from '../../../shared/api'
import { editors, handleExternalChange, mayLeave, type PageEditor } from '../editors'
import { openPageData } from '../pageOpen'
import { recordViewport } from '../status'
import { get, set, setBanner, setPrefs, showToast, useStore } from '../store'
import { locatePage } from '../tree'
import { parseScene, serializeScene, type KeptAppState } from './scene'

const SAVE_DELAY_MS = 800
const RETRY_DELAY_MS = 3000
/** Matches the main process, which keeps the 200 most recent viewports. */
const MAX_VIEWPORTS = 200
/**
 * Excalidraw keeps every image it was given until it unmounts (there is no API to drop
 * one). Past this many bytes of image data, switching pages starts a fresh instance.
 */
const IMAGE_BUDGET_BYTES = (window.zenbook.imageBudgetMB ?? 150) * 1024 * 1024
const perf = import.meta.env.DEV || window.zenbook.perf

type Zoom = AppState['zoom']

/** Everything one save writes, read from Excalidraw synchronously when the save starts. */
interface Capture {
  api: ExcalidrawImperativeAPI
  pageId: string
  version: number
  count: number
  forceGen: number
  elements: readonly NonDeletedExcalidrawElement[]
  files: BinaryFiles
  json: string
  text: string
}

/**
 * Owns the one Excalidraw instance: loading pages into it and saving them out.
 * Lives outside React so typing and drawing never cause React work: onChange only
 * compares a version hash and (re)starts a timer.
 */
class CanvasController implements PageEditor {
  private api: ExcalidrawImperativeAPI | null = null
  /** The api a page was last loaded into; nothing counts as an edit before that. */
  private loadedApi: ExcalidrawImperativeAPI | null = null
  /** Excalidraw's initialData; it resets the scene once this resolves. */
  private initialData: Promise<unknown> = Promise.resolve()
  private pageId: string | null = null
  private baseline = 0
  /** Non-deleted elements at the baseline (for the "everything vanished" guard). */
  private baselineCount = 0
  /** A pointer or key press happened since the page loaded. */
  private inputSinceLoad = false
  private paper: Paper = 'plain'
  private keptAppState: KeptAppState = {}
  private forceSave = false
  private forceGen = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private saving: Promise<void> | null = null
  private failed = false
  private suspended = 0
  private prepared = false
  /** The page a load is in progress for, and whether it changed on disk meanwhile. */
  private loadingPageId: string | null = null
  private recheck: string | null = null
  private resumed: Promise<void> | null = null
  private resolveResumed: (() => void) | null = null
  private loadToken = 0
  private loading = false
  private readOnly = false
  /** `${spaceId}/${fileId}` of images known to be stored in that Space's .assets folder. */
  private stored = new Set<string>()
  private viewport: Viewport = { scrollX: 0, scrollY: 0, zoom: 1 }
  private exportOpen = false
  private paperListeners = new Set<(paper: Paper) => void>()
  private remountListeners = new Set<() => void>()
  /** A fresh Excalidraw was asked for and hasn't attached yet. */
  private remounting = false
  private viewportListeners = new Set<(scrollX: number, scrollY: number, zoom: number) => void>()

  constructor() {
    const note = (e: Event) => {
      if (e.isTrusted) this.inputSinceLoad = true
    }
    window.addEventListener('pointerdown', note, true)
    window.addEventListener('keydown', note, true)
  }

  /**
   * Excalidraw's initialData promise, awaited before a page goes into a fresh instance.
   * Made once per mount (StrictMode renders twice): Excalidraw and the controller must
   * share the same promise.
   */
  prepare<T>(make: () => Promise<T>): Promise<T> {
    if (!this.prepared) {
      this.prepared = true
      this.initialData = make()
    }
    return this.initialData as Promise<T>
  }

  attach(api: ExcalidrawImperativeAPI): void {
    if (this.api === api) return
    if (this.api) this.detach()
    this.api = api
    this.remounting = false
    editors.canvas = this
    const pageId = get().pageId
    if (pageId) void this.load(pageId)
  }

  /** Called before Excalidraw unmounts (its scene is emptied right after). */
  detach(): void {
    const api = this.api
    if (!api) return
    // Read now, while the scene is still there (written after a suspend, if one is on).
    if (this.isDirty()) void this.save(true)
    if (editors.canvas === this) editors.canvas = null
    this.prepared = false // a new Excalidraw brings new initialData
    this.loadingPageId = null
    this.recheck = null
    clearTimeout(this.timer)
    this.loadToken++
    this.api = null
    this.loadedApi = null
    this.pageId = null
    this.baseline = 0
    this.baselineCount = 0
    this.forceSave = false
    this.readOnly = false
    this.failed = false
    this.loading = false
    this.exportOpen = false
  }

  /** The library root changed: images must be stored again in the new library. */
  clearStored(): void {
    this.stored.clear()
  }

  /** Canvas.tsx remounts Excalidraw when asked (to free the images it holds). */
  onRemount(cb: () => void): () => void {
    this.remountListeners.add(cb)
    return () => this.remountListeners.delete(cb)
  }

  /** Bytes of image data Excalidraw is holding (base64 data URLs). */
  private heldImageBytes(api: ExcalidrawImperativeAPI): number {
    let bytes = 0
    for (const file of Object.values(api.getFiles())) bytes += file.dataURL.length
    return bytes
  }

  /**
   * Leaving a page while Excalidraw holds too many images: start a fresh instance, which
   * opens the current page with only its own images. Returns true when a remount began.
   */
  private remountIfHeavy(api: ExcalidrawImperativeAPI): boolean {
    if (this.remounting) return true
    if (this.remountListeners.size === 0) return false
    const bytes = this.heldImageBytes(api)
    if (bytes <= IMAGE_BUDGET_BYTES) return false
    if (perf) console.log(`[perf] canvas reset to free ${Math.round(bytes / 1048576)} MB of images`)
    this.remounting = true
    this.prepared = false // the new instance needs its own initialData
    for (const cb of this.remountListeners) cb()
    return true
  }

  currentPage(): string | null {
    return this.loadedApi && this.loadedApi === this.api ? this.pageId : null
  }

  currentPaper(): Paper {
    return this.paper
  }

  onPaperChange(cb: (paper: Paper) => void): () => void {
    this.paperListeners.add(cb)
    return () => this.paperListeners.delete(cb)
  }

  /** Scroll/zoom stream for the paper layer (called on every scroll, so kept trivial). */
  onViewportChange(cb: (scrollX: number, scrollY: number, zoom: number) => void): () => void {
    this.viewportListeners.add(cb)
    cb(this.viewport.scrollX, this.viewport.scrollY, this.viewport.zoom)
    return () => this.viewportListeners.delete(cb)
  }

  readonly emitViewport = (scrollX: number, scrollY: number, zoom: { value: number }): void => {
    for (const cb of this.viewportListeners) cb(scrollX, scrollY, zoom.value)
  }

  setPaper(paper: Paper): void {
    if (paper === this.paper) return
    this.paper = paper
    for (const cb of this.paperListeners) cb(paper)
    if (!this.currentPage() || this.readOnly) return
    this.forceSave = true
    this.forceGen++
    this.markDirty()
  }

  /** Opens one of Excalidraw's own dialogs (image export). */
  openDialog(name: 'imageExport'): void {
    this.api?.updateScene({
      appState: { openDialog: { name } },
      captureUpdate: CaptureUpdateAction.NEVER,
    })
  }

  /** Excalidraw's find-on-canvas lives in its sidebar's search tab. */
  openSearch(): void {
    this.api?.toggleSidebar({ name: 'default', tab: 'search', force: true })
  }

  /** True while something on the canvas is selected, open or being edited (Esc belongs to Excalidraw then). */
  isBusy(): boolean {
    const state = this.api?.getAppState()
    if (!state) return false
    return (
      Object.keys(state.selectedElementIds).length > 0 ||
      state.editingTextElement !== null ||
      state.openDialog !== null ||
      state.openMenu !== null ||
      state.openPopup !== null ||
      state.openSidebar !== null ||
      state.contextMenu !== null ||
      state.multiElement !== null ||
      state.newElement !== null ||
      state.editingLinearElement !== null ||
      state.selectedLinearElement !== null
    )
  }

  // ---------- change tracking ----------

  onChange(elements: readonly ExcalidrawElement[], appState: AppState): void {
    if (this.loading || appState.isLoading || !this.pageId || this.loadedApi !== this.api) return
    this.viewport = {
      scrollX: appState.scrollX,
      scrollY: appState.scrollY,
      zoom: appState.zoom.value,
    }
    this.syncExportBackground(appState)
    if (this.readOnly || hashElementsVersion(elements) === this.baseline) return
    if (this.isSuspiciousWipe()) return
    this.markDirty()
  }

  /**
   * A drawing that turns empty with no pointer or key press since it loaded didn't
   * come from the user (e.g. a late scene reset). Never save that over the page.
   */
  private isSuspiciousWipe(): boolean {
    if (this.baselineCount === 0 || this.inputSinceLoad || !this.api) return false
    if (this.api.getSceneElements().length > 0) return false
    console.warn('[canvas] the drawing emptied without any input; not saving that')
    return true
  }

  private markDirty(): void {
    const state = get().canvasSave
    if (state !== 'dirty' && state !== 'error') set({ canvasSave: 'dirty' })
    clearTimeout(this.timer)
    if (this.suspended === 0) this.timer = setTimeout(() => void this.save(), SAVE_DELAY_MS)
  }

  /**
   * The live canvas is transparent so the paper pattern shows through. While an
   * export dialog is open, swap in solid white so exported images have a background.
   */
  private syncExportBackground(appState: AppState): void {
    const name = appState.openDialog?.name
    const open = name === 'imageExport' || name === 'jsonExport'
    if (open === this.exportOpen) return
    this.exportOpen = open
    const color = open ? String(this.keptAppState.viewBackgroundColor ?? '#ffffff') : 'transparent'
    queueMicrotask(() =>
      this.api?.updateScene({
        appState: { viewBackgroundColor: color },
        captureUpdate: CaptureUpdateAction.NEVER,
      }),
    )
  }

  isDirty(): boolean {
    const api = this.api
    if (!api || !this.pageId || this.readOnly || this.loadedApi !== api) return false
    if (this.forceSave) return true
    if (hashElementsVersion(api.getSceneElementsIncludingDeleted()) === this.baseline) return false
    return !this.isSuspiciousWipe()
  }

  hasFailedSave(): boolean {
    return this.failed
  }

  // ---------- saving ----------

  async snapshot(): Promise<string | null> {
    const c = this.capture()
    if (!c) return null
    // New images go to .assets first, so the copy shows them too.
    await this.storeNewImages(c).catch((err: unknown) => console.warn(err))
    return c.json
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
    if (this.isDirty()) this.markDirty()
  }

  async flush(): Promise<void> {
    if (this.resumed) await this.resumed
    if (this.saving) await this.saving
    if (this.isDirty()) await this.save()
    // The viewport of the open page survives a quit.
    const pageId = this.currentPage()
    if (pageId) this.rememberViewport(pageId)
  }

  private capture(): Capture | null {
    const api = this.api
    const pageId = this.pageId
    if (!api || !pageId || this.readOnly || this.loadedApi !== api) return null
    const elements = api.getSceneElements()
    return {
      api,
      pageId,
      version: hashElementsVersion(api.getSceneElementsIncludingDeleted()),
      count: elements.length,
      forceGen: this.forceGen,
      elements,
      files: api.getFiles(),
      json: serializeScene(pageId, elements, this.keptAppState, this.paper),
      text: getTextFromElements(elements),
    }
  }

  /**
   * Captures the scene now and writes it after any save already in flight. While
   * suspended nothing is written; `always` still captures (the editor is going away)
   * and writes once the suspend ends.
   */
  private save(always = false): Promise<void> {
    clearTimeout(this.timer)
    const c = this.suspended === 0 || always ? this.capture() : null
    if (!c) return this.saving ?? Promise.resolve()
    const resumed = this.resumed ?? Promise.resolve()
    const task = Promise.all([this.saving, resumed]).then(() => this.write(c))
    const tracked = task.finally(() => {
      if (this.saving === tracked) this.saving = null
    })
    this.saving = tracked
    return tracked
  }

  private async write(c: Capture): Promise<void> {
    const current = () => this.api === c.api && this.pageId === c.pageId
    if (current()) set({ canvasSave: 'saving' })
    try {
      await this.storeNewImages(c)
      await window.zenbook.page.saveScene(c.pageId, c.json, c.text)
      if (!current()) return
      this.baseline = c.version
      this.baselineCount = c.count
      if (this.forceGen === c.forceGen) this.forceSave = false
      this.failed = false
      setBanner('canvas', null)
      set({ canvasSave: this.isDirty() ? 'dirty' : 'saved' })
    } catch (err) {
      console.error('[canvas] save failed', err)
      if (!current()) {
        // Only when the page was left anyway (deleted, or the editor went away).
        if (locatePage(get().tree, c.pageId))
          showToast({ message: 'Couldn’t save the last changes to the previous page.' })
        return
      }
      // Keep the edits and keep trying, even if the page seems gone for the moment
      // (moved or renamed by a sync tool): leaving it is what lets them go.
      this.failed = true
      const missing = !locatePage(get().tree, c.pageId)
      setBanner(
        'canvas',
        missing
          ? 'This page can’t be found on disk right now, so your latest drawing isn’t saved yet. Retrying…'
          : 'Couldn’t save this page. Retrying in a moment…',
      )
      set({ canvasSave: 'error' })
      clearTimeout(this.timer)
      this.timer = setTimeout(() => void this.save(), RETRY_DELAY_MS)
    }
  }

  /** Images go to disk once per Space, by content hash; routine saves never carry image data. */
  private async storeNewImages(c: Capture): Promise<void> {
    const spaceId = locatePage(get().tree, c.pageId)?.space.id ?? ''
    const fresh: BinaryFileData[] = []
    const seen = new Set<string>()
    for (const el of c.elements) {
      if (el.type !== 'image' || !el.fileId || seen.has(el.fileId)) continue
      seen.add(el.fileId)
      if (this.stored.has(`${spaceId}/${el.fileId}`)) continue
      const file = c.files[el.fileId]
      if (file?.dataURL) fresh.push(file)
    }
    if (fresh.length === 0) return
    await window.zenbook.assets.put(
      c.pageId,
      fresh.map((f) => ({ id: f.id, mimeType: f.mimeType, dataURL: f.dataURL })),
    )
    for (const f of fresh) this.stored.add(`${spaceId}/${f.id}`)
  }

  // ---------- loading ----------

  /** Resolves once Excalidraw has finished its own start-up (which replaces the scene). */
  private ready(api: ExcalidrawImperativeAPI): Promise<void> {
    return this.initialData
      .catch(() => undefined)
      .then(
        () =>
          new Promise<void>((resolve) => {
            const waiting = () => this.api === api && api.getAppState().isLoading
            if (!waiting()) return resolve()
            const done = () => {
              off()
              clearInterval(poll)
              resolve()
            }
            const off = api.onChange((_elements, state) => {
              if (!state.isLoading) done()
            })
            const poll = setInterval(() => !waiting() && done(), 100)
          }),
      )
  }

  /** The previous page couldn't be saved: stay on it rather than lose its edits. */
  private blocked(previous: string): boolean {
    return this.failed && this.isDirty() && locatePage(get().tree, previous) !== null
  }

  async load(pageId: string, discard = false, keepViewport = false): Promise<void> {
    const api = this.api
    if (!api) return
    const token = ++this.loadToken
    // Already showing it (e.g. after staying on a page whose save failed).
    if (!discard && !this.readOnly && this.currentPage() === pageId) return
    const started = performance.now()
    const previous = this.currentPage()
    const stale = () => token !== this.loadToken || this.api !== api

    if (!discard) {
      await this.flush()
      if (stale()) return
      if (previous && previous !== pageId && this.blocked(previous)) {
        if (!(await mayLeave(previous))) return
        if (stale()) return
      }
      // Everything is saved now; the fresh instance loads the current page when it attaches.
      if (previous !== pageId && this.remountIfHeavy(api)) return
    }
    this.loadingPageId = pageId
    if (previous && previous !== pageId) this.rememberViewport(previous)

    const opening = openPageData(pageId)
    opening.catch(() => undefined) // handled below; this load may be superseded first
    await this.ready(api)
    let data: PageData
    try {
      data = await opening
    } catch {
      if (stale()) return
      this.keepLateEdits(previous, pageId, discard)
      this.showUnreadable(
        api,
        pageId,
        'This page’s file couldn’t be read. It may still be syncing.',
      )
      this.loaded(pageId)
      return
    }
    if (stale()) return
    this.keepLateEdits(previous, pageId, discard)

    let scene
    try {
      scene = parseScene(data.scene)
    } catch (err) {
      this.showUnreadable(api, pageId, `${(err as Error).message} Zenbook won’t change it.`)
      this.loaded(pageId)
      return
    }

    const elements = restoreElements(scene.elements as ExcalidrawElement[], null, {
      refreshDimensions: false,
      repairBindings: true,
    })
    const saved = keepViewport ? this.viewport : get().prefs.viewports[pageId]
    const viewport = saved ?? { scrollX: 0, scrollY: 0, zoom: 1 }
    // Leaving a page with a failed save only gets here when that page is gone (or on a
    // reload, which discards local edits on purpose): its error no longer applies.
    clearTimeout(this.timer)
    this.failed = false
    setBanner('canvas', null)
    this.loading = true
    this.pageId = pageId
    this.readOnly = false
    this.keptAppState = scene.appState
    this.paper = scene.paper
    for (const cb of this.paperListeners) cb(scene.paper)

    api.updateScene({
      elements,
      appState: {
        viewBackgroundColor: 'transparent',
        viewModeEnabled: false,
        scrollX: viewport.scrollX,
        scrollY: viewport.scrollY,
        zoom: { value: viewport.zoom } as Zoom,
        selectedElementIds: {},
        editingTextElement: null,
        openDialog: null,
      },
      captureUpdate: CaptureUpdateAction.NEVER,
    })
    api.history.clear()
    if (!saved && elements.length > 0) {
      // First visit: fit the drawing with a calm margin, but never blow small drawings up.
      api.scrollToContent(elements, {
        fitToViewport: true,
        viewportZoomFactor: 0.8,
        animate: false,
      })
      if (api.getAppState().zoom.value > 1) {
        api.updateScene({
          appState: { zoom: { value: 1 } as Zoom },
          captureUpdate: CaptureUpdateAction.NEVER,
        })
        api.scrollToContent(elements, { animate: false })
      }
    }
    const state = api.getAppState()
    this.viewport = { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value }
    this.emitViewport(state.scrollX, state.scrollY, state.zoom)

    // Images embedded in the file (e.g. made on excalidraw.com) migrate to .assets on the next save.
    const embedded = Object.values(scene.files)
    if (embedded.length > 0) {
      api.addFiles(embedded as BinaryFileData[])
      this.forceSave = true
      this.forceGen++
    } else {
      this.forceSave = false
    }
    this.baseline = hashElementsVersion(api.getSceneElementsIncludingDeleted())
    this.baselineCount = api.getSceneElements().length
    this.inputSinceLoad = false
    this.loadedApi = api
    this.loading = false
    setBanner('unreadable', null)
    set({ canvasSave: this.forceSave ? 'dirty' : 'saved' })
    if (this.forceSave) this.markDirty()
    this.loaded(pageId)
    // Measured to the next painted frame: what the user actually perceives.
    if (perf) {
      // Two frames: Excalidraw draws in the first, the second runs after it was painted.
      requestAnimationFrame(() =>
        requestAnimationFrame(() =>
          console.log(
            `[perf] page open: ${Math.round(performance.now() - started)} ms (${elements.length} elements)`,
          ),
        ),
      )
    }

    await this.loadImages(api, pageId, elements)
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
    const api = this.api
    if (!api || this.currentPage() !== pageId) return
    clearTimeout(this.timer)
    this.baseline = hashElementsVersion(api.getSceneElementsIncludingDeleted())
    this.baselineCount = api.getSceneElements().length
    this.forceSave = false
    this.failed = false
    setBanner('canvas', null)
    set({ canvasSave: 'saved' })
  }

  /** Strokes drawn while the next page was opening still belong to the previous page. */
  private keepLateEdits(previous: string | null, pageId: string, discard: boolean): void {
    if (discard || !previous || previous === pageId || this.pageId !== previous) return
    if (this.isDirty()) void this.save() // captures the scene before it is replaced
  }

  /** No page is open (an empty Space, or the last page was deleted). */
  async unload(): Promise<void> {
    const api = this.api
    if (!api) return
    const token = ++this.loadToken
    const previous = this.currentPage()
    await this.flush()
    if (token !== this.loadToken || this.api !== api) return
    if (previous && this.blocked(previous)) {
      if (!(await mayLeave(previous))) return
      if (token !== this.loadToken || this.api !== api) return
    }
    if (this.isDirty()) void this.save()
    clearTimeout(this.timer)
    this.loadingPageId = null
    this.pageId = null
    this.readOnly = false
    this.failed = false
    this.forceSave = false
    setBanner('canvas', null)
    set({ canvasSave: 'saved' })
    await this.ready(api)
    if (token !== this.loadToken || this.api !== api) return
    this.loading = true
    api.updateScene({
      elements: [],
      appState: {
        viewModeEnabled: true,
        selectedElementIds: {},
        editingTextElement: null,
        openDialog: null,
      },
      captureUpdate: CaptureUpdateAction.NEVER,
    })
    api.history.clear()
    this.loading = false
  }

  private async loadImages(
    api: ExcalidrawImperativeAPI,
    pageId: string,
    elements: readonly ExcalidrawElement[],
  ): Promise<void> {
    const have = api.getFiles()
    const missing = [
      ...new Set(
        elements.flatMap((el) =>
          el.type === 'image' && el.fileId && !have[el.fileId] ? [el.fileId] : [],
        ),
      ),
    ]
    if (missing.length === 0) return
    const spaceId = locatePage(get().tree, pageId)?.space.id ?? ''
    let files
    try {
      files = await window.zenbook.assets.get(pageId, missing)
    } catch (err) {
      console.warn('[canvas] images couldn’t be read', err)
      return
    }
    if (this.pageId !== pageId || this.api !== api) return
    api.addFiles(files.map((f) => ({ ...f, created: Date.now() }) as BinaryFileData))
    for (const f of files) this.stored.add(`${spaceId}/${f.id}`)
  }

  private showUnreadable(api: ExcalidrawImperativeAPI, pageId: string, message: string): void {
    clearTimeout(this.timer)
    this.pageId = pageId
    this.readOnly = true
    this.failed = false
    this.forceSave = false
    this.loadedApi = api
    this.loading = true
    api.updateScene({
      elements: [],
      appState: { viewModeEnabled: true },
      captureUpdate: CaptureUpdateAction.NEVER,
    })
    this.loading = false
    setBanner('canvas', null)
    setBanner('unreadable', message)
    set({ canvasSave: 'saved' })
  }

  private rememberViewport(pageId: string): void {
    const { viewports } = get().prefs
    const known = viewports[pageId]
    const vp = this.viewport
    if (
      known &&
      known.scrollX === vp.scrollX &&
      known.scrollY === vp.scrollY &&
      known.zoom === vp.zoom
    )
      return
    setPrefs({ viewports: recordViewport(viewports, pageId, { ...vp }, MAX_VIEWPORTS) })
  }

  reload(pageId: string): Promise<void> {
    if (!this.api || this.currentPage() !== pageId) return Promise.resolve()
    clearTimeout(this.timer)
    this.forceSave = false
    return this.load(pageId, true, true)
  }
}

export const canvas = new CanvasController()

// Assets are stored per library (and per Space): forget what was stored in the old one.
useStore.subscribe((s, prev) => {
  if (s.root !== prev.root) canvas.clearStored()
})
