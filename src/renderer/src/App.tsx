import styles from './App.module.css'
import { Icon } from './ui/icons'

const mod = window.zenbook.platform === 'darwin' ? '⌘' : 'Ctrl'

// Phase 1 shell: the three columns and the draggable title strip.
// Navigation, canvas and notes fill these regions in Phases 3 and 4.
export function App() {
  return (
    <div className={styles.app}>
      <nav className={styles.sidebar} aria-label="Library">
        <div className={`${styles.strip} ${styles.sidebarStrip}`}>
          <button type="button" className={styles.space}>
            <span className={styles.spaceDot} />
            <span className={styles.spaceName}>Personal</span>
            <Icon name="chevronDown" size={14} />
          </button>
        </div>

        <button type="button" className={styles.search}>
          <Icon name="search" size={15} />
          <span>Search</span>
          <kbd className={styles.kbd}>{mod} K</kbd>
        </button>

        <p className={styles.empty}>Your chapters will appear here.</p>

        <div className={styles.footer}>
          <button type="button" className={styles.ghost}>
            <Icon name="plus" size={15} />
            <span>New page</span>
          </button>
          <button type="button" className={styles.iconButton} aria-label="Settings">
            <Icon name="more" />
          </button>
        </div>
      </nav>

      <main className={styles.center}>
        <div className={`${styles.strip} ${styles.centerStrip}`}>
          <div className={styles.breadcrumb}>
            <span>Personal</span>
            <span className={styles.separator}>/</span>
            <span className={styles.current}>Untitled</span>
          </div>
          <button type="button" className={styles.iconButton} aria-label="Toggle notes">
            <Icon name="panelRight" />
          </button>
        </div>
        <div className={styles.canvas}>
          <p className={styles.hint}>A blank page awaits.</p>
        </div>
      </main>

      <aside className={styles.notes} aria-label="Notes">
        <div className={`${styles.strip} ${styles.notesStrip}`} />
        <div className={styles.notesBody}>
          <h1 className={styles.title}>Untitled</h1>
          <p className={styles.hint}>Notes for this page live here.</p>
        </div>
      </aside>
    </div>
  )
}
