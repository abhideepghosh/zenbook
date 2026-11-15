import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeTheme,
  screen,
  type BrowserWindowConstructorOptions,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
  type TitleBarOverlayOptions,
  type WebContents,
} from 'electron'
import iconIco from '../../build/icon.ico?asset'
import iconPng from '../../build/icon-window.png?asset'
import { Channels } from '../shared/channels'
import { windowColors } from '../shared/theme'
import { perf } from './perf'
import { APP_URL } from './protocol'
import type { Shutdown } from './shutdown'
import { fitBounds, type StateStore } from './state'

/** Height of the draggable strip at the top; matches --strip-height in tokens.css. */
const STRIP_HEIGHT = 40
const FLUSH_TIMEOUT_MS = 3000
/** Show the window even if the first paint never comes, so it is never invisible. */
const SHOW_FALLBACK_MS = 5000
/** Reload a crashed renderer, but stop if it keeps crashing (a crash loop helps nobody). */
const MAX_RELOADS = 3
const RELOAD_WINDOW_MS = 60_000

function colors(): { bg: string; text: string } {
  return nativeTheme.shouldUseDarkColors ? windowColors.dark : windowColors.light
}

function overlay(): TitleBarOverlayOptions {
  const { bg, text } = colors()
  return { color: bg, symbolColor: text, height: STRIP_HEIGHT }
}

/** Frameless on macOS and Windows (our strip is the title bar); native frame on Linux. */
function chrome(): BrowserWindowConstructorOptions {
  switch (process.platform) {
    case 'darwin':
      // The window icon comes from the app bundle.
      return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 13 } }
    case 'win32':
      return { titleBarStyle: 'hidden', titleBarOverlay: overlay(), icon: iconIco }
    default:
      return { icon: iconPng }
  }
}

function canFlush(contents: WebContents): boolean {
  return !contents.isDestroyed() && !contents.isCrashed() && !contents.isLoading()
}

let flushSeq = 0

/** Asks the renderer to save, returning the id its acknowledgement will carry. */
function requestFlush(contents: WebContents): number {
  flushSeq += 1
  contents.send(Channels.flush, flushSeq)
  return flushSeq
}

/**
 * Asks the renderer to save everything it has, waiting at most a few seconds.
 * Resolves only on the acknowledgement of this request (not an earlier blur flush).
 */
export function flushRenderer(win: BrowserWindow): Promise<void> {
  if (win.isDestroyed() || !canFlush(win.webContents)) return Promise.resolve()
  const contents = win.webContents
  return new Promise((resolve) => {
    let id = -1
    const finish = (): void => {
      clearTimeout(timer)
      ipcMain.removeListener(Channels.flushed, onFlushed)
      contents.removeListener('render-process-gone', finish)
      contents.removeListener('destroyed', finish)
      resolve()
    }
    const onFlushed = (event: Electron.IpcMainEvent, ack: unknown): void => {
      if (event.sender === contents && ack === id) finish()
    }
    const timer = setTimeout(finish, FLUSH_TIMEOUT_MS)
    ipcMain.on(Channels.flushed, onFlushed)
    // A renderer that dies mid-flush will never answer: don't wait for the timeout.
    contents.once('render-process-gone', finish)
    contents.once('destroyed', finish)
    id = requestFlush(contents)
  })
}

/** Remembers where the window is, for the next launch (written by the next save). */
export function saveWindowState(win: BrowserWindow, store: StateStore): void {
  if (win.isDestroyed()) return
  store.update((s) => (s.window = { bounds: win.getNormalBounds(), maximized: win.isMaximized() }))
}

/**
 * Spelling suggestions and cut/copy/paste for text fields. Zenbook's own rows and the
 * canvas cancel the DOM contextmenu event, so Electron never asks us about them.
 */
