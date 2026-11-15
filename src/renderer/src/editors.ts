import { invalidatePageData } from './pageOpen'
import { get, set, setBanner, showToast } from './store'
import { locatePage } from './tree'

/** What the canvas and the notes editor expose so saving and conflicts are handled in one place. */
export interface PageEditor {
  /** The page this editor shows right now (not necessarily the store's page while switching). */
  currentPage(): string | null
  isDirty(): boolean
  /** The last save of the current page failed (it is retried in the background). */
  hasFailedSave(): boolean
  flush(): Promise<void>
  /** Current content, used to keep local edits as a conflict copy. */
  snapshot(): Promise<string | null>
  /** Re-reads `pageId` from disk, discarding local edits. Does nothing if another page is shown. */
  reload(pageId: string): Promise<void>
  /** The local edits of `pageId` were kept elsewhere (a copy): treat them as saved. */
  discardUnsaved(pageId: string): void
  /** `pageId` changed on disk while this editor was still loading it: check again once loaded. */
  recheckAfterLoad(pageId: string): void
  /** Stops saving (timer cleared, in-flight save awaited) until resume(). */
  suspend(): Promise<void>
  resume(): void
}

export const editors: { canvas: PageEditor | null; notes: PageEditor | null } = {
  canvas: null,
  notes: null,
}

/** Other pending writes (e.g. the shape library) that must be flushed with the editors. */
const flushers = new Set<() => Promise<void>>()
export function onFlushAll(fn: () => Promise<void>): () => void {
  flushers.add(fn)
  return () => flushers.delete(fn)
}

export async function flushAll(): Promise<void> {
  await Promise.allSettled([
    editors.canvas?.flush(),
    editors.notes?.flush(),
    ...[...flushers].map((fn) => fn()),
  ])
}

const attached = (): PageEditor[] =>
  [editors.canvas, editors.notes].filter((e): e is PageEditor => e !== null)

export const anyDirty = (): boolean => attached().some((e) => e.isDirty())

/**
 * The page whose edits couldn't be saved, if leaving it now would lose them. A page
 * that is gone from the tree (deleted) never holds the user back.
 */
export function unsavedPage(): string | null {
  for (const e of attached()) {
    const id = e.currentPage()
    if (id && e.hasFailedSave() && e.isDirty() && locatePage(get().tree, id)) return id
  }
  return null
}

/** A save failed while switching away: stay on the page so nothing is lost. */
export function keepPage(pageId: string): void {
  showToast({ message: 'Couldn’t save this page, so it stays open. Retrying…' })
  const loc = locatePage(get().tree, pageId)
  // The Space too: switching Spaces sets it before the save is known to have failed.
  if (loc) set({ pageId, spaceId: loc.space.id, pendingPageId: null })
}

const rescues = new Map<string, Promise<boolean>>()

/**
 * The page's save keeps failing (read-only file, too large, no access…): keep its
 * edits as a conflict copy next to it so the user can move on. True when the edits
 * are safe in the copy (or there is nothing left to keep). Concurrent callers share one copy.
 */
export function rescueUnsaved(pageId: string): Promise<boolean> {
  const running = rescues.get(pageId)
  if (running) return running
  const task = rescue(pageId).finally(() => rescues.delete(pageId))
  rescues.set(pageId, task)
  return task
}

async function rescue(pageId: string): Promise<boolean> {
  const holders = attached().filter((e) => e.currentPage() === pageId)
  if (!holders.some((e) => e.isDirty())) return true
  // Both halves go into the copy, so it is the whole page as it was here.
  const scene = editors.canvas?.currentPage() === pageId ? await editors.canvas.snapshot() : null
  const text = editors.notes?.currentPage() === pageId ? await editors.notes.snapshot() : null
  try {
    await window.zenbook.page.saveConflictCopy(pageId, scene, text ?? '')
  } catch (err) {
    console.error('Conflict copy failed', err)
    return false
  }
  // Editors that still save normally carry on; the failing ones now count as saved.
  for (const e of holders) if (e.hasFailedSave()) e.discardUnsaved(pageId)
  const name = locatePage(get().tree, pageId)?.page.name ?? 'this page'
  showToast(
    { message: `Couldn’t save “${name}”, so your changes were kept in a copy next to it.` },
    9000,
  )
  return true
}

/**
 * Leaving a page whose save failed: keep the edits in a copy and go on, or (if even
 * that fails) stay on the page. True when leaving is fine.
 */
export async function mayLeave(pageId: string): Promise<boolean> {
  if (await rescueUnsaved(pageId)) return true
  keepPage(pageId)
  return false
}

/** Quitting: flush everything, and give edits that can't be saved one chance at a copy. */
export async function flushForQuit(): Promise<void> {
  await flushAll()
  const unsaved = unsavedPage()
  if (unsaved) await rescueUnsaved(unsaved).catch(() => false)
}

// One external change at a time per page: the watcher reports the .excalidraw and
// the .md file separately, and together they must produce one conflict copy.
const queues = new Map<string, Promise<void>>()

/**
 * The open page changed on disk (another app, or a sync tool). Without local edits
 * we simply reload. With local edits we keep both: ours becomes a conflict copy
 * next to the page and the disk version is shown.
 */
export function handleExternalChange(pageId: string): Promise<void> {
  const previous = queues.get(pageId) ?? Promise.resolve()
  const next = previous
    .then(() => applyExternalChange(pageId))
    .catch((err: unknown) => console.error('External change failed', err))
  queues.set(pageId, next)
  void next.finally(() => {
    if (queues.get(pageId) === next) queues.delete(pageId)
  })
  return next
}

async function applyExternalChange(pageId: string): Promise<void> {
  if (get().pageId !== pageId) return
  invalidatePageData(pageId)
  // An editor still loading this page may hold what was read before the change: it
  // checks again once its load is done.
  for (const e of attached()) if (e.currentPage() !== pageId) e.recheckAfterLoad(pageId)
  const targets = attached().filter((e) => e.currentPage() === pageId)
  if (targets.length === 0) return
  await Promise.all(targets.map((e) => e.suspend()))
  try {
    if (targets.some((e) => e.isDirty())) {
      // Both halves go into the copy, so it is the whole page as it was here.
      const canvas = editors.canvas && targets.includes(editors.canvas) ? editors.canvas : null
      const notes = editors.notes && targets.includes(editors.notes) ? editors.notes : null
      const scene = canvas ? await canvas.snapshot() : null
      const text = notes ? await notes.snapshot() : null
      try {
        await window.zenbook.page.saveConflictCopy(pageId, scene, text ?? '')
      } catch (err) {
        console.error('Conflict copy failed', err)
        showToast({
          message:
            'This page changed elsewhere, but your version couldn’t be kept as a copy. Your edits stay open here.',
        })
        return // keep the local content; resume() saves it
      }
      setBanner(
        'conflict',
        'This page changed on another device or app while you were editing. Your version was kept as a conflict copy right below it.',
      )
    }
    if (get().pageId !== pageId) return
    invalidatePageData(pageId)
    await Promise.allSettled(targets.map((e) => e.reload(pageId)))
  } finally {
    for (const e of targets) e.resume()
  }
}
