import { app, Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'

/**
 * macOS needs an app menu (it provides Cmd+C/V/Z in text fields and Quit).
 * The View menu deliberately has no zoom roles: Cmd+= and Cmd+- belong to the canvas.
 * Windows and Linux get no menu bar at all.
 */
export function installMenu(): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
    return
  }
  const devItems: MenuItemConstructorOptions[] = app.isPackaged
    ? []
    : [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }]
  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { label: 'View', submenu: [...devItems, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** Without a menu bar on Windows/Linux, wire the dev-only shortcuts by hand. */
export function installDevShortcuts(win: BrowserWindow): void {
  if (app.isPackaged || process.platform === 'darwin') return
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const key = input.key.toLowerCase()
    if (key === 'f12' || (input.control && input.shift && key === 'i')) {
      win.webContents.toggleDevTools()
      event.preventDefault()
    } else if (input.control && !input.shift && key === 'r') {
      win.webContents.reload()
      event.preventDefault()
    }
  })
}
