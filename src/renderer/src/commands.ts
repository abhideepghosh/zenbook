import type { Accent, NodeKind, Tree } from '../../shared/api'
import { anyDirty, flushAll, mayLeave, unsavedPage } from './editors'
import { get, set, setBanner, setPrefs, showToast } from './store'
import { adjacentPage, fallbackPage, findSpace, firstPage, locateChapter, locatePage } from './tree'

// Every user action lives here, so the sidebar, native menus, keyboard shortcuts
// and the command palette all behave identically.

const api = () => window.zenbook

function reportError(err: unknown): void {
  showToast({
    message:
      err instanceof Error
        ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
        : String(err),
  })
}

async function attempt<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn()
  } catch (err) {
    reportError(err)
    return undefined
  }
}

// ---------- navigation ----------

/** Bumped by every navigation, so a switch still waiting for a save is dropped by a newer one. */
let navToken = 0

export function openPage(pageId: string | null): void {
  const { tree, pageId: current } = get()
  if (!pageId) return
  if (pageId === current) {
    navToken++ // back on the open page: drop a switch still waiting for its save
    return
  }
  // Created a moment ago: IPC replies can overtake the tree event, so open it when the tree lands.
  if (!locatePage(tree, pageId)) return set({ pendingPageId: pageId })
  const token = ++navToken
  if (!anyDirty()) return showPage(pageId)
  // Save the open page first. If that fails, keep its edits in a copy and go on; if even
  // that fails, stay on it (and keep retrying) so nothing is lost.
  void (async () => {
    await flushAll()
    if (token !== navToken) return
    const unsaved = unsavedPage()
    if (unsaved && !(await mayLeave(unsaved))) return
    if (token === navToken) showPage(pageId)
  })()
}

function showPage(pageId: string): void {
  const { tree, pageId: current, prefs } = get()
  const loc = locatePage(tree, pageId)
  if (!loc) return set({ pendingPageId: pageId })
  if (pageId === current) return
  set({ pageId, spaceId: loc.space.id, pendingPageId: null })
  setBanner('unreadable', null)
  setBanner('conflict', null)
  const recent = [pageId, ...prefs.recent.filter((id) => id !== pageId)].slice(0, 20)
  setPrefs({ lastPageId: pageId, recent })
}

/** No page open (an empty Space). The editors keep the old page if its save failed. */
function closePage(patch: { spaceId?: string | null } = {}): void {
  navToken++
  set({ ...patch, pageId: null })
}

export function switchSpace(spaceId: string): void {
  const { tree, prefs } = get()
  const space = findSpace(tree, spaceId)
  if (!space) return
  // Return to the page last visited in that space, else its first page.
  const remembered = prefs.recent.find((id) => locatePage(tree, id)?.space.id === spaceId)
  set({ spaceId })
  const target = remembered ?? firstPage(space)?.id ?? null
  if (target) openPage(target)
  else closePage()
}

export function switchSpaceByIndex(index: number): void {
  const space = get().tree.spaces[index]
  if (space) switchSpace(space.id)
}

export function stepPage(step: 1 | -1): void {
  const next = adjacentPage(get().tree, get().pageId, step)
  if (next) openPage(next.id)
}

/** Applies a new tree from the main process, keeping the user on a sensible page. */
export function applyTree(next: Tree): void {
  const { tree: previous, pageId, spaceId, pendingPageId } = get()
  set({ tree: next })
  if (pendingPageId && locatePage(next, pendingPageId)) return openPage(pendingPageId)
  const open = locatePage(next, pageId)
  if (open) {
    // Moved to another Space (e.g. from another device): follow it there.
    if (open.space.id !== spaceId) set({ spaceId: open.space.id })
    return
  }
  if (!pageId && spaceId && findSpace(next, spaceId) && !firstPage(findSpace(next, spaceId))) return
  const fallback = fallbackPage(previous, next, pageId, spaceId)
  if (fallback) openPage(fallback.id)
  else closePage({ spaceId: findSpace(next, spaceId)?.id ?? next.spaces[0]?.id ?? null })
}

