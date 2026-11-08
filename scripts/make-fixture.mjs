// Generates a large library for performance testing.
//   npm run fixture -- --pages 1000 --elements 2000 --out <folder>
// Creates one Space with 20 chapters, `pages` small pages (searchable text and
// notes) and one "Big page" with `elements` shapes.
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => {
    if (arg.startsWith('--')) pairs.push([arg.slice(2), all[i + 1]])
    return pairs
  }, []),
)
const pages = Number(args.pages ?? 1000)
const elements = Number(args.elements ?? 2000)
const out = resolve(args.out ?? 'fixture-library')
const words =
  'leader election log replication term vote quorum paxos raft commit snapshot shard index cache queue stream'.split(
    ' ',
  )
const word = (i) => words[i % words.length]

let seed = 1
function el(type, x, y, extra = {}) {
  seed++
  return {
    id: `el-${seed}`,
    type,
    x,
    y,
    width: 120,
    height: 60,
    strokeColor: '#1e1e1e',
    roughness: 1,
    seed,
    version: 1,
    versionNonce: seed,
    ...extra,
  }
}

function scene(id, count, label) {
  const list = []
  for (let i = 0; i < count; i++) {
    const x = (i % 50) * 160
    const y = Math.floor(i / 50) * 100
    list.push(
      i % 5 === 0
        ? el('text', x, y, {
            text: `${label} ${word(i)} ${i}`,
            originalText: `${label} ${word(i)} ${i}`,
            fontSize: 16,
            fontFamily: 5,
          })
        : el(i % 2 ? 'rectangle' : 'ellipse', x, y),
    )
  }
  return JSON.stringify({
    type: 'excalidraw',
    version: 2,
    source: 'fixture',
    elements: list,
    appState: { viewBackgroundColor: '#ffffff' },
    files: {},
    zenbook: { id, paper: 'plain' },
  })
}

const spaceId = randomUUID()
const spaceDir = join(out, 'Fixture')
mkdirSync(spaceDir, { recursive: true })
const chapterIds = []
for (let c = 0; c < 20; c++) {
  const chapterId = randomUUID()
  chapterIds.push(chapterId)
  const dir = join(spaceDir, `Chapter ${String(c + 1).padStart(2, '0')}`)
  mkdirSync(dir, { recursive: true })
  const entries = []
  const perChapter = Math.ceil(pages / 20)
  for (let p = 0; p < perChapter && c * perChapter + p < pages; p++) {
    const n = c * perChapter + p
    const id = randomUUID()
    const name = c === 0 && p === 0 ? 'Big page' : `Page ${n} ${word(n)}`
    writeFileSync(
      join(dir, `${name}.excalidraw`),
      scene(id, c === 0 && p === 0 ? elements : 12, word(n + 3)),
    )
    writeFileSync(
      join(dir, `${name}.md`),
      `Notes for page ${n} about ${word(n + 7)} and ${word(n + 11)}.`,
    )
    entries.push({ id, file: name })
  }
  writeFileSync(
    join(dir, 'chapter.json'),
    JSON.stringify({ id: chapterId, pages: entries }, null, 2),
  )
}
writeFileSync(
  join(spaceDir, 'space.json'),
  JSON.stringify({ id: spaceId, color: 'slate', chapters: chapterIds, pinned: [] }, null, 2),
)
writeFileSync(join(out, 'zenbook.json'), JSON.stringify({ format: 1, spaces: [spaceId] }, null, 2))
console.log(`Fixture: ${pages} pages, a ${elements}-element "Big page" → ${out}`)
