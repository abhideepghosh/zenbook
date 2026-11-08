import { memo, useState, type DragEvent, type KeyboardEvent } from 'react'
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

function PageRow({
  page,
  chapter,
  drop,
  setDrop,
}: {
  page: PageNode
  chapter: ChapterNode
  drop: Drop
  setDrop: (d: Drop) => void
}) {
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
      data-nav={page.id}
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
  drop,
  setDrop,
}: {
  chapter: ChapterNode
  space: SpaceNode
  collapsed: boolean
  drop: Drop
  setDrop: (d: Drop) => void
}) {
  const renaming = useStore((s) => s.renamingId === chapter.id)
  const marker = drop?.id === chapter.id ? drop.pos : undefined
  const toggle = () => {
    const current = useStore.getState().prefs.collapsed
    setPrefs({
      collapsed: collapsed ? current.filter((c) => c !== chapter.id) : [...current, chapter.id],
    })
  }

  return (
    <div role="group">
      {renaming ? (
        <div className={`${styles.row} ${styles.chapter} ${styles.editing}`}>
          <RenameInput id={chapter.id} name={chapter.name} className={styles.input} />
        </div>
      ) : (
        <button
          type="button"
          role="treeitem"
          aria-expanded={!collapsed}
          data-nav={chapter.id}
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
      )}
      {!collapsed && (
        <div role="group">
          {chapter.pages.map((page) => (
            <PageRow key={page.id} page={page} chapter={chapter} drop={drop} setDrop={setDrop} />
          ))}
          {chapter.pages.length === 0 && (
            <button
              type="button"
              className={`${styles.row} ${styles.page} ${styles.hint}`}
              onClick={() => void newPage(chapter.id)}
            >
              Empty. Add a page
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ---------- keyboard navigation ----------

function onTreeKeyDown(e: KeyboardEvent<HTMLDivElement>) {
  const target = e.target as HTMLElement
  const id = target.dataset.nav
  if (!id) return
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-nav]')]
  const i = rows.indexOf(target)
  const kind = target.dataset.kind
  const go = (n: number) => rows[Math.max(0, Math.min(rows.length - 1, n))]?.focus()

  if (e.key === 'ArrowDown') go(i + 1)
  else if (e.key === 'ArrowUp') go(i - 1)
  else if (e.key === 'Home') go(0)
  else if (e.key === 'End') go(rows.length - 1)
  else if (e.key === 'F2') startRename(id)
  else if (e.key === 'Delete' || (e.key === 'Backspace' && (e.metaKey || e.ctrlKey))) {
    void removeItem(id, kind === 'chapter' ? 'chapter' : 'page')
  } else if (kind === 'chapter' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    const collapsed = target.getAttribute('aria-expanded') === 'false'
    if ((e.key === 'ArrowLeft') !== collapsed) target.click()
  } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
    void menuFor(kind === 'chapter' ? 'chapter' : 'page', id)
  } else return
  e.preventDefault()
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
      onClick={async () => void runMenuAction(await window.zenbook.ui.menu('spaces', space?.id))}
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
  const collapsed = useStore((s) => s.prefs.collapsed)
  const [drop, setDrop] = useState<Drop>(null)
  const space = findSpace(tree, spaceId)

  const pinned = (space?.pinned ?? [])
    .map((id) => locatePage(tree, id))
    .filter((loc): loc is NonNullable<typeof loc> => loc !== null)

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

      <div className={styles.scroll} role="tree" aria-label="Pages" onKeyDown={onTreeKeyDown}>
        {pinned.length > 0 && (
          <section className={styles.section}>
            <h2 className={styles.heading}>Pinned</h2>
            {pinned.map(({ page, chapter }) => (
              <PageRow
                key={`pin-${page.id}`}
                page={page}
                chapter={chapter}
                drop={null}
                setDrop={() => undefined}
              />
            ))}
          </section>
        )}

        <section className={styles.section}>
          {pinned.length > 0 && <h2 className={styles.heading}>Chapters</h2>}
          {space?.chapters.map((chapter) => (
            <ChapterRow
              key={chapter.id}
              chapter={chapter}
              space={space}
              collapsed={collapsed.includes(chapter.id)}
              drop={drop}
              setDrop={setDrop}
            />
          ))}
          {space && space.chapters.length === 0 && (
            <div className={styles.empty}>
              <p>No chapters yet.</p>
              <button type="button" className={styles.ghost} onClick={() => void newChapter()}>
                <Icon name="plus" size={15} /> New chapter
              </button>
            </div>
          )}
        </section>
      </div>

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
