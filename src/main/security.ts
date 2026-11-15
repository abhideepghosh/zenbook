import { app, session, shell } from 'electron'
import { APP_ORIGIN, APP_URL } from './protocol'

// Electron grants every permission unless told otherwise. Allow only what the
// canvas needs (copy/paste images, fullscreen).
const ALLOWED_PERMISSIONS = new Set(['clipboard-read', 'clipboard-sanitized-write', 'fullscreen'])

function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

function sameSite(a: string, b: string): boolean {
  try {
    const x = new URL(a)
    const y = new URL(b)
    // Compare scheme + host: URL.origin is "null" for custom schemes like app://.
    return x.protocol === y.protocol && x.host === y.host
  } catch {
    return false
  }
}

/**
 * The only page the window may navigate to: our index (any hash or query), or the
 * dev server in development. Reloads and in-page (hash) navigation never get here.
 */
function isAppPage(url: string): boolean {
  try {
    const target = new URL(url)
    target.hash = ''
    target.search = ''
    if (target.href === APP_URL || target.href === APP_ORIGIN) return true
  } catch {
    return false
  }
  const devUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL
  return devUrl !== undefined && sameSite(url, devUrl)
}

export function hardenSecurity(): void {
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission))
  })
  session.defaultSession.setPermissionCheckHandler((_contents, permission) =>
    ALLOWED_PERMISSIONS.has(permission),
  )

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault())
    contents.on('will-navigate', (event, url) => {
      if (!isAppPage(url)) event.preventDefault()
    })
    // Links on canvas elements open in the user's browser, never inside the app.
    contents.setWindowOpenHandler(({ url }) => {
      if (isWebUrl(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
  })
}
