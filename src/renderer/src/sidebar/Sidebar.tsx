import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from 'react'
import type { ChapterNode, PageNode, SpaceNode } from '../../../shared/api'
import {
  importInto,
  moveItem,
  newChapter,
  newPage,
  openPage,
  openPalette,
  removeItem,
  runMenuAction,
  startRename,
} from '../commands'
import { setPrefs, useStore } from '../store'
import { dropIndex, findSpace, locatePage } from '../tree'
import { Icon } from '../ui/icons'
import { RenameInput } from '../ui/RenameInput'
import { UpdatePill } from '../ui/UpdatePill'
import styles from './Sidebar.module.css'

const mod = window.zenbook.platform === 'darwin' ? '⌘' : 'Ctrl'
const ROW = 28 // px; every row in the tree has the same height
const OVERSCAN = 10

// ---------- the tree as a flat list of rows ----------

type Row =
  | { kind: 'heading'; key: string; label: string }
  | { kind: 'chapter'; key: string; chapter: ChapterNode; collapsed: boolean }
  | { kind: 'page'; key: string; page: PageNode; chapter: ChapterNode }
  | { kind: 'empty'; key: string; chapter: ChapterNode }

/**
 * Flattens the tree so only the rows in view are rendered: a 1,000-page Space
 * keeps ~50 rows (and store subscriptions) alive instead of 2,000.
 */
export function flattenTree(
  space: SpaceNode | null,
  tree: Parameters<typeof locatePage>[0],
  collapsed: string[],
): Row[] {
  if (!space) return []
  const rows: Row[] = []
  const pinned = space.pinned
    .map((id) => locatePage(tree, id))
    .filter((loc): loc is NonNullable<typeof loc> => loc !== null)
  if (pinned.length > 0) {
    rows.push({ kind: 'heading', key: 'h-pinned', label: 'Pinned' })
    for (const { page, chapter } of pinned)
      rows.push({ kind: 'page', key: `pin-${page.id}`, page, chapter })
    rows.push({ kind: 'heading', key: 'h-chapters', label: 'Chapters' })
  }
  const closed = new Set(collapsed)
  for (const chapter of space.chapters) {
    const isClosed = closed.has(chapter.id)
    rows.push({ kind: 'chapter', key: chapter.id, chapter, collapsed: isClosed })
    if (isClosed) continue
    for (const page of chapter.pages) rows.push({ kind: 'page', key: page.id, page, chapter })
    if (chapter.pages.length === 0)
      rows.push({ kind: 'empty', key: `empty-${chapter.id}`, chapter })
  }
  return rows
}

// ---------- drag and drop ----------

type Dragged = { kind: 'page' | 'chapter'; id: string } | null
let dragged: Dragged = null
type Drop = { id: string; pos: 'before' | 'after' | 'inside' } | null

const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes('Files')

function edge(e: DragEvent): 'before' | 'after' {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  return e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
}

async function menuFor(kind: 'page' | 'chapter', id: string) {
  void runMenuAction(await window.zenbook.ui.menu(kind, id), id)
}

// ---------- rows ----------

interface RowProps {
  index: number
  drop: Drop
  setDrop: (d: Drop) => void
}

function PageRow({
  page,
  chapter,
  index,
  drop,
  setDrop,
}: RowProps & { page: PageNode; chapter: ChapterNode }) {
  const active = useStore((s) => s.pageId === page.id)
  const renaming = useStore((s) => s.renamingId === page.id)
  const marker = drop?.id === page.id ? drop.pos : undefined

  if (renaming) {
    return (
      <div className={`${styles.row} ${styles.page} ${styles.editing}`}>
        <RenameInput id={page.id} name={page.name} className={styles.input} />
      </div>
    )
  }

  return (
    <button
      type="button"
      role="treeitem"
      aria-selected={active}
      data-index={index}
      data-id={page.id}
      data-kind="page"
      className={`${styles.row} ${styles.page} ${active ? styles.active : ''}`}
      data-drop={marker}
      draggable
      onClick={() => openPage(page.id)}
      onDoubleClick={() => startRename(page.id)}
      onContextMenu={(e) => {
        e.preventDefault()
        void menuFor('page', page.id)
      }}
      onDragStart={(e) => {
        dragged = { kind: 'page', id: page.id }
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', page.name)
      }}
      onDragEnd={() => {
        dragged = null
        setDrop(null)
      }}
      onDragOver={(e) => {
        if (dragged?.kind === 'page' || hasFiles(e)) {
          e.preventDefault()
          setDrop({ id: page.id, pos: dragged ? edge(e) : 'inside' })
        }
      }}
      onDragLeave={() => setDrop(null)}
      onDrop={(e) => {
        e.preventDefault()
        setDrop(null)
        if (hasFiles(e)) return void importInto(chapter.id, [...e.dataTransfer.files])
        if (dragged?.kind !== 'page' || dragged.id === page.id) return
        const ids = chapter.pages.map((p) => p.id)
        void moveItem(
          dragged.id,
          chapter.id,
          dropIndex(ids, dragged.id, page.id, edge(e) === 'after'),
        )
      }}
    >
      <span className={styles.label}>{page.name}</span>
      {page.conflict && <span className={styles.conflict} title="Conflict copy from a sync tool" />}
    </button>
  )
}

