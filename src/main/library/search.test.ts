import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Library } from './library'
import { emptyScene } from './model'
import { extractDrawingText, SearchIndex } from './search'

let root: string
let cacheDir: string
const deps = { trash: async (p: string) => rmSync(p, { recursive: true, force: true }) }

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'zenbook-search-'))
  cacheDir = mkdtempSync(join(tmpdir(), 'zenbook-cache-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(cacheDir, { recursive: true, force: true })
})

function sceneWith(id: string, texts: string[]): string {
  const scene = JSON.parse(emptyScene(id))
  scene.elements = [
    ...texts.map((t, i) => ({ id: `t${i}`, type: 'text', text: t, originalText: t })),
    { id: 'gone', type: 'text', text: 'deleted words', isDeleted: true },
    { id: 'f1', type: 'frame', name: 'Election timeline' },
  ]
  return JSON.stringify(scene)
}

describe('extractDrawingText', () => {
  it('collects text elements and frame names, skipping deleted ones', () => {
    expect(extractDrawingText(sceneWith('p1234567', ['Leader', 'Follower']))).toBe(
      'Leader\nFollower\nElection timeline',
    )
    expect(extractDrawingText('not json')).toBe('')
    expect(extractDrawingText(null)).toBe('')
  })
})

describe('SearchIndex', () => {
  it('finds pages by title, notes and drawing text, and keeps results fresh', async () => {
    const lib = await Library.open(root, deps)
    const space = await lib.create('space', null, 'Work')
    const chapter = await lib.create('chapter', space, 'Distributed Systems')
    const raft = await lib.create('page', chapter, 'Lecture 3 — Raft')
    const paxos = await lib.create('page', chapter, 'Lecture 4 — Paxos')
    writeFileSync(
      join(root, 'Work', 'Distributed Systems', 'Lecture 4 — Paxos.excalidraw'),
      sceneWith(paxos, ['Proposer acceptor']),
    )
    await lib.saveNotes(raft, 'Log replication and term numbers')

    const index = new SearchIndex(lib, join(cacheDir, 'search.json'))
    await index.reconcile()

    expect(index.query('raft').map((h) => h.pageId)).toEqual([raft])
    expect(index.query('replication')[0]).toMatchObject({ pageId: raft, matchedIn: ['notes'] })
    expect(index.query('acceptor')[0]).toMatchObject({ pageId: paxos, matchedIn: ['drawing'] })
    expect(index.query('electi')[0]?.pageId).toBe(paxos) // prefix
    expect(index.query('paxs')[0]?.pageId).toBe(paxos) // typo tolerance
    expect(index.query('   ')).toEqual([])

    // A save updates the index without touching the disk again.
    await index.update(raft, { drawing: 'Heartbeat timeout' })
    expect(index.query('heartbeat')[0]?.pageId).toBe(raft)

    // Renames and deletions follow the tree.
    await lib.rename(raft, 'Consensus')
    index.syncTree(lib.model)
    expect(index.query('consensus')[0]?.title).toBe('Consensus')
    await lib.remove(paxos)
    await lib.commitAllRemovals()
    index.syncTree(lib.model)
    expect(index.query('acceptor')).toEqual([])
  })

  it('reuses its cache, re-reading only pages changed since', async () => {
    const lib = await Library.open(root, deps)
    const space = await lib.create('space', null, 'Work')
    const chapter = await lib.create('chapter', space, 'Notes')
    const page = await lib.create('page', chapter, 'Today')
    await lib.saveNotes(page, 'quiet morning')
    const file = join(cacheDir, 'search.json')

    const first = new SearchIndex(lib, file)
    await first.reconcile()
    await first.save()

    const second = new SearchIndex(lib, file)
    expect(second.query('morning')[0]?.pageId).toBe(page) // served from cache before reconcile
    await new Promise((r) => setTimeout(r, 20))
    await lib.saveNotes(page, 'busy evening')
    await second.reconcile()
    expect(second.query('evening')[0]?.pageId).toBe(page)
    expect(second.query('morning')).toEqual([])
  })

  it('answers quickly on a large library', async () => {
    const lib = await Library.open(root, deps)
    const index = new SearchIndex(lib, join(cacheDir, 'search.json'))
    const space = await lib.create('space', null, 'Big')
    const chapter = await lib.create('chapter', space, 'All')
    lib.model.spaces[0]!.chapters[0]!.pages = Array.from({ length: 1000 }, (_, i) => ({
      id: `page-${String(i).padStart(5, '0')}`,
      name: `Page ${i} about topic ${i % 37}`,
    }))
    index.syncTree(lib.model)
    for (let i = 0; i < 1000; i++) {
      await index.update(`page-${String(i).padStart(5, '0')}`, {
        notes: `Notes ${i} mention keyword${i % 50} and some filler text about systems`,
        drawing: `Box ${i} arrow label${i % 13}`,
      })
    }
    void chapter
    const start = performance.now()
    const hits = index.query('keyword7 systems')
    const elapsed = performance.now() - start
    expect(hits.length).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(100)
  })
})
