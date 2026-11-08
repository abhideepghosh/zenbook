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
  ExcalidrawImperativeAPI,
} from '@excalidraw/excalidraw/types'
import type { Paper, Viewport } from '../../../shared/api'
import { editors, type PageEditor } from '../editors'
import { get, set, setPrefs } from '../store'
import { locatePage } from '../tree'
import { parseScene, serializeScene, type KeptAppState } from './scene'

const SAVE_DELAY_MS = 800
const RETRY_DELAY_MS = 3000
const perf = import.meta.env.DEV || window.zenbook.perf

type Zoom = AppState['zoom']

/**
 * Owns the one Excalidraw instance: loading pages into it and saving them out.
 * Lives outside React so typing and drawing never cause React work: onChange only
 * compares a version hash and (re)starts a timer.
 */
class CanvasController implements PageEditor {
  private api: ExcalidrawImperativeAPI | null = null
  private pageId: string | null = null
  private baseline = 0
  private paper: Paper = 'plain'
  private keptAppState: KeptAppState = {}
  private forceSave = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private saving: Promise<void> | null = null
  private loadToken = 0
  private loading = false
  private readOnly = false
  /** File IDs known to be stored in the Space's .assets folder. */
  private stored = new Set<string>()
  private viewport: Viewport = { scrollX: 0, scrollY: 0, zoom: 1 }
  private exportOpen = false
  private paperListeners = new Set<(paper: Paper) => void>()
  private viewportListeners = new Set<(scrollX: number, scrollY: number, zoom: number) => void>()

  attach(api: ExcalidrawImperativeAPI): void {
    this.api = api
    editors.canvas = this
    const pageId = get().pageId
    if (pageId) void this.load(pageId)
  }

  detach(): void {
    if (editors.canvas === this) editors.canvas = null
    this.api = null
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
    if (!this.pageId || this.readOnly) return
    this.forceSave = true
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

  /** True while something on the canvas is selected or being edited (Esc belongs to Excalidraw then). */
  isBusy(): boolean {
    const state = this.api?.getAppState()
    if (!state) return false
    return (
      Object.keys(state.selectedElementIds).length > 0 ||
      state.editingTextElement !== null ||
      state.openDialog !== null
    )
  }

  // ---------- change tracking ----------

  onChange(elements: readonly ExcalidrawElement[], appState: AppState): void {
    if (this.loading || !this.pageId) return
    this.viewport = {
      scrollX: appState.scrollX,
      scrollY: appState.scrollY,
      zoom: appState.zoom.value,
    }
    this.syncExportBackground(appState)
    if (this.readOnly) return
    if (hashElementsVersion(elements) !== this.baseline) this.markDirty()
  }

  private markDirty(): void {
    if (get().saveState !== 'dirty') set({ saveState: 'dirty' })
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.save(), SAVE_DELAY_MS)
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
    if (!this.api || !this.pageId || this.readOnly) return false
    return (
      this.forceSave ||
      hashElementsVersion(this.api.getSceneElementsIncludingDeleted()) !== this.baseline
    )
  }

  // ---------- saving ----------

  snapshot(): string | null {
    if (!this.api || !this.pageId) return null
    return serializeScene(this.pageId, this.api.getSceneElements(), this.keptAppState, this.paper)
  }

  async flush(): Promise<void> {
    if (this.saving) await this.saving
    if (this.isDirty()) await this.save()
  }

  private save(): Promise<void> {
    clearTimeout(this.timer)
    if (this.saving) return this.saving.then(() => (this.isDirty() ? this.save() : undefined))
    const api = this.api
    const pageId = this.pageId
    if (!api || !pageId || this.readOnly) return Promise.resolve()

    const task = (async () => {
      const all = api.getSceneElementsIncludingDeleted()
      const version = hashElementsVersion(all)
      const elements = api.getSceneElements()
      set({ saveState: 'saving' })
      try {
        await this.storeNewImages(pageId, elements)
        const json = serializeScene(pageId, elements, this.keptAppState, this.paper)
        await window.zenbook.page.saveScene(pageId, json, getTextFromElements(elements))
        if (this.pageId === pageId) {
          this.baseline = version
          this.forceSave = false
        }
        set({
          saveState: this.isDirty() ? 'dirty' : 'saved',
          banner: get().banner?.startsWith('Couldn’t save') ? null : get().banner,
        })
      } catch {
        // The page was deleted (here or by another app): there is nothing left to save to.
        if (!locatePage(get().tree, pageId)) {
          if (this.pageId === pageId) this.forget()
          set({ saveState: 'saved' })
          return
        }
        set({ saveState: 'error', banner: 'Couldn’t save this page. Retrying in a moment…' })
        clearTimeout(this.timer)
        this.timer = setTimeout(() => void this.save(), RETRY_DELAY_MS)
      }
    })()
    this.saving = task.finally(() => {
      this.saving = null
    })
    return this.saving
  }