function ChapterRow({
  chapter,
  space,
  collapsed,
  index,
  drop,
  setDrop,
}: RowProps & { chapter: ChapterNode; space: SpaceNode; collapsed: boolean }) {
  const renaming = useStore((s) => s.renamingId === chapter.id)
  const marker = drop?.id === chapter.id ? drop.pos : undefined
  const toggle = () => {
    const current = useStore.getState().prefs.collapsed
    setPrefs({
      collapsed: collapsed ? current.filter((c) => c !== chapter.id) : [...current, chapter.id],
    })
  }

  if (renaming) {
    return (
      <div className={`${styles.row} ${styles.chapter} ${styles.editing}`}>
        <RenameInput id={chapter.id} name={chapter.name} className={styles.input} />
      </div>
    )
  }

  return (
    <button
      type="button"
      role="treeitem"
      aria-expanded={!collapsed}
      data-index={index}
      data-id={chapter.id}
      data-kind="chapter"
      className={`${styles.row} ${styles.chapter}`}
      data-drop={marker}
      draggable
      onClick={toggle}
      onDoubleClick={() => startRename(chapter.id)}
      onContextMenu={(e) => {
        e.preventDefault()
        void menuFor('chapter', chapter.id)
      }}
      onDragStart={(e) => {
        dragged = { kind: 'chapter', id: chapter.id }
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', chapter.name)
      }}
      onDragEnd={() => {
        dragged = null
        setDrop(null)
      }}
      onDragOver={(e) => {
        if (!dragged && !hasFiles(e)) return
        e.preventDefault()
        setDrop({ id: chapter.id, pos: dragged?.kind === 'chapter' ? edge(e) : 'inside' })
      }}
      onDragLeave={() => setDrop(null)}
      onDrop={(e) => {
        e.preventDefault()
        setDrop(null)
        if (hasFiles(e)) return void importInto(chapter.id, [...e.dataTransfer.files])
        if (dragged?.kind === 'page') return void moveItem(dragged.id, chapter.id, 100_000)
        if (dragged?.kind === 'chapter' && dragged.id !== chapter.id) {
          const ids = space.chapters.map((c) => c.id)
          void moveItem(
            dragged.id,
            space.id,
            dropIndex(ids, dragged.id, chapter.id, edge(e) === 'after'),
          )
        }
      }}
    >
      <span className={`${styles.chevron} ${collapsed ? styles.closed : ''}`}>
        <Icon name="chevronDown" size={12} />
      </span>
      <span className={styles.label}>{chapter.name}</span>
      <span className={styles.count}>{chapter.pages.length || ''}</span>
    </button>
  )
}

// ---------- the virtualised tree ----------

