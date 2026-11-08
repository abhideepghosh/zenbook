// IPC channel names, shared by main and preload so they can never drift apart.
export const Channels = {
  appInfo: 'app:info',
  flush: 'app:flush',
  flushed: 'app:flushed',
  update: 'app:update',
  installUpdate: 'app:install-update',
  checkUpdates: 'app:check-updates',

  libraryStatus: 'library:status',
  libraryChoose: 'library:choose',
  tree: 'library:tree',
  loadShapes: 'library:load-shapes',
  saveShapes: 'library:save-shapes',

  pageOpen: 'page:open',
  pageSaveScene: 'page:save-scene',
  pageSaveNotes: 'page:save-notes',
  pageConflictCopy: 'page:conflict-copy',
  pageExternalChange: 'page:external-change',

  assetsPut: 'assets:put',
  assetsGet: 'assets:get',

  opsCreate: 'ops:create',
  opsRename: 'ops:rename',
  opsMove: 'ops:move',
  opsDuplicate: 'ops:duplicate',
  opsPin: 'ops:pin',
  opsColor: 'ops:color',
  opsRemove: 'ops:remove',
  opsUndoRemove: 'ops:undo-remove',
  opsImport: 'ops:import',

  search: 'search:query',

  uiMenu: 'ui:menu',
  uiConfirm: 'ui:confirm',
  uiReveal: 'ui:reveal',

  prefsGet: 'prefs:get',
  prefsSet: 'prefs:set',
} as const
