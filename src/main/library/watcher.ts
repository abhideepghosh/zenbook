import { relative, sep } from 'node:path'
import { watch } from 'chokidar'
import type { Library } from './library'

/** Ignore anything under a dot-folder (.assets, .trash, .git, .DS_Store) and temp files. */
export function isIgnored(root: string, path: string): boolean {
  if (path.endsWith('.tmp')) return true
  const rel = relative(root, path)
  if (!rel) return false
  return rel.split(sep).some((part) => part.startsWith('.'))
}

/**
 * Watches the library for changes made by other apps or sync tools.
 * - Files or folders added or removed → debounced rescan (the tree updates).
 * - A page's scene or notes changed → `pageChanged`, so an open page reloads.
 * Our own writes are recognised by fingerprint and ignored.
 */
export function watchLibrary(lib: Library): () => Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const rescanSoon = () => {
    clearTimeout(timer)
    timer = setTimeout(() => void lib.rescan().catch(() => undefined), 250)
  }

  const watcher = watch(lib.root, {
    ignoreInitial: true,
    depth: 3,
    ignored: (path: string) => isIgnored(lib.root, path),
  })

  const structural = async (path: string) => {
    if (await lib.queue.isOwnWrite(path)) return
    rescanSoon()
  }

  watcher
    .on('add', (p) => void structural(p))
    .on('unlink', () => rescanSoon())
    .on('addDir', () => rescanSoon())
    .on('unlinkDir', () => rescanSoon())
    .on('change', (path) => {
      void (async () => {
        if (await lib.queue.isOwnWrite(path)) return
        if (path.endsWith('.json')) return rescanSoon()
        const id = lib.pageIdForPath(path)
        if (id) lib.emit('pageChanged', id)
      })()
    })
    .on('error', () => undefined)

  return async () => {
    clearTimeout(timer)
    await watcher.close()
  }
}
