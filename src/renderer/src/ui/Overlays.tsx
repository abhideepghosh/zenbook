import { topBanner } from '../status'
import { setBanner, useStore } from '../store'
import { Icon } from './icons'
import styles from './ui.module.css'

/** One small message at the bottom, optionally with an action (Undo). */
export function Toast() {
  const toast = useStore((s) => s.toast)
  if (!toast) return null
  return (
    <div className={styles.toast} role="status">
      <span>{toast.message}</span>
      {toast.action && (
        <button type="button" className={styles.toastAction} onClick={toast.action.run}>
          {toast.action.label}
        </button>
      )}
    </div>
  )
}

/** A persistent notice above the canvas (save errors, conflicts, unreadable pages). */
export function Banner() {
  // Plain strings from both selectors, so they stay stable.
  const key = useStore((s) => topBanner(s.banners))
  const banner = useStore((s) => (key ? (s.banners[key] ?? null) : null))
  if (!key || !banner) return null
  return (
    <div className={styles.banner} role="alert">
      <span>{banner}</span>
      <button
        type="button"
        className={styles.iconButton}
        aria-label="Dismiss"
        onClick={() => setBanner(key, null)}
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  )
}
