import { useState } from 'react'
import type { LibraryStatus } from '../../../shared/api'
import { useStore } from '../store'
import styles from './ui.module.css'

/** First run (and the error screen): choose where the notebook lives. */
export function Welcome({ onReady }: { onReady: (status: LibraryStatus) => void }) {
  const error = useStore((s) => s.error)
  const [busy, setBusy] = useState(false)
  const docs = window.zenbook.platform === 'win32' ? 'Documents\\Zenbook' : 'Documents/Zenbook'

  const choose = async (kind: 'default' | 'pick') => {
    setBusy(true)
    try {
      onReady(await window.zenbook.library.choose(kind))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.welcome}>
      <div className={styles.welcomeStrip} />
      <div className={styles.welcomeCard}>
        <svg className={styles.enso} viewBox="0 0 100 100" aria-hidden="true">
          <path d="M78 30 A36 36 0 1 0 84 56" />
        </svg>
        <h1>{error ? 'This library can’t be opened' : 'Welcome to Zenbook'}</h1>
        <p>
          {error ??
            'Your notebook is a normal folder of drawings and notes on this computer. Put it in Dropbox, iCloud Drive or OneDrive to have it everywhere.'}
        </p>
        <div className={styles.welcomeActions}>
          <button
            type="button"
            className={styles.primary}
            disabled={busy}
            onClick={() => void choose('default')}
          >
            Use {docs}
          </button>
          <button
            type="button"
            className={styles.secondary}
            disabled={busy}
            onClick={() => void choose('pick')}
          >
            Choose a folder…
          </button>
        </div>
        <p className={styles.fine}>
          Already have a Zenbook folder? Choose it and it opens as it is.
        </p>
      </div>
    </div>
  )
}
