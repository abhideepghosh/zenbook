import { describe, expect, it } from 'vitest'
import { fuzzyFilter, fuzzyScore } from './fuzzy'

describe('fuzzyScore', () => {
  it('matches subsequences and rejects the rest', () => {
    expect(fuzzyScore('tgn', 'Toggle notes')).not.toBeNull()
    expect(fuzzyScore('xyz', 'Toggle notes')).toBeNull()
    expect(fuzzyScore('', 'anything')).toBe(0)
  })

  it('prefers word starts and consecutive letters', () => {
    const items = ['Paper: Lined', 'Duplicate page', 'New page', 'Toggle sidebar']
    expect(fuzzyFilter('new', items, (s) => s)[0]).toBe('New page')
    expect(fuzzyFilter('dup', items, (s) => s)[0]).toBe('Duplicate page')
    expect(fuzzyFilter('lined', items, (s) => s)[0]).toBe('Paper: Lined')
  })
})
