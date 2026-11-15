import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { atomicWrite, readJsonFile, TEMP_FILE, WriteQueue } from './fsx'

// Makes the next file handle's writeFile fail, as a full disk would.
const faults = vi.hoisted(() => ({ writeFile: false }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      if (faults.writeFile) {
        handle.writeFile = async () => {
          throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
        }
      }
      return handle
    },
  }
})

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zenbook-fsx-'))
})
afterEach(() => {
  faults.writeFile = false
  rmSync(dir, { recursive: true, force: true })
})

describe('atomicWrite', () => {
  it('replaces the file and leaves no temp files behind', async () => {
    const file = join(dir, 'page.excalidraw')
    writeFileSync(file, 'old')
    await atomicWrite(file, 'new')
    expect(readFileSync(file, 'utf8')).toBe('new')
    expect(readdirSync(dir)).toEqual(['page.excalidraw'])
  })

  it('removes its temp file when the write itself fails', async () => {
    const file = join(dir, 'page.excalidraw')
    writeFileSync(file, 'old')
    faults.writeFile = true
    await expect(atomicWrite(file, 'new')).rejects.toThrow(/ENOSPC/)
    expect(readdirSync(dir)).toEqual(['page.excalidraw'])
    expect(readFileSync(file, 'utf8')).toBe('old')
  })

  it('names temp files so the sweep can recognise them', async () => {
    expect(TEMP_FILE.test('Lecture 1.excalidraw.deadbeef.tmp')).toBe(true)
    expect(TEMP_FILE.test('space.json.0123abcd.tmp')).toBe(true)
    expect(TEMP_FILE.test('report.tmp')).toBe(false)
    expect(TEMP_FILE.test('a.excalidraw.deadbeef.tmp.bak')).toBe(false)
    expect(TEMP_FILE.test('a.excalidraw.DEADBEE.tmp')).toBe(false)
  })

  it('a crash between writing and renaming leaves the original intact', async () => {
    // Simulate the state a crash would leave: a finished temp file that was never renamed.
    const file = join(dir, 'page.excalidraw')
    writeFileSync(file, 'complete original')
    writeFileSync(`${file}.deadbeef.tmp`, 'half-writ')
    expect(readFileSync(file, 'utf8')).toBe('complete original')
    // The next save still works and the temp file is ignored by the library (see watcher tests).
    await atomicWrite(file, 'next')
    expect(readFileSync(file, 'utf8')).toBe('next')
  })
})

describe('WriteQueue', () => {
  it('coalesces bursts: only the newest pending content is written', async () => {
    const queue = new WriteQueue()
    const file = join(dir, 'a.txt')
    const writes = ['1', '2', '3', '4', '5'].map((v) => queue.write(file, v))
    await Promise.all(writes)
    expect(readFileSync(file, 'utf8')).toBe('5')
  })

  it('recognises its own writes but not external ones', async () => {
    const queue = new WriteQueue()
    const file = join(dir, 'a.txt')
    await queue.write(file, 'mine')
    expect(await queue.isOwnWrite(file)).toBe(true)
    await new Promise((r) => setTimeout(r, 20))
    writeFileSync(file, 'theirs, longer')
    expect(await queue.isOwnWrite(file)).toBe(false)
  })

  it('drain waits for everything', async () => {
    const queue = new WriteQueue()
    for (let i = 0; i < 20; i++) void queue.write(join(dir, `f${i % 3}.txt`), String(i))
    await queue.drain()
    expect(readdirSync(dir).sort()).toEqual(['f0.txt', 'f1.txt', 'f2.txt'])
  })
})

describe('readJsonFile', () => {
  it('tells missing files from unreadable ones', async () => {
    expect(await readJsonFile(join(dir, 'nope.json'))).toEqual({ status: 'missing' })
    writeFileSync(join(dir, 'bad.json'), '{ nope')
    expect((await readJsonFile(join(dir, 'bad.json'))).status).toBe('unreadable')
    writeFileSync(join(dir, 'list.json'), '[1, 2]')
    expect((await readJsonFile(join(dir, 'list.json'))).status).toBe('unreadable')
    writeFileSync(join(dir, 'ok.json'), '{"id": "x"}')
    expect(await readJsonFile(join(dir, 'ok.json'))).toEqual({ status: 'ok', value: { id: 'x' } })
    // A folder where a file should be can't be read either; it isn't "missing".
    expect((await readJsonFile(dir)).status).toBe('unreadable')
  })
})
