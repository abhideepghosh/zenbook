import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Library } from './library'
import { emptyScene } from './model'

// Simulated disk failures. `rename` and `open` (used by atomicWrite) consult these
// hooks; by default everything passes through to the real file system.
const faults = vi.hoisted(() => ({
  rename: null as null | ((from: string, to: string) => boolean),
  write: null as null | ((path: string) => boolean),
  /** Returns an error code to fail reading this path with, or null. */
  read: null as null | ((path: string) => string | null),
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const fail = (what: string) => Object.assign(new Error(`EIO: simulated ${what}`), { code: 'EIO' })
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (faults.rename?.(String(from), String(to))) throw fail('rename failure')
      return actual.rename(from, to)
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const code = faults.read?.(String(args[0]))
      if (code) throw Object.assign(new Error(`${code}: simulated read failure`), { code })
      return actual.readFile(...args)
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      if (faults.write?.(String(args[0]))) throw fail('write failure')
      return actual.open(...args)
    },
  }
})

const isHidden = (p: string) => /^..*.zb-[0-9a-f]{8}$/.test(basename(p))
/** Every file and folder under the library, as relative paths. */
function walk(dir = root): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const rel = relative(root, join(dir, e.name))
    return e.isDirectory() ? [rel, ...walk(join(dir, e.name))] : [rel]
  })
}

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
  faults.rename = null
  faults.write = null
  faults.read = null
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

  it('falls back to a .trash folder when the OS trash never answers', async () => {
    const lib = await Library.open(root, {
      trash: () => new Promise<void>(() => undefined),
      trashTimeoutMs: 50,
    })
    const s = await lib.create('space', null, 'Temp')
    await lib.remove(s)
    await lib.commitAllRemovals()
    expect(readdirSync(join(root, '.trash'))[0]).toMatch(/Temp$/)
    expect(existsSync(join(root, 'Temp'))).toBe(false)
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
    const newer = JSON.stringify({ format: 99, spaces: [] })
    writeFileSync(join(root, 'zenbook.json'), newer)
    await expect(Library.open(root, deps)).rejects.toThrow(/newer version/)
    expect(readFileSync(join(root, 'zenbook.json'), 'utf8')).toBe(newer) // never rewritten
    expect(readdirSync(root)).toEqual(['zenbook.json'])
  })
})

