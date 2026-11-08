import { createHash } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { app, dialog, shell, type BrowserWindow } from 'electron'
import type { LibraryStatus } from '../shared/api'
import { Channels } from '../shared/channels'
import { exists } from './library/fsx'
import { Library } from './library/library'
import { LIBRARY_FILE } from './library/model'
import { SearchIndex } from './library/search'
import { seedLibrary } from './library/seed'
import { watchLibrary } from './library/watcher'
import { perf } from './perf'
import type { StateStore } from './state'

type Send = (channel: string, ...args: unknown[]) => void

/** Files that don't make a folder "non-empty" for our purposes. */
const JUNK = new Set(['.DS_Store', 'desktop.ini', 'Thumbs.db', '.localized'])

/**
 * Where a library should live for a folder the user picked: the folder itself if
 * it already is a library or is empty, otherwise a "Zenbook" folder inside it
 * (we never turn someone's Documents folder into Spaces).
 */
export async function resolveLibraryRoot(path: string): Promise<string> {
  if (await exists(join(path, LIBRARY_FILE))) return path
  let entries: string[]
  try {
    entries = (await readdir(path)).filter((e) => !JUNK.has(e))
  } catch {
    return path // doesn't exist yet: it will be created
  }
  if (entries.length === 0) return path
  return join(path, 'Zenbook')
}

/** Owns the open library, its watcher and its search index. */
export class Session {
  lib: Library | null = null
  search: SearchIndex | null = null
  private stopWatch: (() => Promise<void>) | null = null
  private deferred: NodeJS.Timeout | undefined
  private opening: Promise<LibraryStatus> | null = null

  constructor(
    private readonly store: StateStore,
    private readonly send: Send,
  ) {}

  private ready(): LibraryStatus {
    return this.lib
      ? { kind: 'ready', root: this.lib.root, tree: this.lib.tree() }
      : { kind: 'none' }
  }

  status(): Promise<LibraryStatus> {
    if (this.opening) return this.opening
    if (this.lib) return Promise.resolve(this.ready())
    // Tests and fixtures point at their own library; ignored in packaged builds.
    const override = app.isPackaged ? undefined : process.env.ZENBOOK_LIBRARY
    const path = override ?? this.store.data.libraryPath
    if (!path) return Promise.resolve({ kind: 'none' })
    return this.openAt(path, false)
  }

  async choose(kind: 'default' | 'pick', win: BrowserWindow | null): Promise<LibraryStatus> {
    let path = join(app.getPath('documents'), 'Zenbook')
    if (kind === 'pick') {
      const options = {
        title: 'Choose where your notebook lives',
        buttonLabel: 'Use this folder',
        properties: ['openDirectory', 'createDirectory'] as Array<
          'openDirectory' | 'createDirectory'
        >,
      }
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      const picked = result.filePaths[0]
      if (result.canceled || !picked) return this.ready()
      path = picked
    }
    return this.openAt(await resolveLibraryRoot(path), true)
  }

  private openAt(path: string, remember: boolean): Promise<LibraryStatus> {
    this.opening = (async (): Promise<LibraryStatus> => {
      try {
        await this.close()
        const isNew = !(await exists(join(path, LIBRARY_FILE)))
        const lib = await Library.open(path, { trash: (p) => shell.trashItem(p) })
        if (isNew) await seedLibrary(lib)
        this.attach(lib)
        if (remember) this.store.update((s) => (s.libraryPath = path))
        perf('library open')
        return this.ready()
      } catch (err) {
        return { kind: 'error', message: err instanceof Error ? err.message : String(err) }
      } finally {
        this.opening = null
      }
    })()
    return this.opening
  }

  private attach(lib: Library): void {
    this.lib = lib
    const key = createHash('sha1').update(lib.root.toLowerCase()).digest('hex').slice(0, 12)
    const search = new SearchIndex(
      lib,
      join(app.getPath('userData'), 'cache', `search-${key}.json`),
    )
    this.search = search

    lib.on('tree', (tree) => {
      search.syncTree(lib.model)
      this.send(Channels.tree, tree)
    })
    lib.on('pageChanged', (id) => {
      void search.refreshPage(id)
      this.send(Channels.pageExternalChange, id)
    })

    // Not needed for the first paint: start a few seconds later.
    this.deferred = setTimeout(() => {
      if (this.lib !== lib) return
      this.stopWatch = watchLibrary(lib)
      void search.reconcile().then(() => perf('search reconciled'))
    }, 3000)
  }

  async close(): Promise<void> {
    clearTimeout(this.deferred)
    const lib = this.lib
    this.lib = null
    if (this.stopWatch) await this.stopWatch()
    this.stopWatch = null
    if (lib) {
      lib.removeAllListeners()
      await lib.close()
    }
    if (this.search) await this.search.save()
    this.search = null
  }
}