function Tree({ space }: { space: SpaceNode }) {
  const tree = useStore((s) => s.tree)
  const collapsed = useStore((s) => s.prefs.collapsed)
  const pageId = useStore((s) => s.pageId)
  const rows = useMemo(() => flattenTree(space, tree, collapsed), [space, tree, collapsed])
  const [drop, setDrop] = useState<Drop>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ top: 0, height: 800 })
  const pendingFocus = useRef<number | null>(null)

  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    const update = () => setView({ top: el.scrollTop, height: el.clientHeight })
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Keep the open page in view when it changes (palette, shortcuts).
  useEffect(() => {
    const el = scroller.current
    const i = rows.findIndex(
      (r) => r.kind === 'page' && r.page.id === pageId && !r.key.startsWith('pin-'),
    )
    if (!el || i < 0) return
    const top = i * ROW
    if (top < el.scrollTop || top + ROW > el.scrollTop + el.clientHeight)
      el.scrollTop = top - el.clientHeight / 3
  }, [pageId, rows])

  // Focus a row after keyboard navigation scrolled it into the rendered window.
  useEffect(() => {
    if (pendingFocus.current === null) return
    scroller.current?.querySelector<HTMLElement>(`[data-index="${pendingFocus.current}"]`)?.focus()
    pendingFocus.current = null
  })

  const first = Math.max(0, Math.floor(view.top / ROW) - OVERSCAN)
  const last = Math.min(rows.length, Math.ceil((view.top + view.height) / ROW) + OVERSCAN)

  const focusRow = (i: number) => {
    const el = scroller.current
    if (!el || rows.length === 0) return
    const index = Math.max(0, Math.min(rows.length - 1, i))
    if (index * ROW < el.scrollTop) el.scrollTop = index * ROW
    else if ((index + 1) * ROW > el.scrollTop + el.clientHeight)
      el.scrollTop = (index + 1) * ROW - el.clientHeight
    pendingFocus.current = index
    setView({ top: el.scrollTop, height: el.clientHeight })
    el.querySelector<HTMLElement>(`[data-index="${index}"]`)?.focus()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement
    const id = target.dataset.id
    if (!id || target.dataset.index === undefined) return
    const i = Number(target.dataset.index)
    const kind = target.dataset.kind
    if (e.key === 'ArrowDown') focusRow(i + 1)
    else if (e.key === 'ArrowUp') focusRow(i - 1)
    else if (e.key === 'Home') focusRow(0)
    else if (e.key === 'End') focusRow(rows.length - 1)
    else if (e.key === 'F2') startRename(id)
    else if (e.key === 'Delete' || (e.key === 'Backspace' && (e.metaKey || e.ctrlKey))) {
      void removeItem(id, kind === 'chapter' ? 'chapter' : 'page')
    } else if (kind === 'chapter' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      const isCollapsed = target.getAttribute('aria-expanded') === 'false'
      if ((e.key === 'ArrowLeft') !== isCollapsed) target.click()
    } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      void menuFor(kind === 'chapter' ? 'chapter' : 'page', id)
    } else return
    e.preventDefault()
  }

  return (
    <div
      ref={scroller}
      className={styles.scroll}
      role="tree"
      aria-label="Pages"
      onKeyDown={onKeyDown}
      onScroll={(e) =>
        setView({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })
      }
    >
      <div className={styles.spacer} style={{ height: rows.length * ROW }}>
        {rows.slice(first, last).map((row, offset) => {
          const index = first + offset
          return (
            <div
              key={row.key}
              className={styles.slot}
              style={{ transform: `translateY(${index * ROW}px)` }}
            >
              {row.kind === 'heading' && <h2 className={styles.heading}>{row.label}</h2>}
              {row.kind === 'chapter' && (
                <ChapterRow
                  chapter={row.chapter}
                  space={space}
                  collapsed={row.collapsed}
                  index={index}
                  drop={drop}
                  setDrop={setDrop}
                />
              )}
              {row.kind === 'page' && (
                <PageRow
                  page={row.page}
                  chapter={row.chapter}
                  index={index}
                  drop={drop}
                  setDrop={setDrop}
                />
              )}
              {row.kind === 'empty' && (
                <button
                  type="button"
                  className={`${styles.row} ${styles.page} ${styles.hint}`}
                  onClick={() => void newPage(row.chapter.id)}
                >
                  Empty. Add a page
                </button>
              )}
            </div>
          )
        })}
      </div>
      {space.chapters.length === 0 && (
        <div className={styles.empty}>
          <p>No chapters yet.</p>
          <button type="button" className={styles.ghost} onClick={() => void newChapter()}>
            <Icon name="plus" size={15} /> New chapter
          </button>
        </div>
      )}
    </div>
  )
}

// ---------- sidebar ----------

function SpaceHeader({ space }: { space: SpaceNode | null }) {
  const renaming = useStore((s) => (space ? s.renamingId === space.id : false))
  if (space && renaming) {
    return (
      <div className={styles.spaceEditing}>
        <RenameInput id={space.id} name={space.name} className={styles.input} />
      </div>
    )
  }
  return (
    <button
      type="button"
      className={styles.space}
      aria-label="Switch Space"
      title="Switch Space (double-click to rename)"
      onClick={async (e) => {
        if (e.detail > 1) return // part of a double-click
        void runMenuAction(await window.zenbook.ui.menu('spaces', space?.id))
      }}
      onDoubleClick={() => space && startRename(space.id)}
    >
      <span className={styles.spaceDot} />
      <span className={styles.spaceName}>{space?.name ?? 'No Space'}</span>
      <Icon name="chevronDown" size={14} />
    </button>
  )
}

function Sidebar() {
  const tree = useStore((s) => s.tree)
  const spaceId = useStore((s) => s.spaceId)
  const space = findSpace(tree, spaceId)

  return (
    <nav className={styles.sidebar} aria-label="Library">
      <div className={styles.strip}>
        <SpaceHeader space={space} />
      </div>

      <button type="button" className={styles.search} onClick={() => openPalette()}>
        <Icon name="search" size={15} />
        <span>Search</span>
        <kbd className={styles.kbd}>{mod} K</kbd>
      </button>

      {space ? <Tree space={space} /> : <div className={styles.scroll} />}

      <div className={styles.footer}>
        <button
          type="button"
          className={styles.ghost}
          onClick={() => void newPage()}
          title={`New page (${mod} N)`}
        >
          <Icon name="plus" size={15} />
          <span>New page</span>
        </button>
        <UpdatePill />
        <button
          type="button"
          className={styles.iconButton}
          aria-label="Settings"
          onClick={async () => void runMenuAction(await window.zenbook.ui.menu('settings'))}
        >
          <Icon name="more" />
        </button>
      </div>
    </nav>
  )
}

export default memo(Sidebar)
