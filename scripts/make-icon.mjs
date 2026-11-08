// Renders build/icon.svg to build/icon.png (1024×1024) using Electron itself,
// so no image tooling is needed. electron-builder derives .ico and .icns from it.
//   npx electron scripts/make-icon.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow } from 'electron'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
app.commandLine.appendSwitch('force-device-scale-factor', '1')

app.whenReady().then(async () => {
  const svg = readFileSync(join(root, 'build', 'icon.svg'), 'utf8')
  const win = new BrowserWindow({
    show: false,
    width: 1024,
    height: 1024,
    useContentSize: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true },
  })
  const html = `<html style="background:transparent"><body style="margin:0;overflow:hidden;background:transparent">${svg}</body></html>`
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  await new Promise((r) => setTimeout(r, 300))
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 })
  writeFileSync(
    join(root, 'build', 'icon.png'),
    image.resize({ width: 1024, height: 1024 }).toPNG(),
  )
  console.log('Wrote build/icon.png')
  app.quit()
})
