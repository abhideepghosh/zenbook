import { join } from 'node:path'
import { app, type BrowserWindow } from 'electron'
import { registerIpc } from './ipc'
import { installDevShortcuts, installMenu } from './menu'
import { perf } from './perf'
import { handleAppProtocol, registerAppScheme } from './protocol'
import { hardenSecurity } from './security'
import { loadState } from './state'
import { createMainWindow } from './window'

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

  const openWindow = (): void => {
    const win = createMainWindow(loadState())
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

  void app.whenReady().then(() => {
    perf('app ready')
    hardenSecurity()
    handleAppProtocol(join(__dirname, '../renderer'))
    installMenu()
    registerIpc()
    openWindow()
  })
}
