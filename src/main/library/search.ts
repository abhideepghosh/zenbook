import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import MiniSearch from 'minisearch'
import type { SearchHit } from '../../shared/api'
import { atomicWrite, fingerprint, readText } from './fsx'
import type { Library } from './library'
import type { Model } from './model'

interface Doc {
  id: string
  title: string
  chapter: string
  space: string
  spaceId: string
  notes: string
  drawing: string
}

interface Cached {
  notes: string
  drawing: string
  /** mtimes of [scene, notes] when the text was extracted. */
  stamp: [number, number]
}

const CACHE_VERSION = 1
const MAX_TEXT = 200_000 // per field; enough for any real page, bounded for the cache

/** Text a person would search for in a drawing: text elements and frame names. */
export function extractDrawingText(scene: string | null): string {
  if (!scene) return ''
  try {
    const data = JSON.parse(scene) as {
      elements?: Array<{
        type?: string
        isDeleted?: boolean
        text?: unknown
        originalText?: unknown
        name?: unknown
      }>
    }
    const parts: string[] = []
    for (const el of data.elements ?? []) {
      if (el.isDeleted) continue
      if (el.type === 'text') {
        const t = typeof el.originalText === 'string' ? el.originalText : el.text
        if (typeof t === 'string') parts.push(t)
      } else if ((el.type === 'frame' || el.type === 'magicframe') && typeof el.name === 'string') {
        parts.push(el.name)
      }
    }
    return parts.join('\n').slice(0, MAX_TEXT)
  } catch {
    return ''
  }
}

const yieldToEventLoop = () => new Promise((r) => setImmediate(r))

/**
 * Full-text search over page titles, notes and text inside drawings.
 * Lives in the main process next to the files. The extracted text is cached in
 * userData (per device) so startup never has to re-read every page.
 */
export class SearchIndex {
  private mini = SearchIndex.create()
  private readonly cache = new Map<string, Cached>()
  private readonly docs = new Map<string, Doc>()
  private saveTimer: NodeJS.Timeout | undefined

  constructor(
    private readonly lib: Library,
    private readonly cacheFile: string,
  ) {
    this.loadCache()
    this.syncTree(lib.model)
  }

  private static create() {
    return new MiniSearch<Doc>({
      fields: ['title', 'chapter', 'notes', 'drawing'],
      storeFields: ['title', 'chapter', 'space', 'spaceId'],
      searchOptions: {
        prefix: true,
        fuzzy: 0.2,
        boost: { title: 3, chapter: 1.5 },
        combineWith: 'AND',
      },
    })
  }

  private loadCache(): void {
    try {
      const raw = JSON.parse(readFileSync(this.cacheFile, 'utf8')) as {
        version?: number
        pages?: Record<string, Cached>
      }
      if (raw.version !== CACHE_VERSION || !raw.pages) return
      for (const [id, entry] of Object.entries(raw.pages)) this.cache.set(id, entry)
    } catch {
      // No cache yet, or it's unreadable: it is rebuilt from the files.
    }
  }

