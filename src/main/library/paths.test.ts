import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertInsideRoot, conflictStamp, isConflictName, sanitizeName, uniqueName } from './paths'

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
    expect(sanitizeName('nul.txt')).toBe('nul.txt_')
    expect(sanitizeName('Console')).toBe('Console')
  })

  it('falls back for empty names and caps the length', () => {
    expect(sanitizeName('   ')).toBe('Untitled')
    expect(sanitizeName('...', 'Untitled Space')).toBe('Untitled Space')
    expect(sanitizeName('x'.repeat(300))).toHaveLength(120)
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
