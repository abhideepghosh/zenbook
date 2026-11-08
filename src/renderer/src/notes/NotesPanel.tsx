import { memo, useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { locatePage } from '../tree'
import { RenameInput } from '../ui/RenameInput'
import { notes, type NotesInfo } from './controller'
import styles from './NotesPanel.module.css'

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

function ago(ms: number, now: number): string {
  if (!ms) return ''
  const seconds = Math.round((ms - now) / 1000)
  const abs = Math.abs(seconds)
  if (abs < 45) return 'just now'
  if (abs < 3600) return relative.format(Math.round(seconds / 60), 'minute')
  if (abs < 86_400) return relative.format(Math.round(seconds / 3600), 'hour')
  if (abs < 86_400 * 30) return relative.format(Math.round(seconds / 86_400), 'day')
  return new Date(ms).toLocaleDateString()
}

/** "142 words · edited 3 minutes ago": the quiet replacement for an Info tab. */
function Footer() {
  const [info, setInfo] = useState<NotesInfo>({ words: 0, modified: 0 })
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => notes.onInfo(setInfo), [])
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])
  const edited = ago(info.modified, now)
  return (
    <footer className={styles.footer}>
      {info.words} {info.words === 1 ? 'word' : 'words'}
      {edited && ` · edited ${edited}`}
    </footer>
  )
}

function Title() {
  const pageId = useStore((s) => s.pageId)
  const name = useStore((s) => locatePage(s.tree, s.pageId)?.page.name ?? '')
  const [editing, setEditing] = useState(false)
  if (!pageId) return null
  if (editing) {
    return (
      <div className={styles.titleRow}>
        <RenameInput
          id={pageId}
          name={name}
          className={styles.titleInput}
          onDone={() => setEditing(false)}
        />
      </div>
    )
  }
  return (
    <div className={styles.titleRow}>
      <h1 className={styles.title} title="Click to rename" onClick={() => setEditing(true)}>
        {name}
      </h1>
    </div>
  )
}

function NotesPanel() {
  const host = useRef<HTMLDivElement>(null)
  const narrow = useStore((s) => s.narrow)

  useEffect(() => {
    if (!host.current) return
    notes.mount(host.current)
    return () => void notes.unmount()
  }, [])

  return (
    <div className={styles.panel}>
      <div className={styles.strip} data-overlay={narrow} />
      <Title />
      <div
        ref={host}
        className={styles.editor}
        onClick={(e) => e.target === e.currentTarget && notes.focus()}
      />
      <Footer />
    </div>
  )
}

export default memo(NotesPanel)
