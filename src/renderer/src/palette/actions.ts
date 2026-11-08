import { PAPERS, type Paper } from '../../../shared/api'
import { canvas } from '../canvas/controller'
import {
  changeLibrary,
  duplicatePage,
  newChapter,
  newPage,
  newSpace,
  removeItem,
  reveal,
  runMenuAction,
  startRename,
  stepPage,
  switchSpace,
  toggleFocus,
  toggleNotes,
  togglePin,
  toggleSidebar,
} from '../commands'
import { shortcut } from '../keys'
import { get, setPrefs } from '../store'
import { locatePage } from '../tree'

export interface Action {
  id: string
  label: string
  shortcut?: string
  run: () => void
}

const paperName: Record<Paper, string> = {
  plain: 'Plain',
  dots: 'Dotted',
  lines: 'Lined',
  grid: 'Squared',
}

/** Every action, in the order shown for an empty query. Built fresh so labels reflect state. */
export function allActions(): Action[] {
  const { tree, pageId, spaceId, prefs, focus } = get()
  const loc = locatePage(tree, pageId)
  const pinned = loc ? loc.space.pinned.includes(loc.page.id) : false
  const actions: Action[] = [
    { id: 'new-page', label: 'New page', shortcut: shortcut('Mod+N'), run: () => void newPage() },
    { id: 'new-chapter', label: 'New chapter', run: () => void newChapter() },
    { id: 'new-space', label: 'New Space', run: () => void newSpace() },
    {
      id: 'focus',
      label: focus ? 'Leave focus mode' : 'Focus mode',
      shortcut: shortcut('Mod+.'),
      run: () => toggleFocus(),
    },
    {
      id: 'sidebar',
      label: prefs.sidebarOpen ? 'Hide sidebar' : 'Show sidebar',
      shortcut: shortcut('Mod+\\'),
      run: toggleSidebar,
    },
    {
      id: 'notes',
      label: prefs.notesOpen ? 'Hide notes' : 'Show notes',
      shortcut: shortcut('Mod+J'),
      run: toggleNotes,
    },
  ]
  if (loc) {
    actions.push(
      { id: 'rename', label: 'Rename page', shortcut: 'F2', run: () => startRename(loc.page.id) },
      { id: 'duplicate', label: 'Duplicate page', run: () => void duplicatePage(loc.page.id) },
      {
        id: 'pin',
        label: pinned ? 'Unpin page' : 'Pin page',
        run: () => void togglePin(loc.page.id),
      },
      { id: 'next', label: 'Next page', shortcut: shortcut('Mod+Alt+↓'), run: () => stepPage(1) },
      {
        id: 'previous',
        label: 'Previous page',
        shortcut: shortcut('Mod+Alt+↑'),
        run: () => stepPage(-1),
      },
      {
        id: 'export',
        label: 'Export image…',
        shortcut: shortcut('Mod+Shift+E'),
        run: () => canvas.openDialog('imageExport'),
      },
      {
        id: 'find',
        label: 'Find on canvas',
        shortcut: shortcut('Mod+F'),
        run: () => canvas.openSearch(),
      },
      {
        id: 'reveal',
        label:
          window.zenbook.platform === 'darwin' ? 'Reveal page in Finder' : 'Show page in folder',
        run: () => void reveal(loc.page.id),
      },
      { id: 'delete', label: 'Delete page', run: () => void removeItem(loc.page.id, 'page') },
      ...PAPERS.map((p) => ({
        id: `paper-${p}`,
        label: `Paper: ${paperName[p]}`,
        run: () => canvas.setPaper(p),
      })),
    )
  }
  tree.spaces.forEach((space, i) => {
    if (space.id !== spaceId) {
      actions.push({
        id: `space-${space.id}`,
        label: `Go to Space: ${space.name}`,
        shortcut: i < 9 ? shortcut(`Mod+${i + 1}`) : undefined,
        run: () => switchSpace(space.id),
      })
    }
  })
  actions.push(
    ...(['system', 'light', 'dark'] as const).map((t) => ({
      id: `theme-${t}`,
      label: `Theme: ${t[0]!.toUpperCase()}${t.slice(1)}`,
      run: () => setPrefs({ theme: t }),
    })),
    { id: 'library', label: 'Change library folder…', run: () => void changeLibrary() },
    { id: 'updates', label: 'Check for updates', run: () => void runMenuAction('check-updates') },
  )
  return actions
}
