import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Library } from './library'
import { emptyScene } from './model'

let root: string
let trashed: string[]
const deps = {
  trash: async (path: string) => {
    trashed.push(path)
    rmSync(path, { recursive: true, force: true })
  },
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'zenbook-lib-'))
  trashed = []
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(root, { recursive: true, force: true })
})

const readJson = (...p: string[]) => JSON.parse(readFileSync(join(root, ...p), 'utf8'))

async function seeded() {
  const lib = await Library.open(root, deps)
  const space = await lib.create('space', null, 'Work')
  const chapter = await lib.create('chapter', space, 'Distributed Systems')
  const a = await lib.create('page', chapter, 'Lecture 1')
  const b = await lib.create('page', chapter, 'Lecture 2')
  return { lib, space, chapter, a, b }
}

describe('Library: create and scan', () => {
  it('initialises an empty folder', async () => {
    const lib = await Library.open(root, deps)
    expect(readJson('zenbook.json')).toEqual({ format: 1, spaces: [] })
    expect(lib.tree()).toEqual({ spaces: [] })
  })

  it('creates spaces, chapters and pages as folders and files', async () => {
    const { lib, space, chapter, a } = await seeded()
    expect(existsSync(join(root, 'Work', 'Distributed Systems', 'Lecture 1.excalidraw'))).toBe(true)
    expect(readJson('Work', 'space.json').chapters).toEqual([chapter])
    expect(readJson('Work', 'Distributed Systems', 'chapter.json').pages[0]).toEqual({
      id: a,
      file: 'Lecture 1',
    })
    const scene = readJson('Work', 'Distributed Systems', 'Lecture 1.excalidraw')
    expect(scene.type).toBe('excalidraw')
    expect(scene.zenbook.id).toBe(a)
    expect(lib.tree().spaces[0]?.id).toBe(space)
  })

  it('a fresh scan reproduces the same tree (IDs and order persist)', async () => {
    const { lib } = await seeded()
    const before = lib.tree()
    const again = await Library.open(root, deps)
    expect(again.tree()).toEqual(before)
  })

  it('numbers duplicate names and sanitises illegal characters', async () => {
    const { lib, chapter } = await seeded()
    await lib.create('page', chapter, 'Lecture 1')
    await lib.create('page', chapter, 'What? <draft>')
    const names = lib.tree().spaces[0]?.chapters[0]?.pages.map((p) => p.name)
    expect(names).toEqual(['Lecture 1', 'Lecture 2', 'Lecture 1 2', 'What- -draft-'])
  })

  it('creates a page right after another page', async () => {
    const { lib, a } = await seeded()
    const c = await lib.create('page', a, 'Between')
    const ids = lib.tree().spaces[0]?.chapters[0]?.pages.map((p) => p.id)
    expect(ids?.[1]).toBe(c)
  })
})

