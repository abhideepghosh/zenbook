import type { BrowserWindow } from 'electron'
import type { Updates } from './ipc'
import type { StateStore } from './state'

/** Placeholder until Phase 6 wires electron-updater. */
export function createUpdates(
  _store: StateStore,
  _window: () => BrowserWindow | null,
): Updates & { start(): void } {
  return {
    start: () => undefined,
    check: async () => undefined,
    install: () => undefined,
  }
}
