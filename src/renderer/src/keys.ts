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
function onKeyDown(e: KeyboardEvent): void {
  const mod = isMac ? e.metaKey : e.ctrlKey
  const key = e.key.toLowerCase()
  let handled = true

  if (mod && !e.shiftKey && !e.altKey && key === 'k') openPalette()
  else if (mod && !e.shiftKey && !e.altKey && key === 'n') void newPage()
  else if (mod && !e.shiftKey && !e.altKey && e.code === 'Backslash') toggleSidebar()
  else if (mod && !e.shiftKey && !e.altKey && key === 'j') toggleNotes()
  else if (mod && !e.shiftKey && !e.altKey && e.code === 'Period') toggleFocus()
  else if (mod && e.altKey && e.key === 'ArrowUp') stepPage(-1)
  else if (mod && e.altKey && e.key === 'ArrowDown') stepPage(1)
  else if (mod && !e.shiftKey && !e.altKey && /^Digit[1-9]$/.test(e.code))
    switchSpaceByIndex(Number(e.code.slice(5)) - 1)
  else if (e.key === 'F2' && !isTyping(e.target)) startRename()
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