describe('Library: rename, move, reorder, duplicate, pin', () => {
  it('renames a page together with its notes', async () => {
    const { lib, a } = await seeded()
    await lib.saveNotes(a, '# hello')
    await lib.rename(a, 'Raft')
    const dir = join(root, 'Work', 'Distributed Systems')
    expect(readdirSync(dir).sort()).toEqual([
      'Lecture 2.excalidraw',
      'Raft.excalidraw',
      'Raft.md',
      'chapter.json',
    ])
    expect((await lib.readPage(a)).notes).toBe('# hello')
  })

  it('allows a case-only rename', async () => {
    const { lib, a } = await seeded()
    await lib.rename(a, 'lecture 1')
    expect(lib.tree().spaces[0]?.chapters[0]?.pages[0]?.name).toBe('lecture 1')
  })

  it('renames chapters and spaces as folders', async () => {
    const { lib, space, chapter } = await seeded()
    await lib.rename(chapter, 'Systems')
    await lib.rename(space, 'Job')
    expect(existsSync(join(root, 'Job', 'Systems', 'Lecture 1.excalidraw'))).toBe(true)
  })

  it('reorders pages within a chapter', async () => {
    const { lib, a, b } = await seeded()
    await lib.move(b, lib.tree().spaces[0]!.chapters[0]!.id, 0)
    expect(lib.tree().spaces[0]?.chapters[0]?.pages.map((p) => p.id)).toEqual([b, a])
    expect(
      (await Library.open(root, deps)).tree().spaces[0]?.chapters[0]?.pages.map((p) => p.id),
    ).toEqual([b, a])
  })

  it('moves a page into another chapter and another space, carrying its images', async () => {
    const { lib, space, a } = await seeded()
    const other = await lib.create('chapter', space, 'Reading')
    await lib.pin(a, true)
    await lib.move(a, other, 0)
    expect(existsSync(join(root, 'Work', 'Reading', 'Lecture 1.excalidraw'))).toBe(true)

    // Give the page an image, then move it to a new space.
    const scene = JSON.parse(emptyScene(a))
    scene.elements = [{ type: 'image', fileId: 'abc123def456', id: 'el1' }]
    await lib.saveScene(a, JSON.stringify(scene))
    await lib.putAssets(a, [
      { id: 'abc123def456', mimeType: 'image/png', dataURL: 'data:image/png;base64,iVBORw0KGgo=' },
    ])
    const personal = await lib.create('space', null, 'Personal')
    const inbox = await lib.create('chapter', personal, 'Inbox')
    await lib.move(a, inbox, 0)
    expect(existsSync(join(root, 'Personal', '.assets', 'abc123def456.png'))).toBe(true)
    expect(lib.tree().spaces[0]?.pinned).toEqual([]) // pins are per space
  })

  it('reorders chapters and spaces', async () => {
    const { lib, space, chapter } = await seeded()
    const second = await lib.create('chapter', space, 'Second')
    await lib.move(second, space, 0)
    expect(lib.tree().spaces[0]?.chapters.map((c) => c.id)).toEqual([second, chapter])
    const other = await lib.create('space', null, 'Other')
    await lib.move(other, null, 0)
    expect(readJson('zenbook.json').spaces[0]).toBe(other)
  })

  it('duplicates a page with a fresh ID, next to the original', async () => {
    const { lib, a } = await seeded()
    await lib.saveNotes(a, 'notes')
    const copy = await lib.duplicate(a)
    const pages = lib.tree().spaces[0]!.chapters[0]!.pages
    expect(pages[1]).toEqual({ id: copy, name: 'Lecture 1 copy', conflict: false })
    const data = await lib.readPage(copy)
    expect(JSON.parse(data.scene!).zenbook.id).toBe(copy)
    expect(data.notes).toBe('notes')
  })

  it('pins pages per space and recolours spaces', async () => {
    const { lib, space, a } = await seeded()
    await lib.pin(a, true)
    await lib.setColor(space, 'plum')
    expect(readJson('Work', 'space.json')).toMatchObject({ color: 'plum', pinned: [a] })
  })
})

