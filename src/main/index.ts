import { join } from 'node:path'
import { app, type BrowserWindow } from 'electron'
import { applyTheme, registerIpc } from './ipc'
import { installDevShortcuts, installMenu } from './menu'
import { perf } from './perf'
import { handleAppProtocol, registerAppScheme } from './protocol'
import { hardenSecurity } from './security'
import { Session } from './session'
import { createShutdown } from './shutdown'
import { StateStore } from './state'
import { createUpdates } from './updater'
import { createMainWindow } from './window'

// Log, never crash: without a listener Node turns this into an error dialog.
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandled rejection:', reason)
})

// Tests and fixture runs get an isolated profile. Ignored in packaged builds.
// Must run before the single-instance lock, which is keyed on userData.
if (!app.isPackaged && process.env.ZENBOOK_USER_DATA) {
  app.setPath('userData', process.env.ZENBOOK_USER_DATA)
}

// Windows groups taskbar buttons and picks their icon by this id (the appId of the
// installed build; dev runs use the Electron binary's own).
if (process.platform === 'win32') {
  app.setAppUserModelId(app.isPackaged ? 'io.github.abhideepghosh.zenbook' : process.execPath)
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
  const shutdown = createShutdown({ store, session, window: () => mainWindow })
  const updates = createUpdates(store, () => mainWindow, shutdown)

  // Start reading the library straight away, in parallel with creating the window.
  void session.status()

  const openWindow = (): void => {
    const win = createMainWindow(store, shutdown)
    installDevShortcuts(win)
    win.on('closed', () => {
      if (mainWindow === win) mainWindow = null
    })
    mainWindow = win
  }

  app.on('second-instance', () => {
    if (shutdown.phase() !== 'idle' || !app.isReady()) return
    if (!mainWindow || mainWindow.isDestroyed()) openWindow()
    const win = mainWindow
    if (!win) return
    if (win.isMinimized()) win.restore()
    // A window still waiting for its first paint shows itself when ready.
    if (!win.isVisible() && !win.webContents.isLoading()) win.show()
    win.focus()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  // macOS: clicking the Dock icon with no windows open reopens one.
  app.on('activate', () => {
    if (app.isReady() && !mainWindow && shutdown.phase() === 'idle') openWindow()
  })

  // Never lose a stroke: save the page, finish pending deletes and writes, then quit.
  // Electron closes the windows only after this handler lets the quit through.
  app.on('before-quit', (event) => {
    if (shutdown.phase() === 'done') return
    event.preventDefault()
    if (shutdown.phase() === 'running') return // already on its way out
    void shutdown.run().then(() => app.quit())
  })

  // Anything that changed while the windows closed.
  app.on('will-quit', () => store.saveNow())

  void app.whenReady().then(() => {
    perf('app ready')
    // The packaged app gets its Dock icon from the bundle; dev runs would show Electron's.
    // Read from the repo (dev only), so the 1024 px PNG isn't bundled into every build.
    if (process.platform === 'darwin' && !app.isPackaged)
      app.dock?.setIcon(join(app.getAppPath(), 'build', 'icon.png'))
    applyTheme(store.data.prefs.theme)
    hardenSecurity()
    handleAppProtocol(join(__dirname, '../renderer'))
    installMenu()
    registerIpc({ session, store, updates, window: () => mainWindow })
    openWindow()
    updates.start()
  })
}