// ---------- create ----------

/** A new page next to the current one (or in the first chapter), ready to be named. */
export async function newPage(chapterId?: string): Promise<void> {
  const { tree, pageId, spaceId } = get()
  const loc = locatePage(tree, pageId)
  let parent: string | null = chapterId ?? loc?.page.id ?? null
  if (!parent) {
    const space = findSpace(tree, spaceId) ?? tree.spaces[0]
    if (!space) return newSpace()
    parent =
      space.chapters[0]?.id ??
      (await attempt(() => api().ops.create('chapter', space.id, 'Notes'))) ??
      null
  }
  if (!parent) return
  const id = await attempt(() => api().ops.create('page', parent, 'Untitled'))
  if (!id) return
  openPage(id)
  set({ renamingId: id })
}

export async function newChapter(): Promise<void> {
  const spaceId = get().spaceId ?? get().tree.spaces[0]?.id
  if (!spaceId) return newSpace()
  const chapter = await attempt(() => api().ops.create('chapter', spaceId, 'Untitled Chapter'))
  if (!chapter) return
  const page = await attempt(() => api().ops.create('page', chapter, 'Untitled'))
  if (page) openPage(page)
  set({ renamingId: chapter })
}

export async function newSpace(): Promise<void> {
  const space = await attempt(() => api().ops.create('space', null, 'Untitled Space'))
  if (!space) return
  const chapter = await attempt(() => api().ops.create('chapter', space, 'Notes'))
  const page = chapter
    ? await attempt(() => api().ops.create('page', chapter, 'Untitled'))
    : undefined
  set({ spaceId: space })
  if (page) openPage(page)
  set({ renamingId: space })
}

// ---------- edit ----------

export function startRename(id?: string | null): void {
  const target = id ?? get().pageId
  if (target) set({ renamingId: target })
}

export async function commitRename(id: string, name: string): Promise<void> {
  set({ renamingId: null })
  const trimmed = name.trim()
  if (trimmed) await attempt(() => api().ops.rename(id, trimmed))
}

export async function duplicatePage(id?: string): Promise<void> {
  const target = id ?? get().pageId
  if (!target) return
  await editorsFlushIfCurrent(target)
  const copy = await attempt(() => api().ops.duplicate(target))
  if (copy) openPage(copy)
}

async function editorsFlushIfCurrent(id: string): Promise<void> {
  if (get().pageId === id) await flushAll()
}

export async function togglePin(id?: string): Promise<void> {
  const target = id ?? get().pageId
  const loc = locatePage(get().tree, target)
  if (!target || !loc) return
  await attempt(() => api().ops.pin(target, !loc.space.pinned.includes(target)))
}

export async function moveItem(id: string, parentId: string | null, index: number): Promise<void> {
  await editorsFlushIfCurrent(id)
  await attempt(() => api().ops.move(id, parentId, index))
}

export async function setSpaceColor(color: Accent): Promise<void> {
  const spaceId = get().spaceId
  if (spaceId) await attempt(() => api().ops.setColor(spaceId, color))
}

/** Deletes with a few seconds to undo; spaces ask first because they hold so much. */
export async function removeItem(id: string, kind: NodeKind): Promise<void> {
  const { tree } = get()
  let label = 'Page'
  if (kind === 'space') {
    const space = findSpace(tree, id)
    const ok = await api().ui.confirm(
      `Delete the Space “${space?.name ?? ''}”?`,
      'All of its chapters and pages move to the trash. You can restore them from there.',
      'Delete Space',
    )
    if (!ok) return
    label = 'Space'
  } else if (kind === 'chapter') {
    label = 'Chapter'
  }
  if (kind === 'page') await editorsFlushIfCurrent(id)
  else await flushAll()
  const done = await attempt(async () => {
    await api().ops.remove(id)
    return true
  })
  if (!done) return
  showToast({
    message: `${label} moved to the trash`,
    action: {
      label: 'Undo',
      run: () => void attempt(() => api().ops.undoRemove(id)).then(() => set({ toast: null })),
    },
  })
}

