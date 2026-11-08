import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import { cleanup, launch, makeDirs } from './helpers'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const current = (win: import('@playwright/test').Page) => win.locator('[class*="current"]').first()

test('Ctrl/Cmd+K jumps to a page by title and by text inside its drawing', async () => {
  const dirs = makeDirs()
  try {
    const { app, win } = await launch(dirs)
    await win.locator('.excalidraw__canvas.interactive').click({ position: { x: 30, y: 400 } })

    await win.keyboard.press(`${mod}+K`)
    const palette = win.getByRole('dialog', { name: 'Command palette' })
    await expect(palette).toBeVisible()
    await win.keyboard.type('blank')
    await expect(palette.getByRole('option').first()).toContainText('Blank page')
    await win.keyboard.press('Enter')
    await expect(palette).toBeHidden()
    await expect(current(win)).toHaveText('Blank page')

    // Words that only exist inside the Welcome drawing (indexed in the background).
    await expect
      .poll(
        async () => (await win.evaluate(() => window.zenbook.search.query('quiet place'))).length,
        {
          timeout: 15_000,
        },
      )
      .toBeGreaterThan(0)
    await win.keyboard.press(`${mod}+K`)
    await win.keyboard.type('quiet place')
    await expect(palette.getByRole('option').first()).toContainText('Welcome')
    await expect(palette.getByRole('option').first()).toContainText('in drawing')
    await win.keyboard.press('Escape')
    await expect(palette).toBeHidden()

    // Actions too: "> focus" runs focus mode, Esc leaves it.
    await win.keyboard.press(`${mod}+K`)
    await win.keyboard.type('> focus')
    await win.keyboard.press('Enter')
    await expect(win.getByRole('navigation', { name: 'Library' })).toBeHidden()
    await win.locator('.excalidraw__canvas.interactive').click({ position: { x: 30, y: 400 } })
    await win.keyboard.press('Escape')
    await expect(win.getByRole('navigation', { name: 'Library' })).toBeVisible()
    await app.close()
  } finally {
    cleanup(dirs)
  }
})

test('keyboard: new page, rename inline, switch pages', async () => {
  const dirs = makeDirs()
  try {
    const { app, win } = await launch(dirs)
    await win.locator('.excalidraw__canvas.interactive').click({ position: { x: 30, y: 400 } })
    await win.keyboard.press(`${mod}+N`)
    const input = win.getByRole('textbox', { name: 'Name' })
    await expect(input).toBeFocused()
    await win.keyboard.type('Lecture 3 — Raft')
    await win.keyboard.press('Enter')
    await expect(win.getByRole('treeitem', { name: 'Lecture 3 — Raft' })).toBeVisible()
    await expect(current(win)).toHaveText('Lecture 3 — Raft')

    await win.locator('.excalidraw__canvas.interactive').click({ position: { x: 30, y: 400 } })
    await win.keyboard.press(`${mod}+Alt+ArrowUp`)
    await expect(current(win)).toHaveText('Welcome')
    await app.close()
  } finally {
    cleanup(dirs)
  }
})

test('performance: a 2,000-element page opens within budget and search stays fast', async () => {
  test.setTimeout(180_000) // generating and indexing 1,000 pages takes a while
  const library = join(mkdtempSync(join(tmpdir(), 'zenbook-fixture-')), 'Zenbook')
  execFileSync(process.execPath, [
    'scripts/make-fixture.mjs',
    '--pages',
    '1000',
    '--elements',
    '2000',
    '--out',
    library,
  ])
  const userData = mkdtempSync(join(tmpdir(), 'zenbook-e2e-data-'))
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      ZENBOOK_USER_DATA: userData,
      ZENBOOK_LIBRARY: library,
      ZENBOOK_PERF: '1',
    },
  })
  try {
    const win = await app.firstWindow()
    const timings: number[] = []
    win.on('console', (m) => {
      const match = /\[perf\] page open: (\d+) ms \((\d+) elements\)/.exec(m.text())
      if (match && Number(match[2]) >= 2000) timings.push(Number(match[1]))
    })
    await expect(win.locator('.excalidraw__canvas.interactive')).toBeVisible({ timeout: 20_000 })
    await win.getByRole('treeitem', { name: 'Page 1 election', exact: true }).click()
    // Switch to the big page twice (cold, then warm) and keep the better time.
    for (const name of ['Big page', 'Page 1 election', 'Big page']) {
      await win.getByRole('treeitem', { name, exact: true }).click()
      await expect(current(win)).toHaveText(name)
    }
    await expect.poll(() => timings.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2)
    const best = Math.min(...timings)
    console.log(`Big page (2,000 elements) open: ${timings.join(' ms, ')} ms`)
    expect(best).toBeLessThan(process.env.CI ? 1500 : 300)

    // Search over 1,000 pages answers well under 100 ms (round trip through IPC).
    await expect
      .poll(async () => (await win.evaluate(() => window.zenbook.search.query('quorum'))).length, {
        timeout: 20_000,
      })
      .toBeGreaterThan(0)
    const elapsed = await win.evaluate(async () => {
      const start = performance.now()
      await window.zenbook.search.query('replication snapshot')
      return performance.now() - start
    })
    console.log(`Search over 1,000 pages: ${elapsed.toFixed(1)} ms`)
    expect(elapsed).toBeLessThan(100)
  } finally {
    await app.close()
    cleanup({ userData, library })
  }
})
