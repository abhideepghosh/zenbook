import { canvas } from './canvas/controller'
import {
  newPage,
  openPalette,
  startRename,
  stepPage,
  switchSpaceByIndex,
  toggleFocus,
  toggleNotes,
  toggleSidebar,
} from './commands'
import { get } from './store'

const isMac = window.zenbook.platform === 'darwin'

/** Shortcut labels shown in the palette, matching the platform. */
export const shortcut = (combo: string): string =>
  isMac
    ? combo.replace('Mod+', '⌘').replace('Alt+', '⌥').replace('Shift+', '⇧')
    : combo.replace('Mod+', 'Ctrl+')

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  )
}

/**
 * Zenbook's shortcuts, caught in the capture phase on window so they win over
 * Excalidraw (which binds Ctrl/Cmd+K to "add link"). Physical key codes are used
 * for punctuation and digits so they work on every keyboard layout.
 */
/** The sidebar row (page or chapter) the event came from, if any. */
function rowId(target: EventTarget | null): string | null {
  if (!(target instanceof HTMLElement)) return null
  return target.closest<HTMLElement>('[role="treeitem"][data-id]')?.dataset.id ?? null
}

/** Inside the notes editor, which uses Mod-Alt-ArrowUp/Down to add cursors. */
const inNotes = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && target.closest('.cm-editor') !== null

function onKeyDown(e: KeyboardEvent): void {
  const mod = isMac ? e.metaKey : e.ctrlKey
  const key = e.key.toLowerCase()
  const plain = mod && !e.shiftKey && !e.altKey
  let handled = true

  // Create and toggle shortcuts ignore key repeat: holding Ctrl+N must not make dozens of pages.
  if (plain && (key === 'k' || key === 'n' || key === 'j') && e.repeat) handled = true
  else if (plain && (e.code === 'Backslash' || e.code === 'Period') && e.repeat) handled = true
  else if (plain && key === 'k') openPalette()
  else if (plain && key === 'n') void newPage()
  else if (plain && e.code === 'Backslash') toggleSidebar()
  else if (plain && key === 'j') toggleNotes()
  else if (plain && e.code === 'Period') toggleFocus()
  else if (mod && e.altKey && e.key === 'ArrowUp' && !inNotes(e.target)) stepPage(-1)
  else if (mod && e.altKey && e.key === 'ArrowDown' && !inNotes(e.target)) stepPage(1)
  else if (plain && /^Digit[1-9]$/.test(e.code)) switchSpaceByIndex(Number(e.code.slice(5)) - 1)
  else if (e.key === 'F2' && !isTyping(e.target)) startRename(rowId(e.target))
  else if (
    e.key === 'Escape' &&
    get().focus &&
    !isTyping(e.target) &&
    !canvas.isBusy() &&
    !get().paletteOpen
  )
    toggleFocus(false)
  else handled = false

  if (handled) {
    e.preventDefault()
    e.stopPropagation()
  }
}

export function installShortcuts(): () => void {
  window.addEventListener('keydown', onKeyDown, true)
  return () => window.removeEventListener('keydown', onKeyDown, true)
}
