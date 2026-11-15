// Renders the app icons from vector artwork using Electron itself, so no image
// tooling is needed. Every size is drawn natively from the SVG onto an HTML
// canvas in a hidden window (never downscaled from a big bitmap).
//   npx electron scripts/make-icon.mjs
//
// Sources:
//   build/icon.svg        master artwork, 1024 canvas on Apple's grid (824 tile at 100,100)
//   build/icon-small.svg  simplified mark (heavier ensō + bold pencil, no ripple) for 16-32 px
// Outputs:
//   build/icon.png         1024×1024, macOS grid with transparent margin. electron-builder
//                          derives the .icns and the Linux icons from it.
//   build/icon.ico         16-256 px PNG entries, full-bleed. Used for the Windows exe and
//                          the NSIS installer.
//   build/icon-window.png  256×256 full-bleed, the Linux window icon at runtime.
// "Full-bleed" crops the canvas to the tile (viewBox 92 92 840 840) and drops the
// #shadow group, so the icon is not ~20% smaller than its taskbar neighbours.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow } from 'electron'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const build = (name) => join(root, 'build', name)
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]
const SMALL_MAX = 32 // sizes up to this use icon-small.svg

app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.disableHardwareAcceleration()

/** Sets the SVG's pixel size and, for full-bleed, crops to the tile and drops the shadow. */
function prepare(svg, size, fullBleed) {
  let out = svg.replace(/width="1024" height="1024"/, `width="${size}" height="${size}"`)
  if (fullBleed) {
    out = out
      .replace(/viewBox="0 0 1024 1024"/, 'viewBox="92 92 840 840"')
      .replace(/<g id="shadow">[\s\S]*?<\/g>/, '')
  }
  return out
}

/** Rasterises an SVG string at exactly size×size in the page; resolves to PNG bytes. */
async function render(win, svg, size) {
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  const dataUrl = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const c = document.createElement('canvas')
      c.width = c.height = ${size}
      const ctx = c.getContext('2d')
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(img, 0, 0, ${size}, ${size})
      resolve(c.toDataURL('image/png'))
    }
    img.onerror = () => reject(new Error('SVG failed to load'))
    img.src = ${JSON.stringify(url)}
  })`)
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')
}

/** ICONDIR + one ICONDIRENTRY per image + the PNG payloads (Vista+ PNG-in-ICO). */
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(images.length, 4)
  let offset = header.length
  images.forEach(({ size, png }, i) => {
    const e = 6 + 16 * i
    header.writeUInt8(size >= 256 ? 0 : size, e) // width, 0 means 256
    header.writeUInt8(size >= 256 ? 0 : size, e + 1) // height
    header.writeUInt8(0, e + 2) // colour count
    header.writeUInt8(0, e + 3) // reserved
    header.writeUInt16LE(1, e + 4) // planes
    header.writeUInt16LE(32, e + 6) // bits per pixel
    header.writeUInt32LE(png.length, e + 8)
    header.writeUInt32LE(offset, e + 12)
    offset += png.length
  })
  return Buffer.concat([header, ...images.map((i) => i.png)])
}

function write(name, data, what) {
  writeFileSync(build(name), data)
  console.log(`Wrote build/${name} (${what}, ${(data.length / 1024).toFixed(1)} KB)`)
}

app.whenReady().then(async () => {
  try {
    const master = readFileSync(build('icon.svg'), 'utf8')
    const small = readFileSync(build('icon-small.svg'), 'utf8')
    const win = new BrowserWindow({ show: false, width: 64, height: 64 })
    await win.loadURL('data:text/html;charset=utf-8,<!doctype html><title>icon</title>')

    write('icon.png', await render(win, prepare(master, 1024, false), 1024), '1024 px, macOS grid')
    write(
      'icon-window.png',
      await render(win, prepare(master, 256, true), 256),
      '256 px, full-bleed',
    )

    const images = []
    for (const size of ICO_SIZES) {
      const svg = size <= SMALL_MAX ? small : master
      images.push({ size, png: await render(win, prepare(svg, size, true), size) })
    }
    write('icon.ico', ico(images), ICO_SIZES.join('/') + ' px')
    win.destroy()
  } catch (err) {
    console.error(err)
    process.exitCode = 1
  }
  app.quit()
})
