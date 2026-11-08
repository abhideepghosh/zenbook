// The typed bridge between the sandboxed renderer and the main process.
// Implemented in src/preload/index.ts, exposed as window.zenbook.

export type Platform = 'darwin' | 'win32' | 'linux'

export interface AppInfo {
  name: string
  version: string
}

export interface ZenbookApi {
  /** Known synchronously so layout (traffic lights, window controls) never shifts. */
  platform: Platform
  app: {
    info(): Promise<AppInfo>
  }
}
