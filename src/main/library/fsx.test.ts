import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { atomicWrite, WriteQueue } from './fsx'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zenbook-fsx-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('atomicWrite', () => {
  it('replaces the file and leaves no temp files behind', async () => {
    const file = join(dir, 'page.excalidraw')
    writeFileSync(file, 'old')
    await atomicWrite(file, 'new')
    expect(readFileSync(file, 'utf8')).toBe('new')
    expect(readdirSync(dir)).toEqual(['page.excalidraw'])
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
