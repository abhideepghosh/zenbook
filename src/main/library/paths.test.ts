import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertInsideRoot,
  conflictStamp,
  isConflictName,
  sanitizeName,
  uniqueName,
  withSuffix,
} from './paths'

describe('sanitizeName', () => {
  it('keeps ordinary names, including em dashes and unicode', () => {
    expect(sanitizeName('Lecture 3 — Raft')).toBe('Lecture 3 — Raft')
    expect(sanitizeName('Café notes ✏️')).toBe('Café notes ✏️')
  })

  it('replaces characters that are illegal on Windows', () => {
    expect(sanitizeName('Q&A: Raft? <draft> "v2" a/b\\c|d*')).toBe(
      'Q&A- Raft- -draft- -v2- a-b-c-d-',
    )
  })

  it('strips control characters, trailing dots/spaces and leading dots', () => {
    expect(sanitizeName('notes\u0007 ...  ')).toBe('notes-')
    expect(sanitizeName('...hidden')).toBe('hidden')
  })

  it('avoids Windows reserved device names', () => {
    expect(sanitizeName('CON')).toBe('CON_')
    expect(sanitizeName('lpt1')).toBe('lpt1_')
    // The suffix goes on the stem: "nul.txt_" would still be the NUL device.
    expect(sanitizeName('nul.txt')).toBe('nul_.txt')
    expect(sanitizeName('NUL .tar.gz')).toBe('NUL_ .tar.gz')
    expect(sanitizeName('CONIN$')).toBe('CONIN$_')
    expect(sanitizeName('conout$.log')).toBe('conout$_.log')
    expect(sanitizeName('COM¹')).toBe('COM¹_')
    expect(sanitizeName('lpt³.md')).toBe('lpt³_.md')
    expect(sanitizeName('Console')).toBe('Console')
    expect(sanitizeName('null.txt')).toBe('null.txt')
  })

  it('falls back for empty names and caps the length', () => {
    expect(sanitizeName('   ')).toBe('Untitled')
    expect(sanitizeName('...', 'Untitled Space')).toBe('Untitled Space')
    expect(sanitizeName('x'.repeat(300))).toHaveLength(120)
  })

  it('never ends a truncated name with a dot or a space', () => {
    const name = sanitizeName(`${'a'.repeat(118)} .b`)
    expect(name).toBe('a'.repeat(118))
    expect(sanitizeName(`${'a'.repeat(119)}.zzz`)).toBe('a'.repeat(119))
  })

  it('never splits a character when truncating', () => {
    const emoji = '😀'.repeat(130) // each is two UTF-16 units
    const name = sanitizeName(emoji)
    expect(name).not.toMatch(/[\uD800-\uDFFF](?![\uDC00-\uDFFF])/u)
    expect(Array.from(name).every((ch) => ch === '😀')).toBe(true)
    expect(Buffer.from(name, 'utf8').toString('utf8')).toBe(name) // round-trips: no lone surrogate
  })

  it('keeps names within 200 UTF-8 bytes', () => {
    const name = sanitizeName('文'.repeat(120)) // 3 bytes each
    expect(Buffer.byteLength(name, 'utf8')).toBeLessThanOrEqual(200)
    expect(name).toBe('文'.repeat(66))
  })
})

describe('withSuffix', () => {
  it('shortens the base, never the suffix', () => {
    const suffix = ` (conflict ${conflictStamp(new Date(2026, 10, 8, 14, 30))})`
    const name = sanitizeName(withSuffix('x'.repeat(119), suffix))
    expect(name.endsWith(suffix)).toBe(true)
    expect(isConflictName(name)).toBe(true)
    expect(Array.from(name).length).toBeLessThanOrEqual(120)
    expect(withSuffix('Raft', ' copy')).toBe('Raft copy')
  })
})

describe('uniqueName', () => {
  it('numbers collisions case-insensitively', () => {
    expect(uniqueName('Untitled', [])).toBe('Untitled')
    expect(uniqueName('Untitled', ['untitled'])).toBe('Untitled 2')
    expect(uniqueName('Untitled', ['Untitled', 'Untitled 2'])).toBe('Untitled 3')
  })
})

describe('assertInsideRoot', () => {
  const root = join('/', 'lib')
  it('accepts paths inside the root', () => {
    expect(assertInsideRoot(root, join(root, 'Work', 'a.excalidraw'))).toBe(
      resolve(root, 'Work', 'a.excalidraw'),
    )
  })
  it('rejects escapes', () => {
    expect(() => assertInsideRoot(root, join(root, '..', 'etc'))).toThrow()
    expect(() => assertInsideRoot(root, join('/', 'elsewhere'))).toThrow()
  })
})

describe('isConflictName', () => {
  it('detects sync-tool and Zenbook conflict copies', () => {
    expect(isConflictName("Raft (Abhi's conflicted copy 2026-11-08)")).toBe(true)
    expect(isConflictName('Raft.sync-conflict-20261108-101010-ABCDEF')).toBe(true)
    expect(isConflictName(`Raft (conflict ${conflictStamp(new Date(2026, 10, 8, 14, 30))})`)).toBe(
      true,
    )
    expect(isConflictName('Conflict resolution lecture')).toBe(false)
  })
  it('formats stamps as YYYY-MM-DD HHmm', () => {
    expect(conflictStamp(new Date(2026, 10, 8, 4, 5))).toBe('2026-11-08 0405')
  })
})