describe('Library: delete with undo', () => {
  it('hides immediately, and undo brings it back untouched', async () => {
    const { lib, a } = await seeded()
    await lib.remove(a)
    expect(lib.tree().spaces[0]?.chapters[0]?.pages.map((p) => p.id)).not.toContain(a)
    await lib.undoRemove(a)
    expect(lib.tree().spaces[0]?.chapters[0]?.pages.map((p) => p.id)).toContain(a)
    expect(trashed).toEqual([])
  })

  it('moves the files to the trash once the undo window passes', async () => {
    const { lib, a } = await seeded()
    await lib.saveNotes(a, 'bye')
    await lib.remove(a)
    await lib.commitAllRemovals()
    expect(trashed.map((p) => p.split(/[\\/]/).pop()).sort()).toEqual([
      'Lecture 1.excalidraw',
      'Lecture 1.md',
    ])
    expect(readJson('Work', 'Distributed Systems', 'chapter.json').pages).toHaveLength(1)
  })

  it('falls back to a .trash folder when the OS trash fails', async () => {
    const lib = await Library.open(root, {
      trash: async () => {
        throw new Error('no trash here')
      },
    })
    const s = await lib.create('space', null, 'Temp')
    await lib.remove(s)
    await lib.commitAllRemovals()
    expect(readdirSync(join(root, '.trash'))[0]).toMatch(/Temp$/)
  })

  it('brings an item back, with a notice, when it cannot be trashed at all', async () => {
    const lib = await Library.open(root, {
      trash: async () => {
        throw new Error('no trash here')
      },
    })
    writeFileSync(join(root, '.trash'), 'a file where the fallback folder should go')
    const notices: string[] = []
    lib.on('notice', (m) => notices.push(m))
    const s = await lib.create('space', null, 'Temp')
    await lib.remove(s)
    expect(lib.tree().spaces).toEqual([])
    await lib.commitAllRemovals()
    expect(lib.tree().spaces.map((x) => x.name)).toEqual(['Temp'])
    expect(existsSync(join(root, 'Temp'))).toBe(true)
    expect(notices).toEqual([
      expect.stringMatching(/^Couldn’t delete “Temp”: .*back in the sidebar/),
    ])
  })

  // Windows refuses to move a folder while anything inside it is open. Handing such a
  // folder to the Recycle Bin pops up an "administrator permission" dialog, so it
  // must never get that far.
  it.runIf(process.platform === 'win32')(
    'never hands a locked Space to the OS trash',
    async () => {
      const { lib, space } = await seeded()
      const notices: string[] = []
      lib.on('notice', (m) => notices.push(m))
      const fd = openSync(join(root, 'Work', 'Distributed Systems', 'Lecture 1.excalidraw'), 'r')
      try {
        await lib.remove(space)
        await lib.commitAllRemovals()
      } finally {
        closeSync(fd)
      }
      expect(trashed).toEqual([])
      expect(lib.tree().spaces.map((x) => x.name)).toEqual(['Work'])
      expect(readdirSync(root).sort()).toEqual(['Work', 'zenbook.json'])
      expect(notices).toEqual([expect.stringMatching(/open in another program/)])

      // Once it's closed, deleting works.
      await lib.remove(space)
      await lib.commitAllRemovals()
      expect(trashed.map((p) => p.split(/[\\/]/).pop())).toEqual(['Work'])
      expect(lib.tree().spaces).toEqual([])
    },
    15_000,
  )

  it.runIf(process.platform === 'win32')(
    'explains a rename that another program blocks',
    async () => {
      const { lib, space } = await seeded()
      const fd = openSync(join(root, 'Work', 'Distributed Systems', 'Lecture 1.excalidraw'), 'r')
      try {
        await expect(lib.rename(space, 'Job')).rejects.toThrow(
          /“Work” is in use by another program/,
        )
      } finally {
        closeSync(fd)
      }
      await lib.rename(space, 'Job')
      expect(lib.tree().spaces[0]?.name).toBe('Job')
    },
    15_000,
  )
})

