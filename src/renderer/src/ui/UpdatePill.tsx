import { useStore } from '../store'
import styles from './ui.module.css'

/** A calm, non-modal hint in the sidebar footer. Never restarts the app on its own. */
export function UpdatePill() {
  const update = useStore((s) => s.update)
  if (update.kind === 'ready') {
    return (
      <button
        type="button"
        className={styles.pill}
        onClick={() => void window.zenbook.app.installUpdate()}
      >
        Restart to update
      </button>
    )
  }
  if (update.kind === 'available') {
    return (
      <a className={styles.pill} href={update.url} target="_blank" rel="noreferrer">
        {update.version} available
      </a>
    )
  }
  return null
}
