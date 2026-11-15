import type { PageData } from '../../shared/api'

/**
 * The canvas and the notes editor both need a page when it opens. They share one
 * in-flight page.open per page id, so the whole scene is read and sent only once.
 */
export function createPageOpener(open: (id: string) => Promise<PageData>) {
  const inflight = new Map<string, Promise<PageData>>()
  return {
    open(id: string): Promise<PageData> {
      const existing = inflight.get(id)
      if (existing) return existing
      const request = open(id)
      inflight.set(id, request)
      const clear = () => {
        if (inflight.get(id) === request) inflight.delete(id)
      }
      request.then(clear, clear)
      return request
    },
    /** The page changed on disk: the next open must read it again. */
    invalidate(id: string): void {
      inflight.delete(id)
    },
  }
}

const opener = createPageOpener((id) => window.zenbook.page.open(id))

export const openPageData = opener.open
export const invalidatePageData = opener.invalidate
