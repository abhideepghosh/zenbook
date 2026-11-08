import { memo } from 'react'
import { toggleNotes, toggleSidebar } from '../commands'
import { useStore } from '../store'
import { locatePage } from '../tree'
import { Icon } from './icons'
import styles from './ui.module.css'

const mod = window.zenbook.platform === 'darwin' ? '⌘' : 'Ctrl'

function SaveState() {
  const state = useStore((s) => s.saveState)
  const label = state === 'error' ? 'Not saved' : state === 'saved' ? 'Saved' : 'Saving…'
  return (
    <span className={styles.save} data-state={state} aria-live="polite">
      {label}
    </span>
  )
}

/** The draggable title bar above the canvas: breadcrumb, save state, panel toggles. */
function TitleStrip() {
  // Select plain strings: zustand needs stable values from selectors.
  const chapterName = useStore((s) => locatePage(s.tree, s.pageId)?.chapter.name ?? null)
  const pageName = useStore((s) => locatePage(s.tree, s.pageId)?.page.name ?? null)
  const sidebarOpen = useStore((s) => s.prefs.sidebarOpen)
  const notesOpen = useStore((s) => s.prefs.notesOpen)
  const focus = useStore((s) => s.focus)
  const narrow = useStore((s) => s.narrow)
  // When the notes panel isn't docked to the right, this strip sits under the Windows caption buttons.
  const atWindowEdge = !notesOpen || narrow || focus

  return (
    <div className={styles.strip} data-focus={focus} data-edge={atWindowEdge}>
      {!sidebarOpen && (
        <button
          type="button"
          className={styles.iconButton}
          onClick={toggleSidebar}
          title={`Show sidebar (${mod} \\)`}
        >
          <Icon name="panelLeft" />
        </button>
      )}
      <div className={styles.breadcrumb}>
        {pageName && (
          <>
            <span className={styles.crumb}>{chapterName}</span>
            <span className={styles.separator}>/</span>
            <span className={styles.current}>{pageName}</span>
            <SaveState />
          </>
        )}
      </div>
      <button
        type="button"
        className={styles.iconButton}
        aria-pressed={notesOpen}
        onClick={toggleNotes}
        title={`${notesOpen ? 'Hide' : 'Show'} notes (${mod} J)`}
      >
        <Icon name="panelRight" />
      </button>
    </div>
  )
}

export default memo(TitleStrip)
