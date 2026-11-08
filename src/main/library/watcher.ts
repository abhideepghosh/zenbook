import { watch } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fingerprint } from './fsx'
import type { Library } from './library'

/** Ignore anything under a dot-folder (.assets, .trash, .git, .DS_Store) and temp files. */
export function isIgnored(root: string, path: string): boolean {
  if (path.endsWith('.tmp')) return true
  const rel = relative(root, path)
  if (!rel) return false
  return rel.split(sep).some((part) => part.startsWith('.'))
}

const SETTLE_MS = 150 // file systems report one save as several events; wait for quiet

/**
 * Watches the library for changes made by other apps or sync tools.
 * - A page's scene or notes changed, appeared or (notes) vanished → `pageChanged`,
 *   so the open page reloads.
 * - Anything else (new pages, folders, renames, deletions) → a debounced rescan.
 * Our own writes and deletions are recognised and ignored.
 *
 * Uses Node's recursive fs.watch: one handle on the library root (Windows
 * ReadDirectoryChangesW, macOS FSEvents, Linux inotify). Watchers that open a
 * handle per folder stop Windows from renaming Space folders while Zenbook runs.
 */
export function watchLibrary(lib: Library): () => Promise<void> {
  let rescanTimer: NodeJS.Timeout | undefined
  const rescanSoon = () => {
    clearTimeout(rescanTimer)
    rescanTimer = setTimeout(() => void lib.rescan().catch(() => undefined), 250)
  }

  const inspect = async (path: string): Promise<void> => {
    const lower = path.toLowerCase()
    const isPageFile = lower.endsWith('.excalidraw') || lower.endsWith('.md')
    if (!isPageFile) {
      // Metadata, folders and anything else: re-read the structure (unless we wrote it).
      if (!(await lib.queue.isOwnWrite(path))) rescanSoon()
      return
    }
    if (lib.queue.isOwnRemoval(path) || (await lib.queue.isOwnWrite(path))) return
    const id = lib.pageIdForPath(path)
    const exists = (await fingerprint(path)) !== null
    // A known page's file changed or appeared, or its notes were deleted: reload it.
    if (id && (exists || lower.endsWith('.md'))) lib.emit('pageChanged', id)
    else rescanSoon() // a new page, or a page's drawing was deleted
  }

  const pending = new Map<string, NodeJS.Timeout>()
  const watcher = watch(lib.root, { recursive: true }, (_event, filename) => {
    if (!filename) return rescanSoon()
    const path = join(lib.root, filename.toString())
    if (isIgnored(lib.root, path)) return
    clearTimeout(pending.get(path))
    pending.set(
      path,
      setTimeout(() => {
        pending.delete(path)
        void inspect(path)
      }, SETTLE_MS),
    )
  })
  watcher.on('error', () => undefined) // e.g. the library folder itself was removed

  return async () => {
    clearTimeout(rescanTimer)
    for (const timer of pending.values()) clearTimeout(timer)
    watcher.close()
  }
}
