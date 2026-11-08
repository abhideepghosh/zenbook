import {
  app,
  dialog,
  Menu,
  shell,
  type BrowserWindow,
  type MenuItemConstructorOptions,
} from 'electron'
import { ACCENTS, type MenuKind } from '../shared/api'
import { find } from './library/model'
import type { Session } from './session'
import type { StateStore } from './state'

const title = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/**
 * Builds a native context menu and resolves with the chosen action id (or null).
 * The renderer performs the action, so every action goes through the same code
 * whether it came from a menu, a shortcut or the palette.
 */
export function showMenu(
  kind: MenuKind,
  id: string | undefined,
  session: Session,
  store: StateStore,
  win: BrowserWindow,
): Promise<string | null> {
  const lib = session.lib
  const pick = (action: string) => () => resolve(action)
  let resolve: (action: string | null) => void = () => undefined
  const result = new Promise<string | null>((r) => {
    let done = false
    resolve = (a) => {
      if (done) return
      done = true
      r(a)
    }
  })

  const item = (label: string, action: string, extra: MenuItemConstructorOptions = {}) =>
    ({ label, click: pick(action), ...extra }) satisfies MenuItemConstructorOptions
  const sep: MenuItemConstructorOptions = { type: 'separator' }
  const template: MenuItemConstructorOptions[] = []
  const found = lib && id ? find(lib.model, id) : null

  if (kind === 'page' && found?.kind === 'page') {
    const isPinned = found.space.pinned.includes(found.page.id)
    const moveTargets: MenuItemConstructorOptions[] = []
    for (const space of lib!.model.spaces) {
      if (moveTargets.length) moveTargets.push(sep)
      moveTargets.push({ label: space.name, enabled: false })
      for (const chapter of space.chapters) {
        moveTargets.push(
          item(`   ${chapter.name}`, `move:${chapter.id}`, {
            enabled: chapter.id !== found.chapter.id,
          }),
        )
      }
    }
    template.push(
      item('Rename', 'rename', { accelerator: 'F2', registerAccelerator: false }),
      item('Duplicate', 'duplicate'),
      item(isPinned ? 'Unpin' : 'Pin', isPinned ? 'unpin' : 'pin'),
      { label: 'Move to', submenu: moveTargets },
      sep,
      item(process.platform === 'darwin' ? 'Reveal in Finder' : 'Show in folder', 'reveal'),
      sep,
      item('Delete', 'delete'),
    )
  } else if (kind === 'chapter' && found?.kind === 'chapter') {
    template.push(
      item('New page', 'new-page'),
      item('Rename', 'rename', { accelerator: 'F2', registerAccelerator: false }),
      {
        label: 'Move to Space',
        submenu: lib!.model.spaces.map((s) =>
          item(s.name, `move:${s.id}`, { enabled: s.id !== found.space.id }),
        ),
      },
      sep,
      item(process.platform === 'darwin' ? 'Reveal in Finder' : 'Show in folder', 'reveal'),
      sep,
      item('Delete chapter', 'delete'),
    )
  } else if (kind === 'spaces' || kind === 'space') {
    const current = found?.kind === 'space' ? found.space : null
    for (const [i, space] of (lib?.model.spaces ?? []).entries()) {
      template.push(
        item(space.name, `switch:${space.id}`, {
          type: 'radio',
          checked: space.id === current?.id,
          accelerator: i < 9 ? `CmdOrCtrl+${i + 1}` : undefined,
          registerAccelerator: false,
        }),
      )
    }
    template.push(sep, item('New Space', 'new-space'))
    if (current) {
      template.push(
        item('Rename Space', 'rename-space'),
        {
          label: 'Colour',
          submenu: ACCENTS.map((c) =>
            item(title(c), `color:${c}`, { type: 'radio', checked: current.color === c }),
          ),
        },
        item('New chapter', 'new-chapter'),
        sep,
        item(process.platform === 'darwin' ? 'Reveal in Finder' : 'Show in folder', 'reveal-space'),
        item('Delete Space…', 'delete-space'),
      )
    }
  } else if (kind === 'settings') {
    const prefs = store.data.prefs
    template.push(
      {
        label: 'Theme',
        submenu: (['system', 'light', 'dark'] as const).map((t) =>
          item(title(t), `theme:${t}`, { type: 'radio', checked: prefs.theme === t }),
        ),
      },
      sep,
      {
        label: 'Open library folder',
        click: () => (lib ? void shell.openPath(lib.root) : undefined),
      },
      item('Change library folder…', 'change-library'),
      sep,
      item('Check for updates automatically', 'toggle-auto-update', {
        type: 'checkbox',
        checked: prefs.autoUpdate,
      }),
      item('Check for updates now', 'check-updates'),
      sep,
      item('Keyboard shortcuts', 'shortcuts'),
      {
        label: 'About Zenbook',
        click: () =>
          void dialog.showMessageBox(win, {
            type: 'info',
            title: 'About Zenbook',
            message: `Zenbook ${app.getVersion()}`,
            detail: 'A calm, local-first notebook.\nOpen source under the MIT licence.',
          }),
      },
    )
  }

  if (template.length === 0) return Promise.resolve(null)
  Menu.buildFromTemplate(template).popup({
    window: win,
    // Some platforms close the menu before running the click handler; give it a moment.
    callback: () => setTimeout(() => resolve(null), 50),
  })
  return result
}
