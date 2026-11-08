import { writeFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import {
  cleanup,
  drawRectangle,
  launch,
  makeDirs,
  openPageNamed,
  pagePath,
  readNotes,
  readScene,
} from './helpers'

test('a drawing survives switching pages and relaunching the app', async () => {
  const dirs = makeDirs()
  try {
    let { app, win } = await launch(dirs)
    await openPageNamed(win, 'Blank page')
    await drawRectangle(win)

    // Autosave writes the rectangle into the page file.
    await expect
      .poll(
        () => readScene(dirs, 'Blank page').elements.filter((e) => e.type === 'rectangle').length,
      )
      .toBe(1)

    await openPageNamed(win, 'Welcome')
    await openPageNamed(win, 'Blank page')
    await app.close()

    ;({ app, win } = await launch(dirs))
    // Reopens on the last page, unchanged.
    await expect(win.locator('[class*="current"]').first()).toHaveText('Blank page')
    expect(
      readScene(dirs, 'Blank page').elements.filter((e) => e.type === 'rectangle'),
    ).toHaveLength(1)
    await expect(win.getByRole('alert')).toHaveCount(0)
    await win.screenshot({ path: 'test-results/canvas.png' })
    await app.close()
  } finally {
    cleanup(dirs)
  }
})

test('pasted images are stored once in .assets, never inside the page', async () => {
  const dirs = makeDirs()
  try {
    const { app, win } = await launch(dirs)
    await openPageNamed(win, 'Blank page')
    await win.locator('.excalidraw__canvas.interactive').click({ position: { x: 400, y: 300 } })

    // Paste a tiny PNG the way the clipboard would deliver it.
    await win.evaluate(async () => {
      const png = Uint8Array.from(
        atob(
          'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8DwnwEJMDGgAcICAAa3AwCvz6FkAAAAAElFTkSuQmCC',
        ),
        (c) => c.charCodeAt(0),
      )
      const data = new DataTransfer()
      data.items.add(new File([png], 'dot.png', { type: 'image/png' }))
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }))
    })

    await expect
      .poll(
        () => readScene(dirs, 'Blank page').elements.some((e) => e.type === 'image' && e.fileId),
        { timeout: 15_000 },
      )
      .toBe(true)
    const scene = readScene(dirs, 'Blank page')
    expect(scene.files).toEqual({})
    const { readdirSync } = await import('node:fs')
    const { join } = await import('node:path')
    const fileId = scene.elements.find((e) => e.type === 'image')!.fileId!
    expect(readdirSync(join(dirs.library, 'Personal', '.assets'))).toContain(`${fileId}.png`)
    await app.close()
  } finally {
    cleanup(dirs)
  }
})

test('notes are saved as Markdown and survive a relaunch; empty notes create no file', async () => {
  const dirs = makeDirs()
  try {
    let { app, win } = await launch(dirs)
    await openPageNamed(win, 'Blank page')
    expect(readNotes(dirs, 'Blank page')).toBeNull()

    const editor = win.locator('.cm-content')
    await editor.click()
    await win.keyboard.type('# Raft\n\n- [ ] leader election')
    await expect.poll(() => readNotes(dirs, 'Blank page')).toBe('# Raft\n\n- [ ] leader election')

    await openPageNamed(win, 'Welcome')
    await expect(editor).toContainText('Every page is a canvas')
    await app.close()

    ;({ app, win } = await launch(dirs))
    await openPageNamed(win, 'Blank page')
    await expect(win.locator('.cm-content')).toContainText('leader election')
    await expect(win.locator('.cm-task')).toHaveCount(1)
    await win.screenshot({ path: 'test-results/notes.png' })
    await app.close()
  } finally {
    cleanup(dirs)
  }
})

test('a page edited by another app reloads in place', async () => {
  const dirs = makeDirs()
  try {
    const { app, win } = await launch(dirs)
    await openPageNamed(win, 'Blank page')
    await win.waitForTimeout(3500) // the watcher starts a few seconds after launch
    writeFileSync(pagePath(dirs, 'Blank page', '.md'), 'Written on my phone')
    await expect(win.locator('.cm-content')).toContainText('Written on my phone', {
      timeout: 10_000,
    })
    await expect(win.getByRole('alert')).toHaveCount(0) // no local edits, so no conflict
    await app.close()
  } finally {
    cleanup(dirs)
  }
})
