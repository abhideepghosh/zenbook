import { app, ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { AppInfo } from '../shared/api'
import { Channels } from '../shared/channels'
import { APP_ORIGIN } from './protocol'

/** Only our own renderer may call the API, never a frame or page it navigated to. */
function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url
  if (!url) return false
  const devUrl = process.env.ELECTRON_RENDERER_URL
  return url.startsWith(APP_ORIGIN) || (devUrl !== undefined && url.startsWith(devUrl))
}

/**
 * Registers an invoke handler. Every channel goes through here so sender checks
 * (and, from Phase 2, zod argument validation) can't be forgotten.
 */
function handle<R>(channel: string, fn: (event: IpcMainInvokeEvent) => R | Promise<R>): void {
  ipcMain.handle(channel, (event) => {
    if (!isTrustedSender(event)) throw new Error(`Blocked IPC from untrusted sender: ${channel}`)
    return fn(event)
  })
}

export function registerIpc(): void {
  handle(Channels.appInfo, (): AppInfo => ({ name: app.getName(), version: app.getVersion() }))
}
