import { randomBytes } from 'node:crypto'
import { open, readFile, rename, rm, stat } from 'node:fs/promises'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Errors Windows raises while antivirus or a sync tool briefly holds a file. */
const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES'])

/** True for the errors Windows gives when another program holds a file or folder open. */
export function isLockError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code
  return code !== undefined && TRANSIENT.has(code)
}

/** Turns a lock error into a message people can act on; other errors pass through. */
export function describeLockError(err: unknown, name: string): unknown {
  if (!isLockError(err)) return err
  return new Error(
    `“${name}” is in use by another program (an Explorer window, a sync tool or antivirus). Close it and try again.`,
    { cause: err },
  )
}

/** rename() with backoff for transient Windows locks (~1.5 s in total). */
export async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (!code || !TRANSIENT.has(code) || attempt >= 8) throw err
      await sleep(25 * 2 ** Math.min(attempt, 5))
    }
  }
}

/**
 * Crash-safe write: write a temp file next to the target, fsync it, then rename
 * over the target. A reader (or a crash) only ever sees the old or the new file,
 * never half of one.
 */
export async function atomicWrite(path: string, data: string | Uint8Array): Promise<void> {
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`
  try {
    const handle = await open(tmp, 'w')
    try {
      await handle.writeFile(data)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await renameWithRetry(tmp, path)
  } catch (err) {
    // A full disk, a lock or a vanished folder: never leave the temp file behind.
    await rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
}

/** Temp files written by atomicWrite: "<name>.<ext>.<8 hex>.tmp", for the files Zenbook writes. */
export const TEMP_FILE =
  /^.+\.(?:excalidraw|md|json|excalidrawlib|png|jpg|gif|webp|svg|bmp|avif|ico|bin)\.[0-9a-f]{8}\.tmp$/i

/** True when an error means "there is nothing there" (as opposed to "can't read it"). */
export function isMissingError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** Lenient read: null when the file is missing or can't be read. Never use it to decide to overwrite. */
export async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/** readFile with a short backoff for transient Windows locks (antivirus, indexers, sync tools). */
export async function readFileWithRetry(path: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await readFile(path, 'utf8')
    } catch (err) {
      if (!isLockError(err) || attempt >= 4) throw err
      await sleep(25 * 2 ** attempt)
    }
  }
}

/** Strict read: null only when the file is missing; any other error throws. */
export async function readTextStrict(path: string): Promise<string | null> {
  try {
    return await readFileWithRetry(path)
  } catch (err) {
    if (isMissingError(err)) return null
    throw err
  }
}

export type JsonRead =
  | { status: 'ok'; value: Record<string, unknown> }
  | { status: 'missing' }
  /**
   * `corrupt`: the file was read but isn't a JSON object (invalid, empty, an array…).
   * Otherwise the file couldn't be read at all (a lock, permissions, a folder…).
   */
  | { status: 'unreadable'; error: unknown; corrupt: boolean }

/** How long to wait before re-reading a damaged file: sync tools truncate, then write. */
export const CORRUPT_REREAD_MS = 250

function parseObject(text: string): JsonRead {
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return { status: 'ok', value: value as Record<string, unknown> }
    }
    return { status: 'unreadable', error: new Error('Not a JSON object'), corrupt: true }
  } catch (error) {
    return { status: 'unreadable', error, corrupt: true }
  }
}

async function readOnce(path: string): Promise<JsonRead> {
  let text: string
  try {
    text = await readFileWithRetry(path)
  } catch (error) {
    return isMissingError(error)
      ? { status: 'missing' }
      : { status: 'unreadable', error, corrupt: false }
  }
  return parseObject(text)
}

/**
 * Strict read of a metadata file. Only a missing file is "missing": a locked file,
 * invalid JSON or JSON that isn't an object is "unreadable", and must not be
 * replaced blindly, because it may hold IDs, order, colours and pins we can't see.
 * A damaged file is read a second time after a short pause, which rides out a sync
 * tool that truncates a file and then writes it.
 */
export async function readJsonFile(path: string): Promise<JsonRead> {
  const first = await readOnce(path)
  if (first.status !== 'unreadable' || !first.corrupt) return first
  await sleep(CORRUPT_REREAD_MS)
  return readOnce(path)
}

/** Strict existence check: true/false only when we know; other errors (EPERM…) throw. */
export async function isMissing(path: string): Promise<boolean> {
  try {
    await stat(path)
    return false
  } catch (err) {
    if (isMissingError(err)) return true
    throw err
  }
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export interface Fingerprint {
  mtimeMs: number
  size: number
}

export async function fingerprint(path: string): Promise<Fingerprint | null> {
  try {
    const s = await stat(path)
    return { mtimeMs: s.mtimeMs, size: s.size }
  } catch {
    return null
  }
}

/**
 * Serialises writes per path. While a write is in flight only the newest pending
 * content is kept, so a burst of autosaves becomes at most two disk writes.
 * After each write the file's fingerprint is recorded so the watcher can tell
 * our own writes from changes made by other apps or sync tools.
 */
export class WriteQueue {
  private readonly inflight = new Map<string, Promise<void>>()
  private readonly pending = new Map<
    string,
    {
      data: string | Uint8Array
      waiters: Array<{ resolve: () => void; reject: (e: unknown) => void }>
    }
  >()
  readonly written = new Map<string, Fingerprint>()

  write(path: string, data: string | Uint8Array): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const existing = this.pending.get(path)
      if (existing) {
        existing.data = data
        existing.waiters.push({ resolve, reject })
      } else {
        this.pending.set(path, { data, waiters: [{ resolve, reject }] })
      }
      if (!this.inflight.has(path)) void this.run(path)
    })
  }

  private async run(path: string): Promise<void> {
    const job = this.pending.get(path)
    if (!job) return
    this.pending.delete(path)
    const task = (async () => {
      try {
        await atomicWrite(path, job.data)
        const fp = await fingerprint(path)
        if (fp) this.written.set(path, fp)
        for (const w of job.waiters) w.resolve()
      } catch (err) {
        for (const w of job.waiters) w.reject(err)
      }
    })()
    this.inflight.set(path, task)
    await task
    this.inflight.delete(path)
    if (this.pending.has(path)) await this.run(path)
  }

  /** True if the file on disk is exactly what we last wrote. */
  async isOwnWrite(path: string): Promise<boolean> {
    const mine = this.written.get(path)
    if (!mine) return false
    const now = await fingerprint(path)
    return now !== null && now.mtimeMs === mine.mtimeMs && now.size === mine.size
  }

  private readonly removedByUs = new Map<string, number>()

  /** Deletes a file and remembers that we did, so the watcher doesn't report it. */
  async remove(path: string): Promise<void> {
    await this.drain()
    this.removedByUs.set(path, Date.now())
    await rm(path, { force: true })
  }

  /** True if we deleted this file in the last few seconds. */
  isOwnRemoval(path: string): boolean {
    const at = this.removedByUs.get(path)
    if (at === undefined) return false
    if (Date.now() - at > 5000) {
      this.removedByUs.delete(path)
      return false
    }
    return true
  }

  /** Remember a path we just changed by other means (rename, copy). */
  async remember(path: string): Promise<void> {
    const fp = await fingerprint(path)
    if (fp) this.written.set(path, fp)
  }

  async drain(): Promise<void> {
    while (this.inflight.size > 0 || this.pending.size > 0) {
      await Promise.allSettled([...this.inflight.values()])
      if (this.inflight.size === 0) {
        for (const path of [...this.pending.keys()]) void this.run(path)
        await sleep(0)
      }
    }
  }
}
