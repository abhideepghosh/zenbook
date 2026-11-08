import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { SearchHit } from '../../../shared/api'
import { closePalette, openPage } from '../commands'
import { set, useStore } from '../store'
import { locatePage } from '../tree'
import { Icon } from '../ui/icons'
import { allActions, type Action } from './actions'
import { fuzzyFilter } from './fuzzy'
import styles from './Palette.module.css'

type Item =
  | { kind: 'page'; id: string; title: string; detail: string; hint?: string }
  | { kind: 'action'; id: string; action: Action }

const where: Record<string, string> = { notes: 'in notes', drawing: 'in drawing' }

function pageItem(hit: SearchHit): Item {
  const hint = hit.matchedIn.includes('title')
    ? undefined
    : hit.matchedIn
        .map((m) => where[m])
        .filter(Boolean)
        .join(', ')
  return {
    kind: 'page',
    id: hit.pageId,
    title: hit.title,
    detail: `${hit.chapter} · ${hit.space}`,
    hint,
  }
}

/**
 * Ctrl/Cmd+K: jump to any page (full-text search over titles, notes and drawings)
 * or run any action. A leading ">" shows actions only. Always mounted, so it opens
 * without any delay.
 */
function Palette() {
  const open = useStore((s) => s.paletteOpen)
  const seed = useStore((s) => s.paletteSeed)
  // Remounted on every open, so it always starts from a clean slate.
  return open ? <PaletteBody seed={seed} /> : null
}

function PaletteBody({ seed }: { seed: string }) {
  const recent = useStore((s) => s.prefs.recent)
  const tree = useStore((s) => s.tree)
  const [query, setQuery] = useState(seed)
  const [hits, setHits] = useState<SearchHit[]>([])
  const [active, setActive] = useState(0)
  const list = useRef<HTMLDivElement>(null)

  const actionsOnly = query.startsWith('>')
  const text = actionsOnly ? query.slice(1).trim() : query.trim()

  // Full-text search in the main process; stale answers are dropped.
  useEffect(() => {
    if (actionsOnly || !text) return
    let current = true
    void window.zenbook.search.query(text).then((result) => current && setHits(result))
    return () => {
      current = false
    }
  }, [text, actionsOnly])

  const items = useMemo<Item[]>(() => {
    const actions = allActions()
    if (actionsOnly)
      return fuzzyFilter(text, actions, (a) => a.label, 50).map((action) => ({
        kind: 'action',
        id: action.id,
        action,
      }))
    if (!text) {
      const pages = recent
        .map((id) => locatePage(tree, id))
        .filter((loc): loc is NonNullable<typeof loc> => loc !== null)
        .slice(0, 6)
        .map<Item>((loc) => ({
          kind: 'page',
          id: loc.page.id,
          title: loc.page.name,
          detail: `${loc.chapter.name} · ${loc.space.name}`,
        }))
      return [
        ...pages,
        ...actions.slice(0, 6).map<Item>((action) => ({ kind: 'action', id: action.id, action })),
      ]
    }
    const matchedActions = fuzzyFilter(text, actions, (a) => a.label, 5)
    return [
      ...(text && !actionsOnly ? hits.map(pageItem) : []),
      ...matchedActions.map<Item>((action) => ({ kind: 'action', id: action.id, action })),
    ]
  }, [actionsOnly, text, hits, recent, tree])

  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const choose = (item: Item | undefined) => {
    if (!item) return
    closePalette()
    if (item.kind === 'page') openPage(item.id)
    else item.action.run()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') setActive((i) => Math.min(i + 1, items.length - 1))
    else if (e.key === 'ArrowUp') setActive((i) => Math.max(i - 1, 0))
    else if (e.key === 'Enter') choose(items[active])
    else if (e.key === 'Escape') closePalette()
    else return
    e.preventDefault()
    e.stopPropagation()
  }

  const recentCount = !text && !actionsOnly ? items.filter((i) => i.kind === 'page').length : 0

  return (
    <div
      className={styles.backdrop}
      onMouseDown={(e) => e.target === e.currentTarget && closePalette()}
    >
      <div className={styles.palette} role="dialog" aria-label="Command palette">
        <div className={styles.inputRow}>
          <Icon name={actionsOnly ? 'command' : 'search'} size={16} />
          <input
            className={styles.input}
            autoFocus
            value={query}
            placeholder="Search pages, or type > for actions"
            spellCheck={false}
            aria-label="Search"
            aria-controls="palette-results"
            aria-activedescendant={items[active] ? `palette-${active}` : undefined}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
            }}
            onKeyDown={onKeyDown}
            onBlur={() => set({ paletteOpen: false })}
          />
        </div>
        <div ref={list} id="palette-results" className={styles.list} role="listbox">
          {items.length === 0 && (
            <p className={styles.empty}>{text ? 'Nothing matches.' : 'No pages yet.'}</p>
          )}
          {items.map((item, i) => (
            <div key={`${item.kind}-${item.id}`}>
              {i === 0 && recentCount > 0 && <p className={styles.group}>Recent</p>}
              {i === recentCount && recentCount > 0 && <p className={styles.group}>Actions</p>}
              <div
                id={`palette-${i}`}
                data-index={i}
                role="option"
                aria-selected={i === active}
                className={styles.item}
                onMouseMove={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault()
                  choose(item)
                }}
              >
                <Icon name={item.kind === 'page' ? 'file' : 'command'} size={15} />
                {item.kind === 'page' ? (
                  <>
                    <span className={styles.title}>{item.title}</span>
                    <span className={styles.detail}>
                      {item.hint ? `${item.detail} · ${item.hint}` : item.detail}
                    </span>
                  </>
                ) : (
                  <>
                    <span className={styles.title}>{item.action.label}</span>
                    {item.action.shortcut && (
                      <kbd className={styles.kbd}>{item.action.shortcut}</kbd>
                    )}
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export default memo(Palette)
