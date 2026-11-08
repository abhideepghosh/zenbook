import { isAbsolute } from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  shell,
  type IpcMainInvokeEvent,
} from 'electron'
import { z } from 'zod'
import { ACCENTS, type AppInfo, type Prefs } from '../shared/api'
import { Channels } from '../shared/channels'
import { showMenu } from './menus'
import { APP_ORIGIN } from './protocol'
import type { Session } from './session'
import { applyPrefs, PrefsPatch, type StateStore } from './state'

/** Only our own renderer may call the API, never a frame or page it navigated to. */
function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url
  if (!url) return false
  const devUrl = process.env.ELECTRON_RENDERER_URL
  return url.startsWith(APP_ORIGIN) || (devUrl !== undefined && url.startsWith(devUrl))
}

/**
 * Registers an invoke handler. Every channel goes through here: the sender is
 * checked and the arguments are validated with zod before any code runs.
 */
function handle<S extends z.ZodTuple, R>(
  channel: string,
  schema: S,
  fn: (args: z.infer<S>, event: IpcMainInvokeEvent) => R | Promise<R>,
): void {
  ipcMain.handle(channel, (event, ...raw: unknown[]) => {
    if (!isTrustedSender(event)) throw new Error(`Blocked IPC from untrusted sender: ${channel}`)
    const parsed = schema.safeParse(raw)
    if (!parsed.success) throw new Error(`Invalid arguments for ${channel}`)
    return fn(parsed.data, event)
  })
}

const MB = 1024 * 1024
const id = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/)
const name = z.string().max(300)
const scene = z.string().max(64 * MB)
const text = z.string().max(16 * MB)
const asset = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  mimeType: z.string().max(100),
  dataURL: z.string().max(100 * MB),
})
const kind = z.enum(['space', 'chapter', 'page'])
const absolutePath = z
  .string()
  .max(4096)
  .refine((p) => isAbsolute(p))

export interface Updates {
  check(manual: boolean): Promise<void>
  install(): void
}

export interface IpcDeps {
  session: Session
  store: StateStore
  updates: Updates
  window: () => BrowserWindow | null
}

export function applyTheme(theme: Prefs['theme']): void {
  nativeTheme.themeSource = theme
}

export function registerIpc({ session, store, updates, window }: IpcDeps): void {
  const lib = () => {
    if (!session.lib) throw new Error('No library is open')
    return session.lib
  }
  const empty = z.tuple([])

  handle(Channels.appInfo, empty, (): AppInfo => ({
    name: app.getName(),
    version: app.getVersion(),
  }))
  handle(Channels.checkUpdates, empty, () => updates.check(true))
  handle(Channels.installUpdate, empty, () => updates.install())

  // Library
  handle(Channels.libraryStatus, empty, () => session.status())
  handle(Channels.libraryChoose, z.tuple([z.enum(['default', 'pick'])]), ([k]) =>
    session.choose(k, window()),
  )
  handle(Channels.loadShapes, empty, () => lib().loadShapes())
  handle(Channels.saveShapes, z.tuple([text]), ([json]) => lib().saveShapes(json))

  // Pages
  handle(Channels.pageOpen, z.tuple([id]), ([pageId]) => lib().readPage(pageId))
  handle(Channels.pageSaveScene, z.tuple([id, scene, text]), async ([pageId, json, drawing]) => {
    await lib().saveScene(pageId, json)
    await session.search?.update(pageId, { drawing })
  })
  handle(Channels.pageSaveNotes, z.tuple([id, text]), async ([pageId, md]) => {
    await lib().saveNotes(pageId, md)
    await session.search?.update(pageId, { notes: md })
  })
  handle(Channels.pageConflictCopy, z.tuple([id, scene.nullable(), text]), ([pageId, json, md]) =>
    lib().saveConflictCopy(pageId, json, md),
  )

  // Assets
  handle(Channels.assetsPut, z.tuple([id, z.array(asset).max(200)]), ([pageId, files]) =>
    lib().putAssets(pageId, files),
  )
  handle(
    Channels.assetsGet,
    z.tuple([id, z.array(z.string().max(128)).max(2000)]),
    ([pageId, ids]) => lib().getAssets(pageId, ids),
  )

  // Structure
  handle(Channels.opsCreate, z.tuple([kind, id.nullable(), name.optional()]), ([k, parent, n]) =>
    lib().create(k, parent, n),
  )
  handle(Channels.opsRename, z.tuple([id, name]), ([itemId, n]) => lib().rename(itemId, n))
  handle(
    Channels.opsMove,
    z.tuple([id, id.nullable(), z.number().int().min(0).max(100_000)]),
    ([itemId, parent, i]) => lib().move(itemId, parent, i),
  )
  handle(Channels.opsDuplicate, z.tuple([id]), ([pageId]) => lib().duplicate(pageId))
  handle(Channels.opsPin, z.tuple([id, z.boolean()]), ([pageId, on]) => lib().pin(pageId, on))
  handle(Channels.opsColor, z.tuple([id, z.enum(ACCENTS)]), ([spaceId, c]) =>
    lib().setColor(spaceId, c),
  )
  handle(Channels.opsRemove, z.tuple([id]), ([itemId]) => lib().remove(itemId))
  handle(Channels.opsUndoRemove, z.tuple([id]), ([itemId]) => lib().undoRemove(itemId))
  handle(Channels.opsImport, z.tuple([id, z.array(absolutePath).max(500)]), ([chapterId, paths]) =>
    lib().importFiles(chapterId, paths),
  )

  // Search
  handle(Channels.search, z.tuple([z.string().max(500)]), ([q]) => session.search?.query(q) ?? [])

  // Native UI
  handle(
    Channels.uiMenu,
    z.tuple([z.enum(['page', 'chapter', 'space', 'spaces', 'settings']), id.optional()]),
    ([k, itemId], event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      return win ? showMenu(k, itemId, session, store, win) : null
    },
  )
  handle(
    Channels.uiConfirm,
    z.tuple([z.string().max(500), z.string().max(2000), z.string().max(50)]),
    async ([message, detail, ok], event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const options = {
        type: 'warning' as const,
        message,
        detail,
        buttons: [ok, 'Cancel'],
        defaultId: 1,
        cancelId: 1,
      }
      const { response } = win
        ? await dialog.showMessageBox(win, options)
        : await dialog.showMessageBox(options)
      return response === 0
    },
  )
  handle(Channels.uiReveal, z.tuple([id]), ([itemId]) =>
    shell.showItemInFolder(lib().pathOf(itemId)),
  )

  // Preferences
  handle(Channels.prefsGet, empty, () => store.data.prefs)
  handle(Channels.prefsSet, z.tuple([PrefsPatch]), ([patch]) => {
    store.update((s) => (s.prefs = applyPrefs(s.prefs, patch as Partial<Prefs>)))
    if (patch.theme) applyTheme(patch.theme)
    if (patch.autoUpdate) void updates.check(false)
  })
}
