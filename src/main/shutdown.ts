import type { BrowserWindow } from 'electron'
import type { StateStore } from './state'
import { flushRenderer, saveWindowState } from './window'

/** A hung write or trash must never keep an invisible process holding the single-instance lock. */
const SHUTDOWN_TIMEOUT_MS = 10_000

export type ShutdownPhase = 'idle' | 'running' | 'done'

export interface Shutdown {
  /**
   * Saves the window state, flushes the renderer and closes the library.
   * Idempotent: every caller shares the same run. Never rejects.
   */
  run(): Promise<void>
  phase(): ShutdownPhase
}

interface ShutdownDeps {
  store: StateStore
  session: { close(): Promise<void> }
  window: () => BrowserWindow | null
}

/** The one place that turns "the app is going away" into "everything is on disk". */
export function createShutdown({ store, session, window }: ShutdownDeps): Shutdown {
  let promise: Promise<void> | null = null
  let finished = false

  const work = async (): Promise<void> => {
    const win = window()
    // Bounds first: the window may be gone by the time the flush returns.
    if (win) saveWindowState(win, store)
    if (win) await flushRenderer(win)
    await session.close()
  }

  return {
    run() {
      promise ??= (async () => {
        let timer: NodeJS.Timeout | undefined
        const timeout = new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            console.error(`[shutdown] gave up waiting after ${SHUTDOWN_TIMEOUT_MS} ms`)
            resolve()
          }, SHUTDOWN_TIMEOUT_MS)
        })
        try {
          await Promise.race([work(), timeout])
        } catch (err) {
          console.error('[shutdown] failed:', err)
        } finally {
          clearTimeout(timer)
          store.saveNow()
          finished = true
        }
      })()
      return promise
    },
    phase() {
      if (finished) return 'done'
      return promise ? 'running' : 'idle'
    },
  }
}
