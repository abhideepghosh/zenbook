import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ net: {}, protocol: {} }))

const { resolveInside } = await import('./protocol')

describe('resolveInside', () => {
  const root = join('/', 'app', 'out', 'renderer')

  it('maps normal paths inside the root', () => {
    expect(resolveInside(root, '/index.html')).toBe(join(root, 'index.html'))
    expect(resolveInside(root, '/assets/index-abc.js')).toBe(join(root, 'assets', 'index-abc.js'))
    expect(resolveInside(root, '/fonts/Excalifont%20Regular.woff2')).toBe(
      join(root, 'fonts', 'Excalifont Regular.woff2'),
    )
  })

  it('rejects traversal out of the root', () => {
    expect(resolveInside(root, '/../main/index.js')).toBeNull()
    expect(resolveInside(root, '/assets/../../secret')).toBeNull()
    expect(resolveInside(root, '/%2e%2e/%2e%2e/etc/passwd')).toBeNull()
    expect(resolveInside(root, '/..%2fmain%2findex.js')).toBeNull()
    expect(resolveInside(root, '/..%5cmain%5cindex.js')).toBeNull()
  })

  it('rejects the root itself, malformed escapes and NUL bytes', () => {
    expect(resolveInside(root, '/')).toBeNull()
    expect(resolveInside(root, '/%E0%A4%A')).toBeNull()
    expect(resolveInside(root, '/index.html%00.png')).toBeNull()
  })

  it('allows names that merely start with two dots', () => {
    expect(resolveInside(root, '/..notes.txt')).toBe(join(root, '..notes.txt'))
  })
})
