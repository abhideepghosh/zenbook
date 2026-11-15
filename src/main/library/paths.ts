import { isAbsolute, relative, resolve, sep } from 'node:path'

/** Longest name, in characters (code points). */
export const MAX_NAME = 120
/**
 * Longest name in UTF-8 bytes. Most file systems allow 255 bytes per name; this
 * leaves room for ".excalidraw", a " 2" or " (could not delete)" suffix and the
 * ".xxxxxxxx.tmp" of an atomic write.
 */
const MAX_NAME_BYTES = 200
// Characters that are illegal in file names on Windows (and / everywhere), plus controls.
// eslint-disable-next-line no-control-regex
const ILLEGAL = /[/\\:*?"<>|\u0000-\u001f\u007f]/g
// Windows device names. They are reserved with any extension ("nul.txt") and with
// trailing spaces before it ("nul .txt"), so the check is on the part before the first dot.
const RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³]) *$/i

/** Cuts `text` to at most `chars` code points and `bytes` UTF-8 bytes, never splitting a character. */
function truncate(text: string, chars: number, bytes: number): string {
  let out = ''
  let size = 0
  let count = 0
  for (const ch of text) {
    const len = Buffer.byteLength(ch, 'utf8')
    if (count + 1 > chars || size + len > bytes) break
    out += ch
    size += len
    count++
  }
  return out
}

/** Windows strips trailing dots and spaces (and can't open such names); leading dots hide a file. */
const trimEdges = (name: string) =>
  name
    .replace(/[. ]+$/, '')
    .replace(/^[. ]+/, '')
    .replace(/[. ]+$/, '')

/**
 * Turns user input into a name that is a valid file or folder name on every OS.
 * Display names are file names, so this is the only place names get cleaned.
 */
export function sanitizeName(input: string, fallback = 'Untitled'): string {
  let name = input.normalize('NFC').replace(ILLEGAL, '-').replace(/\s+/g, ' ')
  // Truncate first, so cleaning the edges is the last thing that touches the end.
  name = trimEdges(truncate(trimEdges(name), MAX_NAME, MAX_NAME_BYTES))
  if (!name) name = fallback
  const dot = name.indexOf('.')
  const stem = dot < 0 ? name : name.slice(0, dot)
  const reserved = RESERVED.exec(stem)
  if (reserved?.[1]) {
    const word = reserved[1]
    name = `${word}_${name.slice(word.length)}` // "nul.txt" → "nul_.txt"
  }
  return name
}

/**
 * `base` followed by `suffix` (e.g. " (conflict 2026-11-08 1430)"), shortening the
 * base rather than the suffix so the result still fits sanitizeName's limits.
 */
export function withSuffix(base: string, suffix: string): string {
  const room = MAX_NAME - Array.from(suffix).length
  const roomBytes = MAX_NAME_BYTES - Buffer.byteLength(suffix, 'utf8')
  return `${trimEdges(truncate(base, room, roomBytes))}${suffix}`
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