export async function importInto(chapterId: string, files: File[]): Promise<void> {
  const n = await attempt(() => api().ops.importFiles(chapterId, files))
  if (n === undefined) return
  showToast({
    message: n
      ? `Imported ${n} page${n === 1 ? '' : 's'}`
      : 'Only .excalidraw files can be imported',
  })
}

export async function reveal(id?: string | null): Promise<void> {
  const target = id ?? get().pageId
  if (target) await attempt(() => api().ui.reveal(target))
}

// ---------- view ----------

/** `focusCounterpart`: from the Hide/Show sidebar buttons, which unmount when clicked. */
export function toggleSidebar(focusCounterpart = false): void {
  const open = !get().prefs.sidebarOpen
  setPrefs({ sidebarOpen: open })
  if (focusCounterpart) set({ focusRequest: open ? 'Hide sidebar' : 'Show sidebar' })
}

export function toggleNotes(): void {
  setPrefs({ notesOpen: !get().prefs.notesOpen })
}

export function toggleFocus(force?: boolean): void {
  set({ focus: force ?? !get().focus })
}

export function openPalette(seed = ''): void {
  set({ paletteOpen: true, paletteSeed: seed })
}

export function closePalette(): void {
  set({ paletteOpen: false })
}

export async function changeLibrary(): Promise<void> {
  await flushAll()
  const status = await attempt(() => api().library.choose('pick'))
  if (status?.kind === 'ready') {
    // A cancelled picker answers with the library that is already open: nothing to do.
    if (status.root === get().root && get().status === 'ready') return
    navToken++
    set({
      status: 'ready',
      root: status.root,
      tree: status.tree,
      pageId: null,
      spaceId: status.tree.spaces[0]?.id ?? null,
    })
    const first = firstPage(status.tree.spaces[0])
    if (first) openPage(first.id)
  } else if (status?.kind === 'error') {
    navToken++
    // pageId is cleared so reopening a library later really loads its page again.
    set({ status: 'error', error: status.message, pageId: null, pendingPageId: null })
  }
}

/** Runs an action id returned by a native menu. */
export async function runMenuAction(action: string | null, target?: string): Promise<void> {
  if (!action) return
  const [verb, arg] = action.split(/:(.*)/s) as [string, string | undefined]
  const { spaceId } = get()
  switch (verb) {
    case 'rename':
      return startRename(target)
    case 'duplicate':
      return duplicatePage(target)
    case 'pin':
    case 'unpin':
      return togglePin(target)
    case 'reveal':
      return reveal(target)
    case 'reveal-space':
      return reveal(spaceId)
    case 'delete': {
      if (!target) return
      const isChapter = Boolean(locateChapter(get().tree, target))
      return removeItem(target, isChapter ? 'chapter' : 'page')
    }
    case 'move':
      if (target && arg) return moveItem(target, arg, 100_000) // the end of the target list
      return
    case 'new-page':
      return newPage(target)
    case 'new-chapter':
      return newChapter()
    case 'switch':
      if (arg) switchSpace(arg)
      return
    case 'new-space':
      return newSpace()
    case 'rename-space':
      return startRename(spaceId)
    case 'color':
      return setSpaceColor(arg as Accent)
    case 'delete-space':
      if (spaceId) return removeItem(spaceId, 'space')
      return
    case 'theme':
      setPrefs({ theme: arg as 'system' | 'light' | 'dark' })
      return
    case 'change-library':
      return changeLibrary()
    case 'toggle-auto-update':
      setPrefs({ autoUpdate: !get().prefs.autoUpdate })
      return
    case 'check-updates':
      showToast({ message: 'Checking for updates…' }, 2500)
      await attempt(() => api().app.checkForUpdates())
      return
    case 'shortcuts':
      return openPalette('>')
  }
}
