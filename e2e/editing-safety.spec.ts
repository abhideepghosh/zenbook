import { expect, test } from '@playwright/test'
import { cleanup, launch, makeDirs, readScene } from './helpers'

const live = (dirs: Parameters<typeof readScene>[0], name: string) =>
  readScene(dirs, name).elements.filter((el) => !el.isDeleted).length

test('starting the app never empties the page it opens on', async () => {
  const dirs = makeDirs()
  try {
    let { app, win } = await launch(dirs)
    await expect(win.locator('[class*="current"]').first()).toHaveText('Welcome')
    await app.close()
    const before = live(dirs, 'Welcome')
    expect(before).toBeGreaterThan(0)

    // A second start (Excalidraw's own start-up resets its scene) must not save that reset.
    ;({ app, win } = await launch(dirs))
    await expect(win.locator('[class*="current"]').first()).toHaveText('Welcome')
    await win.waitForTimeout(2000) // longer than the save debounce
    await app.close()
    expect(live(dirs, 'Welcome')).toBe(before)
  } finally {
    cleanup(dirs)
  }
})

test('the sidebar toggle buttons hand focus to each other', async () => {
  const dirs = makeDirs()
  try {
    const { app, win } = await launch(dirs)
    await win.getByRole('button', { name: 'Hide sidebar' }).click()
    await expect(win.getByRole('button', { name: 'Show sidebar' })).toBeFocused()
    await win.getByRole('button', { name: 'Show sidebar' }).click()
    await expect(win.getByRole('button', { name: 'Hide sidebar' })).toBeFocused()
    await app.close()
  } finally {
    cleanup(dirs)
  }
})

test('sidebar rows: arrows move focus, F2 renames the focused row', async () => {
  const dirs = makeDirs()
  try {
    const { app, win } = await launch(dirs)
    const chapter = win.getByRole('treeitem', { name: /Start here/ })
    await chapter.focus()
    await win.keyboard.press('ArrowDown')
    await expect(win.getByRole('treeitem', { name: 'Welcome', exact: true })).toBeFocused()
    await win.keyboard.press('ArrowDown')
    const blank = win.getByRole('treeitem', { name: 'Blank page', exact: true })
    await expect(blank).toBeFocused()

    // Welcome is open, but F2 on the focused row renames that row.
    await win.keyboard.press('F2')
    await expect(win.getByRole('textbox', { name: 'Name' })).toHaveValue('Blank page')
    await win.keyboard.press('Escape')
    await app.close()
  } finally {
    cleanup(dirs)
  }
})