function editMenu(contents: WebContents, params: ContextMenuParams): Menu | null {
  const { editFlags, isEditable, misspelledWord, dictionarySuggestions, selectionText } = params
  if (!isEditable && !selectionText.trim()) return null

  const items: MenuItemConstructorOptions[] = []
  if (isEditable && misspelledWord) {
    for (const word of dictionarySuggestions) {
      items.push({ label: word, click: () => contents.replaceMisspelling(word) })
    }
    if (dictionarySuggestions.length === 0) items.push({ label: 'No suggestions', enabled: false })
    items.push(
      {
        label: 'Add to Dictionary',
        click: () => contents.session.addWordToSpellCheckerDictionary(misspelledWord),
      },
      { type: 'separator' },
    )
  }
  if (isEditable) {
    items.push(
      { role: 'cut', enabled: editFlags.canCut },
      { role: 'copy', enabled: editFlags.canCopy },
      { role: 'paste', enabled: editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll', enabled: editFlags.canSelectAll },
    )
  } else {
    items.push({ role: 'copy', enabled: editFlags.canCopy })
  }
  return Menu.buildFromTemplate(items)
}

export function createMainWindow(store: StateStore, shutdown: Shutdown): BrowserWindow {
  const saved = store.data.window
  const bounds = fitBounds(
    saved.bounds,
    screen.getAllDisplays().map((d) => d.workArea),
  )
  const win = new BrowserWindow({
    ...(bounds ?? { width: 1280, height: 800 }),
    minWidth: 720,
    minHeight: 480,
    title: 'Zenbook',
    // Hidden until the first frame is painted, on a theme-matched background: no white flash.
    show: false,
    backgroundColor: colors().bg,
    ...chrome(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // On Linux, Chromium would download Hunspell dictionaries from Google: stay local-first.
      spellcheck: process.platform !== 'linux',
    },
  })
  const contents = win.webContents

  let shown = false
  const showOnce = (why: string): void => {
    if (shown || win.isDestroyed()) return
    shown = true
    clearTimeout(showFallback)
    if (saved.maximized) win.maximize()
    win.show()
    perf(`window shown (${why})`)
  }
  win.once('ready-to-show', () => showOnce('ready'))
  const showFallback = setTimeout(() => showOnce('fallback'), SHOW_FALLBACK_MS)
  contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame) return
    console.error(`[window] failed to load ${url}: ${code} ${description}`)
    showOnce('load failed')
  })

  // A crashed renderer comes back by itself; what it saved is already on disk.
  const reloads: number[] = []
  contents.on('render-process-gone', (_event, details) => {
    console.error(`[window] renderer gone: ${details.reason} (exit ${details.exitCode})`)
    if (details.reason === 'clean-exit' || shutdown.phase() !== 'idle' || win.isDestroyed()) return
    const now = Date.now()
    while (reloads.length > 0 && now - reloads[0]! > RELOAD_WINDOW_MS) reloads.shift()
    if (reloads.length >= MAX_RELOADS) return
    reloads.push(now)
    contents.reload()
  })

  contents.on('context-menu', (_event, params) => {
    editMenu(contents, params)?.popup({ window: win })
  })

  const onThemeChange = (): void => {
    win.setBackgroundColor(colors().bg)
    if (process.platform === 'win32') win.setTitleBarOverlay(overlay())
  }
  nativeTheme.on('updated', onThemeChange)
  win.on('closed', () => {
    clearTimeout(showFallback)
    nativeTheme.off('updated', onThemeChange)
  })

  // Save the open page before the window goes away, then let it close.
  // While the app quits, the shutdown routine does the saving instead.
  let flushed = false
  let flushing = false
  win.on('close', (event) => {
    const phase = shutdown.phase()
    if (phase === 'done') return
    if (phase === 'running') {
      // Still saving: closing now could cut that short. The app quits when it is done.
      event.preventDefault()
      return
    }
    saveWindowState(win, store)
    if (flushed) return
    event.preventDefault()
    if (flushing) return
    flushing = true
    void flushRenderer(win).finally(() => {
      flushed = true
      if (!win.isDestroyed()) win.close()
    })
  })

  // A blurred window is a natural moment to save (the user went elsewhere).
  win.on('blur', () => {
    if (canFlush(contents)) requestFlush(contents)
  })

  if (process.platform === 'win32') {
    // Windows shut-down and log-off never emit before-quit. When Windows asks, start
    // saving without blocking it (the user chose to shut down). When the session really
    // ends there is no more time for async work: write the state file and try our best.
    win.on('query-session-end', () => {
      if (canFlush(contents)) requestFlush(contents)
      saveWindowState(win, store)
      store.saveNow()
    })
    win.on('session-end', () => {
      saveWindowState(win, store)
      store.saveNow()
      void shutdown.run()
    })
  }

  // The dev server URL is only honoured in development builds.
  const devUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL
  void win.loadURL(devUrl ?? APP_URL)
  return win
}
