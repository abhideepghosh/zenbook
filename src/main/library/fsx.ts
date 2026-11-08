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
  const handle = await open(tmp, 'w')
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await renameWithRetry(tmp, path)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}

export async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

export async function readJson(path: string): Promise<unknown> {
  const text = await readText(path)
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
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