describe('Library: pages, notes and assets', () => {
  it('writes notes only when non-empty and removes the file when cleared', async () => {
    const { lib, a } = await seeded()
    const md = join(root, 'Work', 'Distributed Systems', 'Lecture 1.md')
    await lib.saveNotes(a, '   ')
    expect(existsSync(md)).toBe(false)
    await lib.saveNotes(a, 'Leader election')
    expect(readFileSync(md, 'utf8')).toBe('Leader election')
    await lib.saveNotes(a, '')
    expect(existsSync(md)).toBe(false)
  })

  it('refuses to treat an unreadable page as empty', async () => {
    const { lib, a } = await seeded()
    rmSync(join(root, 'Work', 'Distributed Systems', 'Lecture 1.excalidraw'))
    await expect(lib.readPage(a)).rejects.toThrow()
  })

  it('stores each image once, content-addressed, and reads it back', async () => {
    const { lib, a, b } = await seeded()
    const file = {
      id: 'f00dcafe1234',
      mimeType: 'image/png',
      dataURL: 'data:image/png;base64,iVBORw0KGgo=',
    }
    await lib.putAssets(a, [file])
    await lib.putAssets(b, [file])
    expect(readdirSync(join(root, 'Work', '.assets'))).toEqual(['f00dcafe1234.png'])
    expect(await lib.getAssets(a, ['f00dcafe1234', 'missing00000'])).toEqual([file])
  })

  it('keeps local edits as a conflict copy next to the page', async () => {
    const { lib, a } = await seeded()
    const copy = await lib.saveConflictCopy(a, emptyScene(a), 'mine')
    const pages = lib.tree().spaces[0]!.chapters[0]!.pages
    expect(pages[1]?.id).toBe(copy)
    expect(pages[1]?.conflict).toBe(true)
    expect(pages[1]?.name).toMatch(/^Lecture 1 \(conflict \d{4}-\d{2}-\d{2} \d{4}\)$/)
  })

  it('imports .excalidraw files and ignores anything else', async () => {
    const { lib, chapter } = await seeded()
    const outside = mkdtempSync(join(tmpdir(), 'zenbook-import-'))
    writeFileSync(
      join(outside, 'Sketch.excalidraw'),
      JSON.stringify({ type: 'excalidraw', elements: [] }),
    )
    writeFileSync(join(outside, 'notes.txt'), 'nope')
    writeFileSync(join(outside, 'Bad.excalidraw'), '{"type":"other"}')
    const n = await lib.importFiles(chapter, [
      join(outside, 'Sketch.excalidraw'),
      join(outside, 'notes.txt'),
      join(outside, 'Bad.excalidraw'),
    ])
    expect(n).toBe(1)
    expect(lib.tree().spaces[0]?.chapters[0]?.pages.map((p) => p.name)).toContain('Sketch')
    rmSync(outside, { recursive: true, force: true })
  })
})

describe('Library: external changes', () => {
  it('appends files added outside the app, reusing their embedded ID', async () => {
    const { lib, a } = await seeded()
    const dir = join(root, 'Work', 'Distributed Systems')
    writeFileSync(join(dir, 'Synced.excalidraw'), emptyScene('embedded-id-0001'))
    writeFileSync(join(dir, 'Copied.excalidraw'), emptyScene(a)) // duplicate ID → gets a new one
    await lib.rescan()
    const pages = lib.tree().spaces[0]!.chapters[0]!.pages
    expect(pages.map((p) => p.name)).toEqual(['Lecture 1', 'Lecture 2', 'Copied', 'Synced'])
    expect(pages[3]?.id).toBe('embedded-id-0001')
    expect(pages[2]?.id).not.toBe(a)
  })

  it('drops pages whose files were deleted, and picks up renamed folders', async () => {
    const { lib } = await seeded()
    rmSync(join(root, 'Work', 'Distributed Systems', 'Lecture 2.excalidraw'))
    const { renameSync } = await import('node:fs')
    renameSync(join(root, 'Work', 'Distributed Systems'), join(root, 'Work', 'DS'))
    mkdirSync(join(root, 'Work', 'New Chapter'))
    await lib.rescan()
    const chapters = lib.tree().spaces[0]!.chapters
    expect(chapters.map((c) => c.name)).toEqual(['DS', 'New Chapter'])
    expect(chapters[0]?.pages.map((p) => p.name)).toEqual(['Lecture 1'])
  })

  it('flags sync-tool conflict copies', async () => {
    const { lib } = await seeded()
    writeFileSync(
      join(root, 'Work', 'Distributed Systems', "Lecture 1 (Abhi's conflicted copy).excalidraw"),
      emptyScene('x'.repeat(10)),
    )
    await lib.rescan()
    expect(lib.tree().spaces[0]?.chapters[0]?.pages.at(-1)?.conflict).toBe(true)
  })

  it('maps a changed file path back to its page', async () => {
    const { lib, a } = await seeded()
    expect(lib.pageIdForPath(join(root, 'Work', 'Distributed Systems', 'Lecture 1.md'))).toBe(a)
    expect(lib.pageIdForPath(join(root, 'Work', 'nope.md'))).toBeNull()
  })

  it('refuses a library from a newer format', async () => {
    writeFileSync(join(root, 'zenbook.json'), JSON.stringify({ format: 99, spaces: [] }))
    await expect(Library.open(root, deps)).rejects.toThrow(/newer version/)
  })
})