  private scheduleSave(): void {
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => void this.save(), 10_000)
  }

  async save(): Promise<void> {
    clearTimeout(this.saveTimer)
    try {
      mkdirSync(dirname(this.cacheFile), { recursive: true })
      const pages = Object.fromEntries(this.cache)
      await atomicWrite(this.cacheFile, JSON.stringify({ version: CACHE_VERSION, pages }))
    } catch {
      // A cache; losing it only costs a rebuild.
    }
  }

  private put(doc: Doc): void {
    if (this.mini.has(doc.id)) this.mini.replace(doc)
    else this.mini.add(doc)
    this.docs.set(doc.id, doc)
  }

  /** Keeps titles in step with the tree and drops pages that no longer exist. */
  syncTree(model: Model): void {
    const seen = new Set<string>()
    for (const space of model.spaces) {
      for (const chapter of space.chapters) {
        for (const page of chapter.pages) {
          seen.add(page.id)
          const cached = this.cache.get(page.id)
          const prev = this.docs.get(page.id)
          const doc: Doc = {
            id: page.id,
            title: page.name,
            chapter: chapter.name,
            space: space.name,
            spaceId: space.id,
            notes: cached?.notes ?? '',
            drawing: cached?.drawing ?? '',
          }
          if (
            !prev ||
            prev.title !== doc.title ||
            prev.chapter !== doc.chapter ||
            prev.space !== doc.space ||
            prev.notes !== doc.notes ||
            prev.drawing !== doc.drawing
          ) {
            this.put(doc)
          }
        }
      }
    }
    for (const id of [...this.docs.keys()]) {
      if (!seen.has(id)) {
        this.mini.discard(id)
        this.docs.delete(id)
        this.cache.delete(id)
      }
    }
  }

  private async stampOf(id: string): Promise<[number, number] | null> {
    const found = this.lib.model.spaces
      .flatMap((s) => s.chapters.flatMap((c) => c.pages.map((p) => ({ s, c, p }))))
      .find((x) => x.p.id === id)
    if (!found) return null
    const [scene, notes] = await Promise.all([
      fingerprint(this.lib.scenePath(found.s, found.c, found.p)),
      fingerprint(this.lib.notesPath(found.s, found.c, found.p)),
    ])
    return [scene?.mtimeMs ?? 0, notes?.mtimeMs ?? 0]
  }

  /** Called after a save: the renderer already sent the drawing text, so no re-parse. */
  async update(id: string, change: { drawing?: string; notes?: string }): Promise<void> {
    const prev = this.cache.get(id) ?? { notes: '', drawing: '', stamp: [0, 0] as [number, number] }
    const next: Cached = {
      notes: (change.notes ?? prev.notes).slice(0, MAX_TEXT),
      drawing: (change.drawing ?? prev.drawing).slice(0, MAX_TEXT),
      stamp: (await this.stampOf(id)) ?? prev.stamp,
    }
    this.cache.set(id, next)
    const doc = this.docs.get(id)
    if (doc) this.put({ ...doc, notes: next.notes, drawing: next.drawing })
    this.scheduleSave()
  }

  /**
   * Re-extracts text for pages that changed since the cache was written (or were
   * never indexed). Runs in small batches so the main process stays responsive.
   */
  async reconcile(): Promise<void> {
    const pages = this.lib.model.spaces.flatMap((s) =>
      s.chapters.flatMap((c) => c.pages.map((p) => ({ s, c, p }))),
    )
    let changed = false
    for (let i = 0; i < pages.length; i++) {
      const { s, c, p } = pages[i]!
      const scenePath = this.lib.scenePath(s, c, p)
      const notesPath = this.lib.notesPath(s, c, p)
      const [sf, nf] = await Promise.all([fingerprint(scenePath), fingerprint(notesPath)])
      const stamp: [number, number] = [sf?.mtimeMs ?? 0, nf?.mtimeMs ?? 0]
      const cached = this.cache.get(p.id)
      if (cached && cached.stamp[0] === stamp[0] && cached.stamp[1] === stamp[1]) continue
      const [scene, notes] = await Promise.all([readText(scenePath), readText(notesPath)])
      this.cache.set(p.id, {
        drawing: extractDrawingText(scene),
        notes: (notes ?? '').slice(0, MAX_TEXT),
        stamp,
      })
      changed = true
      if (i % 20 === 19) await yieldToEventLoop()
    }
    if (changed) {
      this.syncTree(this.lib.model)
      this.scheduleSave()
    }
  }

  /** Re-reads one page's files (after another app or a sync tool changed them). */
  async refreshPage(id: string): Promise<void> {
    for (const s of this.lib.model.spaces) {
      for (const c of s.chapters) {
        const p = c.pages.find((x) => x.id === id)
        if (!p) continue
        const [scene, notes] = await Promise.all([
          readText(this.lib.scenePath(s, c, p)),
          readText(this.lib.notesPath(s, c, p)),
        ])
        await this.update(id, { drawing: extractDrawingText(scene), notes: notes ?? '' })
        return
      }
    }
  }

  query(q: string, limit = 30): SearchHit[] {
    const text = q.trim()
    if (!text) return []
    return this.mini
      .search(text)
      .slice(0, limit)
      .map((r) => {
        const fields = new Set<string>(Object.values(r.match).flat())
        return {
          pageId: String(r.id),
          title: String(r.title),
          chapter: String(r.chapter),
          space: String(r.space),
          spaceId: String(r.spaceId),
          matchedIn: (['title', 'notes', 'drawing'] as const).filter((f) => fields.has(f)),
        }
      })
  }
}