describe('Library: unreadable metadata is never overwritten', () => {
  it('keeps a space.json it cannot parse, with its ID, colour and pins', async () => {
    const { lib, space, chapter, a } = await seeded()
    await lib.pin(a, true)
    await lib.setColor(space, 'plum')
    const notices: string[] = []
    lib.on('notice', (m) => notices.push(m))
    const file = join(root, 'Work', 'space.json')
    const broken = `{ "id": "${space}", <<<<<<< merge conflict`
    writeFileSync(file, broken)

    await lib.rescan()
    await lib.rescan() // the notice is shown once, not on every rescan
    expect(readFileSync(file, 'utf8')).toBe(broken)
    expect(lib.tree().spaces[0]).toMatchObject({ id: space, color: 'plum', pinned: [a] })
    expect(lib.tree().spaces[0]?.chapters[0]?.id).toBe(chapter)
    expect(notices).toEqual(['Couldn’t read “Work/space.json”; it was left as it is.'])

    // Changes that would rewrite it are refused, and the model isn't half-changed.
    await expect(lib.setColor(space, 'sage')).rejects.toThrow(/won’t change it/)
    await expect(lib.create('chapter', space, 'New')).rejects.toThrow(/won’t change it/)
    expect(readFileSync(file, 'utf8')).toBe(broken)
    expect(existsSync(join(root, 'Work', 'New'))).toBe(false)
    expect(lib.tree().spaces[0]?.color).toBe('plum')
    // zenbook.json lists the Space by ID, so it isn't rewritten meanwhile either.
    await expect(lib.create('space', null, 'Other')).rejects.toThrow(/space\.json/)
    expect(existsSync(join(root, 'Other'))).toBe(false)

    // Once it's fixed, everything carries on.
    writeFileSync(
      file,
      JSON.stringify({ id: space, color: 'plum', chapters: [chapter], pinned: [a] }),
    )
    await lib.rescan()
    await lib.setColor(space, 'sage')
    expect(readJson('Work', 'space.json')).toMatchObject({ id: space, color: 'sage', pinned: [a] })
  })

  it('keeps the known IDs and page order when chapter.json breaks while open', async () => {
    const { lib, space, chapter, a, b } = await seeded()
    await lib.move(b, chapter, 0)
    const file = join(root, 'Work', 'Distributed Systems', 'chapter.json')
    writeFileSync(file, '{ not json')
    await lib.rescan()
    expect(readFileSync(file, 'utf8')).toBe('{ not json')
    const c = lib.tree().spaces[0]!.chapters[0]!
    expect(c.id).toBe(chapter)
    expect(c.pages.map((p) => p.id)).toEqual([b, a])
    expect(readJson('Work', 'space.json').chapters).toEqual([chapter])
    // A new page would rewrite it: refused before anything is written.
    await expect(lib.create('page', chapter, 'Extra')).rejects.toThrow(/chapter\.json/)
    expect(existsSync(join(root, 'Work', 'Distributed Systems', 'Extra.excalidraw'))).toBe(false)
    // space.json lists the chapter by ID, so it waits too.
    await expect(lib.pin(a, true)).rejects.toThrow(/chapter\.json/)
    expect(readJson('Work', 'space.json').pinned).toEqual([])
    expect(lib.tree().spaces[0]?.id).toBe(space)
  })

  it('still shows a chapter whose chapter.json is unreadable on open, rewriting nothing', async () => {
    const { lib, chapter, a, b } = await seeded()
    await lib.close()
    const file = join(root, 'Work', 'Distributed Systems', 'chapter.json')
    writeFileSync(file, '')
    const again = await Library.open(root, deps)
    const notices: string[] = []
    again.on('notice', (m) => notices.push(m))
    again.replayNotices()
    expect(readFileSync(file, 'utf8')).toBe('')
    const pages = again.tree().spaces[0]!.chapters[0]!.pages
    expect(pages.map((p) => p.id).sort()).toEqual([a, b].sort()) // recovered from the scenes
    // space.json isn't rewritten either, so the chapter's real ID keeps its place.
    expect(readJson('Work', 'space.json').chapters).toEqual([chapter])
    expect(notices).toEqual([
      'Couldn’t read “Work/Distributed Systems/chapter.json”; it was left as it is.',
    ])
  })

  it.each([
    ['invalid JSON', '{"format": 1, "spa'],
    ['an empty file', ''],
    ['JSON that is not an object', '[1, 2]'],
  ])('rebuilds a damaged zenbook.json (%s), keeping the old one aside', async (_, broken) => {
    const { lib, space } = await seeded()
    const other = await lib.create('space', null, 'Other')
    await lib.close()
    const file = join(root, 'zenbook.json')
    writeFileSync(file, broken)

    const again = await Library.open(root, deps) // opens, rather than locking the user out
    const notices: string[] = []
    again.on('notice', (m) => notices.push(m))
    again.replayNotices()
    expect(
      again
        .tree()
        .spaces.map((s) => s.id)
        .sort(),
    ).toEqual([space, other].sort())
    expect(readJson('zenbook.json')).toMatchObject({ format: 1 })
    const kept = readdirSync(root).filter((n) => /^zenbook\.json\.corrupt-\d{8}-\d{6}$/.test(n))
    expect(kept).toHaveLength(1)
    expect(readFileSync(join(root, kept[0]!), 'utf8')).toBe(broken)
    expect(notices).toEqual([
      `“zenbook.json” was damaged, so Zenbook rebuilt it. The old file was kept as “${kept[0]}”.`,
    ])
    // Structural edits carry on as normal.
    await again.create('space', null, 'Third')
  })

  it('rides out a sync tool that truncates zenbook.json and then writes it', async () => {
    const { lib } = await seeded()
    const file = join(root, 'zenbook.json')
    const good = readFileSync(file, 'utf8')
    const notices: string[] = []
    lib.on('notice', (m) => notices.push(m))
    writeFileSync(file, '')
    setTimeout(() => writeFileSync(file, good), 60)
    await lib.rescan()
    expect(readdirSync(root).filter((n) => n.includes('corrupt'))).toEqual([])
    expect(readFileSync(file, 'utf8')).toBe(good)
    expect(notices).toEqual([])
  })

  it('rides out a truncated space.json the same way', async () => {
    const { lib, space } = await seeded()
    await lib.setColor(space, 'plum')
    const file = join(root, 'Work', 'space.json')
    const good = readFileSync(file, 'utf8')
    const notices: string[] = []
    lib.on('notice', (m) => notices.push(m))
    writeFileSync(file, '')
    setTimeout(() => writeFileSync(file, good), 60)
    await lib.rescan()
    expect(notices).toEqual([])
    await lib.setColor(space, 'sage') // not treated as unreadable
    expect(readJson('Work', 'space.json').color).toBe('sage')
  })

  it('refuses to open a zenbook.json that is locked, and says so', async () => {
    const { lib, space } = await seeded()
    faults.read = (p) => (basename(p) === 'zenbook.json' ? 'EBUSY' : null)
    await expect(lib.rescan()).rejects.toThrow(/“zenbook\.json” is in use by another program/)
    expect(lib.tree().spaces[0]?.id).toBe(space) // the last good model stays
    // Nothing structural is written while its format can't be checked.
    await expect(lib.create('space', null, 'More')).rejects.toThrow(/zenbook\.json/)
    expect(existsSync(join(root, 'More'))).toBe(false)
    await expect(Library.open(root, deps)).rejects.toThrow(/in use by another program/)
    faults.read = (p) => (basename(p) === 'zenbook.json' ? 'EACCES' : null)
    await expect(Library.open(root, deps)).rejects.toThrow(/isn’t allowed to read/)
    faults.read = null
    expect(readdirSync(root).filter((n) => n.includes('corrupt'))).toEqual([])
    await lib.rescan()
    await lib.create('space', null, 'More')
  })

  it('does not blame another program when zenbook.json is unreadable for other reasons', async () => {
    const { lib } = await seeded()
    await lib.close()
    rmSync(join(root, 'zenbook.json'))
    mkdirSync(join(root, 'zenbook.json')) // a folder where the file should be
    const err = await Library.open(root, deps).catch((e: unknown) => e)
    expect(String(err)).toMatch(/Couldn’t read “zenbook\.json” \(.*EISDIR/)
    expect(String(err)).not.toMatch(/another program/)
  })

  it('reports a failed background rescan once', async () => {
    const { lib } = await seeded()
    const notices: string[] = []
    lib.on('notice', (m) => notices.push(m))
    writeFileSync(join(root, 'zenbook.json'), JSON.stringify({ format: 99, spaces: [] }))
    for (let i = 0; i < 2; i++) {
      await lib.rescan().catch((e: unknown) => lib.reportRescanFailure(e))
    }
    expect(notices).toEqual([expect.stringMatching(/newer version/)])
  })
})

describe('Library: metadata write-back is best effort', () => {
  it('a failed write-back neither fails the scan nor repeats its notice', async () => {
    const { lib, a } = await seeded()
    const notices: string[] = []
    lib.on('notice', (m) => notices.push(m))
    // Someone deletes chapter.json; the scan wants to write it back, but can't.
    rmSync(join(root, 'Work', 'Distributed Systems', 'chapter.json'))
    faults.write = (p) => basename(p).startsWith('chapter.json')
    await lib.rescan()
    await lib.rescan()
    expect(lib.tree().spaces[0]?.chapters[0]?.pages.map((p) => p.id)).toContain(a)
    expect(notices).toEqual([
      expect.stringMatching(/^Couldn’t update “Work\/Distributed Systems\/chapter\.json”/),
    ])
    // Opening still works too.
    const again = await Library.open(root, deps)
    expect(again.tree().spaces[0]?.chapters[0]?.pages).toHaveLength(2)
    faults.write = null
    await lib.rescan()
    expect(readJson('Work', 'Distributed Systems', 'chapter.json').pages).toHaveLength(2)
  })
})

describe('Library: failed deletes never strand files under hidden names', () => {
  const pageDir = () => join(root, 'Work', 'Distributed Systems')

  it('a locked notes file: nothing is trashed and the page stays whole', async () => {
    const { lib, a } = await seeded()
    await lib.saveNotes(a, 'keep me')
    const notices: string[] = []
    lib.on('notice', (m) => notices.push(m))
    faults.rename = (from) => basename(from) === 'Lecture 1.md'
    await lib.remove(a)
    await lib.commitAllRemovals()
    expect(trashed).toEqual([])
    expect(walk().filter(isHidden)).toEqual([])
    expect(readdirSync(pageDir())).toContain('Lecture 1.excalidraw')
    expect(lib.tree().spaces[0]?.chapters[0]?.pages.map((p) => p.id)).toContain(a)
    expect(notices).toEqual([
      expect.stringMatching(/^Couldn’t delete “Lecture 1”: .*back in the sidebar/),
    ])
  })

  it('a drawing that could not be renamed back is restored when the notes are locked', async () => {
    const { lib, a } = await seeded()
    await lib.saveNotes(a, 'keep me')
    const notices: string[] = []
    lib.on('notice', (m) => notices.push(m))
    let backAttempts = 0
    faults.rename = (from, to) => {
      if (basename(from) === 'Lecture 1.md') return true // the notes are locked
      // The drawing's first rename back fails; putting it back afterwards works.
      if (isHidden(from) && basename(to) === 'Lecture 1.excalidraw') return backAttempts++ === 0
      return false
    }
    await lib.remove(a)
    await lib.commitAllRemovals()
    expect(trashed).toEqual([])
    expect(walk().filter(isHidden)).toEqual([])
    expect(readdirSync(pageDir()).sort()).toEqual([
      'Lecture 1.excalidraw',
      'Lecture 1.md',
      'Lecture 2.excalidraw',
      'chapter.json',
    ])
    expect(lib.tree().spaces[0]?.chapters[0]?.pages.map((p) => p.id)).toContain(a)
    expect(notices).toEqual([expect.stringMatching(/back in the sidebar/)])
  })

  it('if the original name cannot be restored, uses a visible “(could not delete)” name', async () => {
    const { lib, a } = await seeded()
    await lib.saveNotes(a, 'keep me')
    const notices: string[] = []
    lib.on('notice', (m) => notices.push(m))
    faults.rename = (from, to) =>
      basename(from) === 'Lecture 1.md' ||
      (isHidden(from) && basename(to) === 'Lecture 1.excalidraw')
    await lib.remove(a)
    await lib.commitAllRemovals()
    expect(trashed).toEqual([])
    expect(walk().filter(isHidden)).toEqual([])
    expect(readdirSync(pageDir())).toContain('Lecture 1 (could not delete).excalidraw')
    // Same page (the ID is embedded in the drawing), under its new name.
    const page = lib.tree().spaces[0]?.chapters[0]?.pages.find((p) => p.id === a)
    expect(page?.name).toBe('Lecture 1 (could not delete)')
    expect(notices).toEqual([
      expect.stringMatching(/is now called “Lecture 1 \(could not delete\)\.excalidraw”/),
    ])
  })

  it('a Space whose trash fails is put back under its own name', async () => {
    const lib = await Library.open(root, {
      trash: async () => {
        throw new Error('no trash here')
      },
    })
    writeFileSync(join(root, '.trash'), 'a file where the fallback folder should go')
    const s = await lib.create('space', null, 'Temp')
    let back = 0
    faults.rename = (from, to) => isHidden(from) && basename(to) === 'Temp' && back++ === 0
    const notices: string[] = []
    lib.on('notice', (m) => notices.push(m))
    await lib.remove(s)
    await lib.commitAllRemovals()
    expect(walk().filter(isHidden)).toEqual([])
    expect(existsSync(join(root, 'Temp', 'space.json'))).toBe(true)
    expect(lib.tree().spaces.map((x) => x.id)).toEqual([s])
    expect(notices).toEqual([
      expect.stringMatching(/^Couldn’t delete “Temp”: no trash here\. It’s back/),
    ])
  })

  it('says so when part of a page was deleted and part was not', async () => {
    const lib = await Library.open(root, {
      trash: async (path: string) => {
        if (path.endsWith('.md')) throw new Error('no trash here')
        trashed.push(path)
        rmSync(path, { force: true })
      },
    })
    const space = await lib.create('space', null, 'Work')
    const chapter = await lib.create('chapter', space, 'Notes')
    const page = await lib.create('page', chapter, 'Today')
    await lib.saveNotes(page, 'left over')
    writeFileSync(join(root, '.trash'), 'blocks the fallback folder')
    const notices: string[] = []
    lib.on('notice', (m) => notices.push(m))
    const removed: string[] = []
    lib.on('pageRemoved', (id) => removed.push(id))
    await lib.remove(page)
    await lib.commitAllRemovals()
    expect(lib.tree().spaces[0]?.chapters[0]?.pages).toEqual([])
    expect(removed).toEqual([page])
    expect(walk().filter(isHidden)).toEqual([])
    expect(notices).toEqual([
      expect.stringMatching(/^Deleted “Today”, but couldn’t delete “Today\.md”: no trash here/),
    ])
  })
})

describe('Library: robustness of renames, moves and names', () => {
  it('a page rename whose notes are locked moves the drawing back', async () => {
    const { lib, a } = await seeded()
    await lib.saveNotes(a, 'notes')
    faults.rename = (from) => basename(from) === 'Lecture 1.md'
    await expect(lib.rename(a, 'Raft')).rejects.toThrow()
    faults.rename = null
    const dir = join(root, 'Work', 'Distributed Systems')
    expect(readdirSync(dir)).toEqual(
      expect.arrayContaining(['Lecture 1.excalidraw', 'Lecture 1.md']),
    )
    expect(readdirSync(dir)).not.toContain('Raft.excalidraw')
    expect(lib.tree().spaces[0]?.chapters[0]?.pages[0]).toMatchObject({ id: a, name: 'Lecture 1' })
    await lib.rename(a, 'Raft')
    expect((await lib.readPage(a)).notes).toBe('notes')
  })

  it('reads a move index against the visible siblings (pending deletions are hidden)', async () => {
    const { lib, chapter, a, b } = await seeded()
    const c = await lib.create('page', chapter, 'Lecture 3')
    const d = await lib.create('page', chapter, 'Lecture 4')
    await lib.remove(b) // hidden: the renderer sees [a, c, d]
    // Drag a after c: the renderer computes index 1 in [c, d].
    await lib.move(a, chapter, 1)
    expect(lib.tree().spaces[0]?.chapters[0]?.pages.map((p) => p.id)).toEqual([c, a, d])
    await lib.undoRemove(b)
    expect(lib.tree().spaces[0]?.chapters[0]?.pages.map((p) => p.id)).toEqual([b, c, a, d])
    // And to the end, past a hidden last page.
    await lib.remove(d)
    await lib.move(b, chapter, 2)
    await lib.undoRemove(d)
    expect(lib.tree().spaces[0]?.chapters[0]?.pages.map((p) => p.id)).toEqual([c, a, d, b])
  })

  it('a conflict copy of a page with a long name is still flagged as a conflict', async () => {
    const { lib, chapter } = await seeded()
    const long = await lib.create('page', chapter, 'L'.repeat(115))
    const copy = await lib.saveConflictCopy(long, emptyScene(long), '')
    const page = lib.tree().spaces[0]!.chapters[0]!.pages.find((p) => p.id === copy)
    expect(page?.conflict).toBe(true)
    expect(page?.name).toMatch(/\(conflict \d{4}-\d{2}-\d{2} \d{4}\)$/)
  })

  it('maps watcher paths to pages in any letter case on Windows and macOS', async () => {
    const { lib, a } = await seeded()
    const md = join(root, 'Work', 'Distributed Systems', 'Lecture 1.md')
    expect(lib.pageIdForPath(md)).toBe(a)
    if (process.platform === 'win32' || process.platform === 'darwin') {
      expect(lib.pageIdForPath(md.toUpperCase())).toBe(a)
    }
    await lib.rename(a, 'Raft')
    expect(lib.pageIdForPath(md)).toBeNull()
    expect(lib.pageIdForPath(join(root, 'Work', 'Distributed Systems', 'Raft.excalidraw'))).toBe(a)
  })

  it('resolves a relative library root to an absolute one', async () => {
    const cwd = process.cwd()
    process.chdir(tmpdir())
    try {
      const lib = await Library.open(basename(root), deps)
      expect(isAbsolute(lib.root)).toBe(true)
      expect(realpathSync(lib.root)).toBe(realpathSync(root))
      const space = await lib.create('space', null, 'Work')
      expect(lib.pathOf(space)).toBe(join(lib.root, 'Work'))
    } finally {
      process.chdir(cwd)
    }
  })
})

describe('Library: stale temp files', () => {
  it('removes only old temp files that match Zenbook’s own naming', async () => {
    const { lib } = await seeded()
    const dir = join(root, 'Work', 'Distributed Systems')
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
    const files = {
      stale: join(dir, 'Lecture 1.excalidraw.deadbeef.tmp'),
      staleMeta: join(root, 'Work', 'space.json.0a1b2c3d.tmp'),
      fresh: join(dir, 'Lecture 2.excalidraw.cafebabe.tmp'),
      notOurs: join(dir, 'report.tmp'),
      notOursEither: join(dir, 'video.mp4.deadbeef.tmp'),
      user: join(dir, 'Lecture 1.excalidraw.deadbeef.tmp.bak'),
    }
    for (const path of Object.values(files)) writeFileSync(path, 'x')
    for (const key of ['stale', 'staleMeta', 'notOurs', 'notOursEither', 'user'] as const) {
      utimesSync(files[key], old, old)
    }
    expect(await lib.sweepTempFiles()).toBe(2)
    expect(existsSync(files.stale)).toBe(false)
    expect(existsSync(files.staleMeta)).toBe(false)
    for (const key of ['fresh', 'notOurs', 'notOursEither', 'user'] as const) {
      expect(existsSync(files[key])).toBe(true)
    }
  })
})
