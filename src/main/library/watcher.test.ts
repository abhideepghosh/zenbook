import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Library } from './library'
import { isIgnored, watchLibrary } from './watcher'

const deps = { trash: async (p: string) => rmSync(p, { recursive: true, force: true }) }
const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

async function waitFor(check: () => boolean, ms = 4000) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe('isIgnored', () => {
  const root = join('/', 'lib')
  it('ignores dot-folders and temp files but not normal content', () => {
    expect(isIgnored(root, join(root, 'Work', '.assets', 'a.png'))).toBe(true)
    expect(isIgnored(root, join(root, '.trash', 'x'))).toBe(true)
    expect(isIgnored(root, join(root, 'Work', 'A', 'p.excalidraw.ab12cd34.tmp'))).toBe(true)
    expect(isIgnored(root, join(root, 'Work', 'A', 'p.excalidraw'))).toBe(false)
    expect(isIgnored(root, root)).toBe(false)
  })
})

describe('watchLibrary', () => {
  it('reports external edits to a page, ignores our own, and rescans on new files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zenbook-watch-'))
    roots.push(root)
    const lib = await Library.open(root, deps)
    const space = await lib.create('space', null, 'Work')
    const chapter = await lib.create('chapter', space, 'Notes')
    const page = await lib.create('page', chapter, 'Today')

    const changed: string[] = []
    lib.on('pageChanged', (id) => changed.push(id))
    const stop = watchLibrary(lib)
    await new Promise((r) => setTimeout(r, 400)) // let the watcher settle

    // Our own save must not look like an external change.
    await lib.saveNotes(page, 'mine')
    await new Promise((r) => setTimeout(r, 600))
    expect(changed).toEqual([])

    // Another app edits the notes file.
    writeFileSync(join(root, 'Work', 'Notes', 'Today.md'), 'theirs, a different length')
    await waitFor(() => changed.includes(page))

    // A sync tool drops in a new page.
    writeFileSync(
      join(root, 'Work', 'Notes', 'From phone.excalidraw'),
      '{"type":"excalidraw","elements":[]}',
    )
    await waitFor(() =>
      lib.tree().spaces[0]!.chapters[0]!.pages.some((p) => p.name === 'From phone'),
    )

    await stop()
  }, 15_000)

  it('never locks folders: Spaces and chapters can be renamed while watching', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zenbook-watch-'))
    roots.push(root)
    const lib = await Library.open(root, deps)
    const space = await lib.create('space', null, 'Untitled Space')
    const chapter = await lib.create('chapter', space, 'Notes')
    await lib.create('page', chapter, 'Today')
    const stop = watchLibrary(lib)
    await new Promise((r) => setTimeout(r, 400))

    await lib.rename(space, 'Work')
    await lib.rename(chapter, 'Ideas')
    expect(lib.tree().spaces[0]).toMatchObject({ name: 'Work', chapters: [{ name: 'Ideas' }] })
    await lib.remove(space)
    await lib.commitAllRemovals()
    expect(lib.tree().spaces).toEqual([])

    await stop()
  }, 15_000)
})
