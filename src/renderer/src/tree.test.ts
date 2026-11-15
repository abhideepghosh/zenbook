import { describe, expect, it } from 'vitest'
import type { Tree } from '../../shared/api'
import { adjacentPage, dropIndex, fallbackPage, focusableRow, locatePage } from './tree'

const page = (id: string) => ({ id, name: id, conflict: false })
const tree: Tree = {
  spaces: [
    {
      id: 'space-a',
      name: 'Work',
      color: 'sage',
      pinned: [],
      chapters: [
        { id: 'chap-1', name: 'One', pages: [page('p1'), page('p2')] },
        { id: 'chap-2', name: 'Two', pages: [page('p3')] },
      ],
    },
    {
      id: 'space-b',
      name: 'Home',
      color: 'clay',
      pinned: [],
      chapters: [{ id: 'chap-3', name: 'Three', pages: [page('p4')] }],
    },
  ],
}

describe('tree helpers', () => {
  it('locates pages with their chapter and space', () => {
    expect(locatePage(tree, 'p3')).toMatchObject({
      space: { id: 'space-a' },
      chapter: { id: 'chap-2' },
      pageIndex: 0,
    })
    expect(locatePage(tree, 'nope')).toBeNull()
  })

  it('steps through pages across chapters, but not across spaces', () => {
    expect(adjacentPage(tree, 'p2', 1)?.id).toBe('p3')
    expect(adjacentPage(tree, 'p3', -1)?.id).toBe('p2')
    expect(adjacentPage(tree, 'p3', 1)).toBeNull()
  })

  it('falls back to the neighbour of a deleted page', () => {
    const next: Tree = structuredClone(tree)
    next.spaces[0]!.chapters[0]!.pages.splice(1, 1) // p2 deleted
    expect(fallbackPage(tree, next, 'p2', 'space-a')?.id).toBe('p1')
    next.spaces[0]!.chapters[1]!.pages = [] // p3's chapter emptied
    expect(fallbackPage(tree, next, 'p3', 'space-a')?.id).toBe('p1')
  })

  it('computes drop indexes for reordering', () => {
    const ids = ['a', 'b', 'c', 'd']
    expect(dropIndex(ids, 'a', 'c', false)).toBe(1) // a before c → [b, a, c, d]
    expect(dropIndex(ids, 'a', 'c', true)).toBe(2) // a after c → [b, c, a, d]
    expect(dropIndex(ids, 'd', 'a', false)).toBe(0)
    expect(dropIndex(['x', 'y'], 'new', 'y', true)).toBe(2) // from another chapter
  })
})

describe('focusableRow', () => {
  const rows = ['heading', 'page', 'heading', 'chapter', 'empty'].map((kind) => ({ kind }))

  it('skips headings in the direction of travel', () => {
    expect(focusableRow(rows, 2, 1)).toBe(3)
    expect(focusableRow(rows, 2, -1)).toBe(1)
    expect(focusableRow(rows, 4, 1)).toBe(4) // the "Empty. Add a page" row is focusable
  })

  it('turns back at either end (Home with pinned pages lands below the heading)', () => {
    expect(focusableRow(rows, 0, 1)).toBe(1)
    expect(focusableRow(rows, 0, -1)).toBe(1)
    expect(focusableRow(rows, 99, -1)).toBe(4)
    expect(focusableRow([{ kind: 'heading' }], 0, 1)).toBeNull()
    expect(focusableRow([], 0, 1)).toBeNull()
  })
})
