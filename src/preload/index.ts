import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { Platform, Tree, UpdateStatus, ZenbookApi } from '../shared/api'
import { Channels } from '../shared/channels'

// The only door between the sandboxed page and the rest of the system.
// Every call is a typed invoke; the main process validates every argument.

const invoke = ipcRenderer.invoke.bind(ipcRenderer)

function subscribe<T>(channel: string, cb: (value: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, value: T) => cb(value)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const flushers = new Set<() => Promise<void>>()
ipcRenderer.on(Channels.flush, () => {
  void Promise.allSettled([...flushers].map((f) => f())).finally(() =>
    ipcRenderer.send(Channels.flushed),
  )
})

const api: ZenbookApi = {
  platform: process.platform as Platform,
  perf: process.env.ZENBOOK_PERF === '1',
  app: {
    info: () => invoke(Channels.appInfo),
    onFlush: (cb) => {
      flushers.add(cb)
      return () => flushers.delete(cb)
    },
    onUpdate: (cb) => subscribe<UpdateStatus>(Channels.update, cb),
    installUpdate: () => invoke(Channels.installUpdate),
    checkForUpdates: () => invoke(Channels.checkUpdates),
  },
  library: {
    status: () => invoke(Channels.libraryStatus),
    choose: (kind) => invoke(Channels.libraryChoose, kind),
    onTree: (cb) => subscribe<Tree>(Channels.tree, cb),
    loadShapes: () => invoke(Channels.loadShapes),
    saveShapes: (json) => invoke(Channels.saveShapes, json),
  },
  page: {
    open: (id) => invoke(Channels.pageOpen, id),
    saveScene: (id, json, text) => invoke(Channels.pageSaveScene, id, json, text),
    saveNotes: (id, md) => invoke(Channels.pageSaveNotes, id, md),
    saveConflictCopy: (id, json, md) => invoke(Channels.pageConflictCopy, id, json, md),
    onExternalChange: (cb) => subscribe<string>(Channels.pageExternalChange, cb),
  },
  assets: {
    put: (pageId, files) => invoke(Channels.assetsPut, pageId, files),
    get: (pageId, ids) => invoke(Channels.assetsGet, pageId, ids),
  },
  ops: {
    create: (kind, parentId, name) =>
      name === undefined
        ? invoke(Channels.opsCreate, kind, parentId)
        : invoke(Channels.opsCreate, kind, parentId, name),
    rename: (id, name) => invoke(Channels.opsRename, id, name),
    move: (id, parentId, index) => invoke(Channels.opsMove, id, parentId, index),
    duplicate: (id) => invoke(Channels.opsDuplicate, id),
    pin: (id, pinned) => invoke(Channels.opsPin, id, pinned),
    setColor: (id, color) => invoke(Channels.opsColor, id, color),
    remove: (id) => invoke(Channels.opsRemove, id),
    undoRemove: (id) => invoke(Channels.opsUndoRemove, id),
    // Dropped files only expose their path through webUtils (never to the page itself).
    importFiles: (chapterId, files) =>
      invoke(
        Channels.opsImport,
        chapterId,
        files.map((f) => webUtils.getPathForFile(f)).filter(Boolean),
      ),
  },
  search: {
    query: (q) => invoke(Channels.search, q),
  },
  ui: {
    menu: (kind, id) =>
      id === undefined ? invoke(Channels.uiMenu, kind) : invoke(Channels.uiMenu, kind, id),
    confirm: (message, detail, ok) => invoke(Channels.uiConfirm, message, detail, ok),
    reveal: (id) => invoke(Channels.uiReveal, id),
  },
  prefs: {
    get: () => invoke(Channels.prefsGet),
    set: (patch) => invoke(Channels.prefsSet, patch),
  },
}

contextBridge.exposeInMainWorld('zenbook', api)
