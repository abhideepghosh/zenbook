import { contextBridge, ipcRenderer } from 'electron'
import type { Platform, ZenbookApi } from '../shared/api'
import { Channels } from '../shared/channels'

// The only door between the sandboxed page and the rest of the system.
const api: ZenbookApi = {
  platform: process.platform as Platform,
  app: {
    info: () => ipcRenderer.invoke(Channels.appInfo),
  },
}

contextBridge.exposeInMainWorld('zenbook', api)
