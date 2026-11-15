import { app, type BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateStatus } from '../shared/api'
import { Channels } from '../shared/channels'
import type { Updates } from './ipc'
import type { Shutdown } from './shutdown'
import type { StateStore } from './state'

const RELEASES = 'https://github.com/abhideepghosh/zenbook/releases/latest'
const FIRST_CHECK_MS = 10_000
const EVERY_MS = 6 * 60 * 60 * 1000
const INSTALL_FALLBACK_MS = 3000

/**
 * Whether this build can replace itself:
 * - Windows (NSIS) and Linux AppImage: yes, even unsigned.
 * - macOS: only when signed (Squirrel.Mac refuses unsigned updates). CI sets
 *   MAIN_VITE_MAC_SIGNED=true when it signs, otherwise we only point to the download.
 * - Linux .deb: no (updated by the package manager or a new download).
 */
function canSelfUpdate(): boolean {
  if (process.platform === 'darwin') return import.meta.env.MAIN_VITE_MAC_SIGNED === 'true'
  if (process.platform === 'linux') return Boolean(process.env.APPIMAGE)
  return true
}

/**
 * Calm updates from GitHub Releases: check 10 s after launch and every 6 hours,
 * download quietly, then show "Restart to update". Never restarts on its own.
 */
export function createUpdates(
  store: StateStore,
  window: () => BrowserWindow | null,
  shutdown: Shutdown,
): Updates & { start(): void } {
  const selfUpdate = canSelfUpdate()
  const send = (status: UpdateStatus) => window()?.webContents.send(Channels.update, status)

  autoUpdater.logger = null
  autoUpdater.autoDownload = selfUpdate
  autoUpdater.autoInstallOnAppQuit = selfUpdate
  autoUpdater.on('update-available', (info) => {
    if (!selfUpdate) send({ kind: 'available', version: info.version, url: RELEASES })
  })
  autoUpdater.on('update-downloaded', (info) => send({ kind: 'ready', version: info.version }))
  autoUpdater.on('error', () => undefined) // offline or rate-limited: try again later, silently

  const check = async (manual: boolean): Promise<void> => {
    // Development builds and disabled checks never touch the network.
    if (!app.isPackaged || (!manual && !store.data.prefs.autoUpdate)) return
    try {
      const result = await autoUpdater.checkForUpdates()
      // With autoDownload the download runs on: a network failure there must not go unhandled.
      result?.downloadPromise?.catch((err: unknown) => console.error('[updates] download:', err))
    } catch {
      // Same as above: nothing to tell the user.
    }
  }

  return {
    start() {
      setTimeout(() => void check(false), FIRST_CHECK_MS)
      setInterval(() => void check(false), EVERY_MS)
    },
    check,
    install() {
      if (!selfUpdate) return
      // The installer kills the app soon after it starts: save everything first. The
      // shutdown is then done, so the quit that quitAndInstall starts goes straight through.
      void shutdown
        .run()
        .then(() => autoUpdater.quitAndInstall())
        .catch((err: unknown) => console.error('[updates] install:', err))
        // If the installer could not start, the library is closed all the same: quit
        // rather than leave a window that can no longer save.
        .finally(() => setTimeout(() => app.quit(), INSTALL_FALLBACK_MS))
    },
  }
}
