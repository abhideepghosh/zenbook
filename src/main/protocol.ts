import { extname, isAbsolute, join, normalize, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { net, protocol } from 'electron'

// The production renderer is served from app://zenbook/ instead of file://.
// That gives it a real origin (clean CSP, fonts and workers resolve normally)
// and lets V8 cache compiled code between launches (`codeCache`).
const SCHEME = 'app'
const HOST = 'zenbook'
export const APP_ORIGIN = `${SCHEME}://${HOST}/`
export const APP_URL = `${APP_ORIGIN}index.html`

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'", // WebAssembly only (Excalidraw's export font subsetting); no eval
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

/** Types file:// fetches don't infer (fonts as octet-stream would also break wasm streaming). */
const MIME: Record<string, string> = {
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
}

/** Must run before the app is ready. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true },
    },
  ])
}

/**
 * Maps a URL path onto a file inside `root`, or returns null when the path
 * would escape it (`..`, encoded separators, absolute paths).
 */
export function resolveInside(root: string, urlPath: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    return null
  }
  // Backslashes are separators on Windows only; our assets never contain them.
  if (decoded.includes('\0') || decoded.includes('\\')) return null
  const target = normalize(join(root, decoded))
  const rel = relative(root, target)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
  return target
}

export function handleAppProtocol(rendererDir: string): void {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url)
    if (url.host !== HOST) return new Response(null, { status: 404 })

    const pathname = url.pathname === '/' ? '/index.html' : url.pathname
    const file = resolveInside(rendererDir, pathname)
    if (!file) return new Response(null, { status: 403 })

    const response = await net.fetch(pathToFileURL(file).toString())
    const mime = MIME[extname(file).toLowerCase()]
    const isHtml = file.endsWith('.html')
    if (!mime && !isHtml) return response

    const headers = new Headers(response.headers)
    if (mime) headers.set('Content-Type', mime)
    if (isHtml) headers.set('Content-Security-Policy', CSP)
    return new Response(response.body, { status: response.status, headers })
  })
}
