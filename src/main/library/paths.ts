import { isAbsolute, relative, resolve, sep } from 'node:path'

const MAX_NAME = 120
// Characters that are illegal in file names on Windows (and / everywhere), plus controls.
// eslint-disable-next-line no-control-regex
const ILLEGAL = /[/\\:*?"<>|\u0000-\u001f\u007f]/g
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i

/**
 * Turns user input into a name that is a valid file or folder name on every OS.
 * Display names are file names, so this is the only place names get cleaned.
 */
export function sanitizeName(input: string, fallback = 'Untitled'): string {
  let name = input.normalize('NFC').replace(ILLEGAL, '-').replace(/\s+/g, ' ').trim()
  // Windows strips trailing dots and spaces; leading dots would hide the file.
  name = name
    .replace(/[. ]+$/, '')
    .replace(/^\.+/, '')
    .trim()
  if (name.length > MAX_NAME) name = name.slice(0, MAX_NAME).trim()
  if (!name) name = fallback
  if (RESERVED.test(name)) name = `${name}_`
  return name
}

/**
 * Returns `name`, or "name 2", "name 3"… so it doesn't collide (case-insensitively,
 * as on Windows and macOS) with any of `taken`.
 */
export function uniqueName(name: string, taken: Iterable<string>): string {
  const lower = new Set([...taken].map((t) => t.toLowerCase()))
  if (!lower.has(name.toLowerCase())) return name
  for (let n = 2; ; n++) {
    const candidate = `${name} ${n}`
    if (!lower.has(candidate.toLowerCase())) return candidate
  }
}

/** Throws unless `target` is `root` itself or inside it. Defence in depth for every fs call. */
export function assertInsideRoot(root: string, target: string): string {
  const abs = resolve(target)
  const rel = relative(resolve(root), abs)
  if (rel === '') return abs
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Path escapes the library: ${target}`)
  }
  return abs
}

const CONFLICT_PATTERNS = [
  /conflicted copy/i, // Dropbox
  /\.sync-conflict-/i, // Syncthing
  /\(conflict \d{4}-\d{2}-\d{2}/i, // Zenbook's own conflict copies
  /'s conflicted copy/i, // Google Drive / older Dropbox
]

export function isConflictName(name: string): boolean {
  return CONFLICT_PATTERNS.some((re) => re.test(name))
}

/** "2026-11-08 1430" — used in conflict-copy names. */
export function conflictStamp(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}${p(date.getMinutes())}`
}
