// Copies Excalidraw's fonts into the renderer's public folder so the canvas never
// fetches fonts from a CDN (offline-first). Runs before `dev` and `build`.
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = join(root, 'node_modules', '@excalidraw', 'excalidraw')
const source = join(pkg, 'dist', 'prod', 'fonts')
const target = join(root, 'src', 'renderer', 'public', 'fonts')
const stamp = join(target, '.version')

const version = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version
if (existsSync(stamp) && readFileSync(stamp, 'utf8') === version) process.exit(0)

cpSync(source, target, { recursive: true })
writeFileSync(stamp, version)
console.log(`Copied Excalidraw ${version} fonts to src/renderer/public/fonts`)
