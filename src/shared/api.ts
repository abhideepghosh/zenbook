// The typed bridge between the sandboxed renderer and the main process.
// Implemented in src/preload/index.ts, exposed as window.zenbook.
// The renderer only ever passes IDs; the main process maps them to paths.

export type Platform = 'darwin' | 'win32' | 'linux'

export const ACCENTS = ['sage', 'clay', 'slate', 'sand', 'plum', 'ocean', 'moss', 'rose'] as const
export type Accent = (typeof ACCENTS)[number]

export const PAPERS = ['plain', 'dots', 'lines', 'grid'] as const
export type Paper = (typeof PAPERS)[number]

export type NodeKind = 'space' | 'chapter' | 'page'

export interface PageNode {
  id: string
  name: string
  /** A sync-tool or Zenbook conflict copy; shown with a warning dot. */
  conflict: boolean
}

export interface ChapterNode {
  id: string
  name: string
  pages: PageNode[]
}

export interface SpaceNode {
  id: string
  name: string
  color: Accent
  chapters: ChapterNode[]
  pinned: string[]
}

export interface Tree {
  spaces: SpaceNode[]
}

export type LibraryStatus =
  | { kind: 'none' }
  | { kind: 'ready'; root: string; tree: Tree }
  | { kind: 'error'; message: string }

export interface PageData {
  /** Raw .excalidraw JSON, or null for a page whose file is empty or unreadable. */
  scene: string | null
  notes: string
  /** Last change to either file (ms since epoch), for "edited 3 min ago". */
  modified: number
}

export interface AssetFile {
  id: string
  mimeType: string
  dataURL: string
}

export interface SearchHit {
  pageId: string
  title: string
  chapter: string
  space: string
  spaceId: string
  matchedIn: Array<'title' | 'notes' | 'drawing'>
}

export interface Viewport {
  scrollX: number
  scrollY: number
  zoom: number
}

export type ThemePref = 'system' | 'light' | 'dark'

/** Per-device preferences (userData/state.json). Never stored in the synced library. */
export interface Prefs {
  lastPageId: string | null
  recent: string[]
  theme: ThemePref
  sidebarOpen: boolean
  notesOpen: boolean
  sidebarWidth: number
  notesWidth: number
  collapsed: string[]
  viewports: Record<string, Viewport>
  autoUpdate: boolean
}

export type MenuKind = 'page' | 'chapter' | 'space' | 'spaces' | 'settings'

export type UpdateStatus =
  | { kind: 'idle' }
  | { kind: 'available'; version: string; url: string }
  | { kind: 'ready'; version: string }

export interface AppInfo {
  name: string
  version: string
}

export type Unsubscribe = () => void

export interface ZenbookApi {
  /** Known synchronously so layout (traffic lights, window controls) never shifts. */
  platform: Platform
  /** ZENBOOK_PERF=1: log timings to the console (tests, fixtures). */
  perf: boolean
  app: {
    info(): Promise<AppInfo>
    /** Main asks the renderer to save everything before quitting. */
    onFlush(cb: () => Promise<void>): Unsubscribe
    onUpdate(cb: (status: UpdateStatus) => void): Unsubscribe
    installUpdate(): Promise<void>
    checkForUpdates(): Promise<void>
  }
  library: {
    status(): Promise<LibraryStatus>
    choose(kind: 'default' | 'pick'): Promise<LibraryStatus>
    onTree(cb: (tree: Tree) => void): Unsubscribe
    loadShapes(): Promise<string | null>
    saveShapes(json: string): Promise<void>
  }
  page: {
    open(id: string): Promise<PageData>
    saveScene(id: string, json: string, text: string): Promise<void>
    saveNotes(id: string, markdown: string): Promise<void>
    /** Keeps local edits as a sibling page when the file also changed on disk. */
    saveConflictCopy(id: string, json: string | null, markdown: string): Promise<string>
    onExternalChange(cb: (id: string) => void): Unsubscribe
  }
  assets: {
    put(pageId: string, files: AssetFile[]): Promise<void>
    get(pageId: string, ids: string[]): Promise<AssetFile[]>
  }
  ops: {
    create(kind: NodeKind, parentId: string | null, name?: string): Promise<string>
    rename(id: string, name: string): Promise<void>
    move(id: string, parentId: string | null, index: number): Promise<void>
    duplicate(id: string): Promise<string>
    pin(pageId: string, pinned: boolean): Promise<void>
    setColor(spaceId: string, color: Accent): Promise<void>
    /** Hides immediately; moves to the OS trash after a few seconds unless undone. */
    remove(id: string): Promise<void>
    undoRemove(id: string): Promise<void>
    /** Copies dropped .excalidraw files into a chapter. */
    importFiles(chapterId: string, files: File[]): Promise<number>
  }
  search: {
    query(q: string): Promise<SearchHit[]>
  }
  ui: {
    /** Shows a native menu and resolves with the chosen action, or null. */
    menu(kind: MenuKind, id?: string): Promise<string | null>
    confirm(message: string, detail: string, ok: string): Promise<boolean>
    reveal(id: string): Promise<void>
  }
  prefs: {
    get(): Promise<Prefs>
    set(patch: Partial<Prefs>): Promise<void>
  }
}
