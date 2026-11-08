// IPC channel names, shared by main and preload so they can never drift apart.
export const Channels = {
  appInfo: 'app:info',
} as const
