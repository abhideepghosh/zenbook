import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test'

export interface Dirs {
  userData: string
  library: string
}

export function makeDirs(): Dirs {
  return {
    userData: mkdtempSync(join(tmpdir(), 'zenbook-e2e-data-')),
    library: join(mkdtempSync(join(tmpdir(), 'zenbook-e2e-lib-')), 'Zenbook'),
  }
}

export function cleanup(dirs: Dirs): void {
  // Chromium can hold files for a moment after quitting (Windows): retry, and never fail a test over it.
  for (const dir of [dirs.userData, join(dirs.library, '..')]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    } catch {
      // left in the OS temp folder
    }
  }
}

export async function launch(dirs: Dirs): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, ZENBOOK_USER_DATA: dirs.userData, ZENBOOK_LIBRARY: dirs.library },
  })
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1400, height: 900 }).catch(() => undefined)
  await expect(win.locator('.excalidraw__canvas.interactive')).toBeVisible({ timeout: 20_000 })
  return { app, win }
}

/** The seeded library: Personal / Start here / {Welcome, Blank page}. */
export const pagePath = (dirs: Dirs, name: string, ext = '.excalidraw') =>
  join(dirs.library, 'Personal', 'Start here', `${name}${ext}`)

export function readScene(
  dirs: Dirs,
  name: string,
): { elements: Array<{ type: string; isDeleted?: boolean; fileId?: string }>; files: object } {
  return JSON.parse(readFileSync(pagePath(dirs, name), 'utf8'))
}

export function readNotes(dirs: Dirs, name: string): string | null {
  const path = pagePath(dirs, name, '.md')
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

export async function openPageNamed(win: Page, name: string): Promise<void> {
  await win.getByRole('treeitem', { name, exact: true }).first().click()
  await expect(win.locator('[class*="current"]').first()).toHaveText(name)
}

/** Draws a rectangle by dragging on the canvas with the rectangle tool. */
export async function drawRectangle(win: Page, x = 500, y = 350): Promise<void> {
  const canvas = win.locator('.excalidraw__canvas.interactive')
  await canvas.click({ position: { x: 20, y: 300 } }) // focus the canvas
  await win.keyboard.press('r')
  await win.mouse.move(x, y)
  await win.mouse.down()
  await win.mouse.move(x + 120, y + 80, { steps: 8 })
  await win.mouse.up()
  await win.keyboard.press('Escape')
}