  /** Images go to disk once, by content hash; routine saves never carry image data. */
  private async storeNewImages(
    pageId: string,
    elements: readonly NonDeletedExcalidrawElement[],
  ): Promise<void> {
    const files = this.api?.getFiles() ?? {}
    const fresh: BinaryFileData[] = []
    for (const el of elements) {
      if (el.type !== 'image' || !el.fileId || this.stored.has(el.fileId)) continue
      const file = files[el.fileId]
      if (file?.dataURL) fresh.push(file)
    }
    if (fresh.length === 0) return
    await window.zenbook.assets.put(
      pageId,
      fresh.map((f) => ({ id: f.id, mimeType: f.mimeType, dataURL: f.dataURL })),
    )
    for (const f of fresh) this.stored.add(f.id)
  }

  // ---------- loading ----------

  async load(pageId: string, keepViewport = false): Promise<void> {
    const api = this.api
    if (!api) return
    const token = ++this.loadToken
    const started = performance.now()
    const previous = this.pageId
    await this.flush()
    if (token !== this.loadToken) return
    if (previous && previous !== pageId) this.rememberViewport(previous)

    this.loading = true
    let data
    try {
      data = await window.zenbook.page.open(pageId)
    } catch {
      if (token !== this.loadToken) return
      this.showUnreadable(pageId, 'This page’s file couldn’t be read. It may still be syncing.')
      return
    }
    if (token !== this.loadToken) return

    let scene
    try {
      scene = parseScene(data.scene)
    } catch (err) {
      this.showUnreadable(pageId, `${(err as Error).message} Zenbook won’t change it.`)
      return
    }

    const elements = restoreElements(scene.elements as ExcalidrawElement[], null, {
      refreshDimensions: false,
      repairBindings: true,
    })
    const saved = keepViewport ? this.viewport : get().prefs.viewports[pageId]
    const viewport = saved ?? { scrollX: 0, scrollY: 0, zoom: 1 }
    clearTimeout(this.timer)
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
    this.viewport = viewport
    const state = api.getAppState()
    this.emitViewport(state.scrollX, state.scrollY, state.zoom)

    // Images embedded in the file (e.g. made on excalidraw.com) migrate to .assets on the next save.
    const embedded = Object.values(scene.files)
    if (embedded.length > 0) {
      api.addFiles(embedded as BinaryFileData[])
      this.forceSave = true
    } else {
      this.forceSave = false
    }
    this.baseline = hashElementsVersion(api.getSceneElementsIncludingDeleted())
    this.loading = false
    set({ saveState: this.forceSave ? 'dirty' : 'saved' })
    if (this.forceSave) this.markDirty()
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

    await this.loadImages(pageId, elements)
  }

  private async loadImages(pageId: string, elements: readonly ExcalidrawElement[]): Promise<void> {
    const api = this.api
    if (!api) return
    const have = api.getFiles()
    const missing = [
      ...new Set(
        elements.flatMap((el) =>
          el.type === 'image' && el.fileId && !have[el.fileId] ? [el.fileId] : [],
        ),
      ),
    ]
    if (missing.length === 0) return
    const files = await window.zenbook.assets.get(pageId, missing)
    if (this.pageId !== pageId || !this.api) return
    this.api.addFiles(files.map((f) => ({ ...f, created: Date.now() }) as BinaryFileData))
    for (const f of files) this.stored.add(f.id)
  }

  private showUnreadable(pageId: string, message: string): void {
    this.pageId = pageId
    this.readOnly = true
    this.loading = false
    this.api?.updateScene({
      elements: [],
      appState: { viewModeEnabled: true },
      captureUpdate: CaptureUpdateAction.NEVER,
    })
    set({ banner: message, saveState: 'saved' })
  }

  private rememberViewport(pageId: string): void {
    setPrefs({ viewports: { ...get().prefs.viewports, [pageId]: this.viewport } })
  }

  reload(): Promise<void> {
    const pageId = this.pageId
    clearTimeout(this.timer)
    this.forceSave = false
    if (!pageId || !this.api) return Promise.resolve()
    this.baseline = hashElementsVersion(this.api.getSceneElementsIncludingDeleted()) // drop local edits
    return this.load(pageId, true)
  }

  /** Called when the page itself is deleted: nothing left to save. */
  forget(): void {
    clearTimeout(this.timer)
    this.pageId = null
  }
}

export const canvas = new CanvasController()
