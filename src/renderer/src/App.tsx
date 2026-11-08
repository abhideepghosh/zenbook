import { lazy, Suspense, useEffect, type CSSProperties } from 'react'
import type { LibraryStatus } from '../../shared/api'
import styles from './App.module.css'
import { applyTree, openPage } from './commands'
import { flushAll, handleExternalChange } from './editors'
import { installShortcuts } from './keys'
import Palette from './palette/Palette'
import Sidebar from './sidebar/Sidebar'
import { get, set, useStore } from './store'
import { findSpace, firstPage, locatePage } from './tree'
import { Banner, Toast } from './ui/Overlays'
import { ResizeHandle } from './ui/ResizeHandle'
import TitleStrip from './ui/TitleStrip'
import { Welcome } from './ui/Welcome'

// The canvas and the notes editor are separate chunks: the sidebar paints first.
const Canvas = lazy(() => import('./canvas/Canvas'))
const NotesPanel = lazy(() => import('./notes/NotesPanel'))

/** Shows a library once it's open: the last page, or the first one. */
function applyStatus(status: LibraryStatus): void {
  if (status.kind === 'none') return set({ status: 'none', error: null })
  if (status.kind === 'error') return set({ status: 'error', error: status.message })
  set({ status: 'ready', error: null, root: status.root, tree: status.tree })
  const { prefs } = get()
  const last =
    prefs.lastPageId && locatePage(status.tree, prefs.lastPageId) ? prefs.lastPageId : null
  const start = last ?? firstPage(status.tree.spaces[0])?.id ?? null
  if (start) openPage(start)
  else set({ spaceId: status.tree.spaces[0]?.id ?? null })
}

async function boot(): Promise<void> {
  const [prefs, status] = await Promise.all([
    window.zenbook.prefs.get(),
    window.zenbook.library.status(),
  ])
  set({ prefs })
  applyStatus(status)
}

export function App() {
  const status = useStore((s) => s.status)
  const prefs = useStore((s) => s.prefs)
  const focus = useStore((s) => s.focus)
  const narrow = useStore((s) => s.narrow)
  const color = useStore((s) => findSpace(s.tree, s.spaceId)?.color ?? 'sage')

  useEffect(() => {
    void boot()
    const offs = [
      installShortcuts(),
      window.zenbook.library.onTree(applyTree),
      window.zenbook.page.onExternalChange((id) => void handleExternalChange(id)),
      window.zenbook.app.onFlush(flushAll),
      window.zenbook.app.onUpdate((update) => set({ update })),
    ]
    return () => offs.forEach((off) => off())
  }, [])

  if (status === 'loading') return <div className={styles.loading} />
  if (status === 'none' || status === 'error') return <Welcome onReady={applyStatus} />

  const showSidebar = prefs.sidebarOpen && !focus
  const showNotes = prefs.notesOpen && !focus
  const layout = {
    '--accent': `var(--accent-${color})`,
    '--sidebar-width': `${prefs.sidebarWidth}px`,
    '--notes-width': `${prefs.notesWidth}px`,
  } as CSSProperties

  return (
    <div
      className={styles.app}
      style={layout}
      data-sidebar={showSidebar}
      data-notes={showNotes}
      data-narrow={narrow}
      data-focus={focus}
    >
      {showSidebar && (
        <div className={styles.sidebar}>
          <Sidebar />
          <ResizeHandle side="sidebar" width={prefs.sidebarWidth} min={200} max={360} />
        </div>
      )}

      <main className={styles.center}>
        <TitleStrip />
        <Banner />
        <Suspense fallback={<div className={styles.paper} />}>
          <Canvas />
        </Suspense>
      </main>

      {showNotes && (
        <aside className={styles.notes} aria-label="Notes">
          {!narrow && <ResizeHandle side="notes" width={prefs.notesWidth} min={280} max={560} />}
          <Suspense fallback={null}>
            <NotesPanel />
          </Suspense>
        </aside>
      )}

      <Palette />
      <Toast />
    </div>
  )
}
