import { get, set } from './store'

/** What the canvas and the notes editor expose so saving and conflicts are handled in one place. */
export interface PageEditor {
  isDirty(): boolean
  flush(): Promise<void>
  /** Current content, used to keep local edits as a conflict copy. */
  snapshot(): string | null
  /** Re-reads the current page from disk, discarding local edits. */
  reload(): Promise<void>
}

export const editors: { canvas: PageEditor | null; notes: PageEditor | null } = {
  canvas: null,
  notes: null,
}

export async function flushAll(): Promise<void> {
  await Promise.allSettled([editors.canvas?.flush(), editors.notes?.flush()])
}

/**
 * The open page changed on disk (another app, or a sync tool). Without local edits
 * we simply reload. With local edits we keep both: ours becomes a conflict copy
 * next to the page and the disk version is shown.
 */
export async function handleExternalChange(pageId: string): Promise<void> {
  if (get().pageId !== pageId) return
  const dirty = Boolean(editors.canvas?.isDirty() || editors.notes?.isDirty())
  if (dirty) {
    const scene = editors.canvas?.isDirty() ? editors.canvas.snapshot() : null
    const notes = editors.notes?.snapshot() ?? ''
    await window.zenbook.page.saveConflictCopy(pageId, scene, notes)
    set({
      banner:
        'This page changed on another device or app while you were editing. Your version was kept as a conflict copy right below it.',
    })
  }
  await Promise.allSettled([editors.canvas?.reload(), editors.notes?.reload()])
}
