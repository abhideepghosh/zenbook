import { join } from 'node:path'
import {
  BrowserWindow,
  ipcMain,
  nativeTheme,
  screen,
  type BrowserWindowConstructorOptions,
  type TitleBarOverlayOptions,
} from 'electron'
import { Channels } from '../shared/channels'
import { windowColors } from '../shared/theme'
import { perf } from './perf'
import { APP_URL } from './protocol'
import { fitBounds, type StateStore } from './state'

/** Height of the draggable strip at the top; matches --strip-height in tokens.css. */
const STRIP_HEIGHT = 40
const FLUSH_TIMEOUT_MS = 3000

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
      return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 13 } }
    case 'win32':
      return { titleBarStyle: 'hidden', titleBarOverlay: overlay() }
    default:
      return {}
  }
}

/** Asks the renderer to save everything it has, waiting at most a few seconds. */
export function flushRenderer(win: BrowserWindow): Promise<void> {
  if (win.isDestroyed() || win.webContents.isLoading()) return Promise.resolve()
  return new Promise((resolve) => {
    const done = (event?: Electron.IpcMainEvent) => {
      if (event && event.sender !== win.webContents) return
      clearTimeout(timer)
      ipcMain.removeListener(Channels.flushed, done)
      resolve()
    }
    const timer = setTimeout(done, FLUSH_TIMEOUT_MS)
    ipcMain.on(Channels.flushed, done)
    win.webContents.send(Channels.flush)
  })
}

export function createMainWindow(store: StateStore): BrowserWindow {
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
      spellcheck: true,
    },
  })

  win.once('ready-to-show', () => {
    if (saved.maximized) win.maximize()
    win.show()
    perf('window shown')
  })

  const onThemeChange = (): void => {
    win.setBackgroundColor(colors().bg)
    if (process.platform === 'win32') win.setTitleBarOverlay(overlay())
  }
  nativeTheme.on('updated', onThemeChange)
  win.on('closed', () => nativeTheme.off('updated', onThemeChange))

  // Save the open page before the window goes away, then let it close.
  let flushed = false
  win.on('close', (event) => {
    store.update(
      (s) => (s.window = { bounds: win.getNormalBounds(), maximized: win.isMaximized() }),
    )
    if (flushed) return
    event.preventDefault()
    void flushRenderer(win).finally(() => {
      flushed = true
      win.close()
    })
  })

  // A blurred window is a natural moment to save (the user went elsewhere).
  win.on('blur', () => {
    if (!win.webContents.isLoading()) win.webContents.send(Channels.flush)
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  void win.loadURL(devUrl ?? APP_URL)
  return win
}
