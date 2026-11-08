import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ZenbookApi } from '../src/shared/api'

// Page-side globals, typed for this Node-side test file.
type PageGlobals = { innerWidth: number; zenbook: ZenbookApi; require?: unknown; process?: unknown }

test('launches the shell with the three-column layout, securely', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'zenbook-e2e-'))
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, ZENBOOK_USER_DATA: userData },
  })

  try {
    const win = await app.firstWindow()
    await expect(win).toHaveTitle('Zenbook')
    await expect(win.getByRole('navigation', { name: 'Library' })).toBeVisible()
    await expect(win.getByRole('main')).toBeVisible()

    // The notes column docks only on wide windows (CI screens can be small).
    const notes = win.getByRole('complementary', { name: 'Notes' })
    const width = await win.evaluate(() => (globalThis as unknown as PageGlobals).innerWidth)
    if (width >= 1200) await expect(notes).toBeVisible()
    else await expect(notes).toBeHidden()

    // Served from the app:// protocol, sandboxed, with only the typed bridge exposed.
    expect(win.url()).toBe('app://zenbook/index.html')
    expect(await win.evaluate(() => typeof (globalThis as unknown as PageGlobals).require)).toBe(
      'undefined',
    )
    expect(await win.evaluate(() => typeof (globalThis as unknown as PageGlobals).process)).toBe(
      'undefined',
    )
    const info = await win.evaluate(() => (globalThis as unknown as PageGlobals).zenbook.app.info())
    expect(info.name).toBe('Zenbook')

    await win.screenshot({ path: 'test-results/shell-light.png' })
    await win.emulateMedia({ colorScheme: 'dark' })
    await win.screenshot({ path: 'test-results/shell-dark.png' })
  } finally {
    await app.close()
    rmSync(userData, { recursive: true, force: true })
  }
})
