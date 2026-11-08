import { join } from 'node:path'
import {
  BrowserWindow,
  nativeTheme,
  screen,
  type BrowserWindowConstructorOptions,
  type TitleBarOverlayOptions,
} from 'electron'
import { windowColors } from '../shared/theme'
import { perf } from './perf'
import { APP_URL } from './protocol'
import { fitBounds, saveState, type UiState } from './state'

/** Height of the draggable strip at the top; matches --strip-height in tokens.css. */
const STRIP_HEIGHT = 40

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

export function createMainWindow(state: UiState): BrowserWindow {
  const bounds = fitBounds(
    state.window.bounds,
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
    if (state.window.maximized) win.maximize()
    win.show()
    perf('window shown')
  })

  const onThemeChange = (): void => {
    win.setBackgroundColor(colors().bg)
    if (process.platform === 'win32') win.setTitleBarOverlay(overlay())
  }
  nativeTheme.on('updated', onThemeChange)
  win.on('closed', () => nativeTheme.off('updated', onThemeChange))

  win.on('close', () => {
    saveState({
      ...state,
      window: { bounds: win.getNormalBounds(), maximized: win.isMaximized() },
    })
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  void win.loadURL(devUrl ?? APP_URL)
  return win
}
