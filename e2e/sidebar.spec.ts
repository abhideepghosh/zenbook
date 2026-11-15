import { expect, test } from '@playwright/test'
import { cleanup, launch, makeDirs } from './helpers'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

test('the sidebar collapses away completely, leaving only a show button', async () => {
  const dirs = makeDirs()
  try {
    const { app, win } = await launch(dirs)
    const library = win.getByRole('navigation', { name: 'Library' })
    const show = win.getByRole('button', { name: 'Show sidebar' })
    await expect(library).toBeVisible()
    await expect(show).toHaveCount(0)

    await win.getByRole('button', { name: 'Hide sidebar' }).click()
    await expect(library).toHaveCount(0)
    await expect(show).toBeVisible()

    await show.click()
    await expect(library).toBeVisible()
    await expect(show).toHaveCount(0)

    // The shortcut does the same.
    await win.locator('.excalidraw__canvas.interactive').click({ position: { x: 30, y: 400 } })
    await win.keyboard.press(`${mod}+Backslash`)
    await expect(library).toHaveCount(0)
    await expect(show).toBeVisible()
    await app.close()
  } finally {
    cleanup(dirs)
  }
})
