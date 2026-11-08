import { join } from 'node:path'
import { app, type BrowserWindow } from 'electron'
import { applyTheme, registerIpc } from './ipc'
import { installDevShortcuts, installMenu } from './menu'
import { perf } from './perf'
import { handleAppProtocol, registerAppScheme } from './protocol'
import { hardenSecurity } from './security'
import { Session } from './session'
import { StateStore } from './state'
import { createUpdates } from './updater'
import { createMainWindow, flushRenderer } from './window'

// Tests and fixture runs get an isolated profile. Ignored in packaged builds.
// Must run before the single-instance lock, which is keyed on userData.
if (!app.isPackaged && process.env.ZENBOOK_USER_DATA) {
  app.setPath('userData', process.env.ZENBOOK_USER_DATA)
}

registerAppScheme()

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  let mainWindow: BrowserWindow | null = null
  const store = new StateStore(join(app.getPath('userData'), 'state.json'))
  const send = (channel: string, ...args: unknown[]) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args)
  }
  const session = new Session(store, send)
  const updates = createUpdates(store, () => mainWindow)

  // Start reading the library straight away, in parallel with creating the window.
  void session.status()

  const openWindow = (): void => {
    const win = createMainWindow(store)
    installDevShortcuts(win)
    win.on('closed', () => {
      mainWindow = null
    })
    mainWindow = win
  }

  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  // macOS: clicking the Dock icon with no windows open reopens one.
  app.on('activate', () => {
    if (app.isReady() && !mainWindow) openWindow()
  })

  // Never lose a stroke: save the page, finish pending deletes and writes, then quit.
  let shutDown = false
  app.on('before-quit', (event) => {
    if (shutDown) return
    event.preventDefault()
    void (async () => {
      try {
        if (mainWindow) await flushRenderer(mainWindow)
        await session.close()
      } finally {
        store.saveNow()
        shutDown = true
        app.quit()
      }
    })()
  })

  void app.whenReady().then(() => {
    perf('app ready')
    applyTheme(store.data.prefs.theme)
    hardenSecurity()
    handleAppProtocol(join(__dirname, '../renderer'))
    installMenu()
    registerIpc({ session, store, updates, window: () => mainWindow })
    openWindow()
    updates.start()
  })
}
