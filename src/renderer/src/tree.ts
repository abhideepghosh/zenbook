import type { ChapterNode, PageNode, SpaceNode, Tree } from '../../shared/api'

// Pure helpers over the library tree (no React, no IPC), so they're easy to test.

export interface PageLocation {
  space: SpaceNode
  chapter: ChapterNode
  page: PageNode
  spaceIndex: number
  chapterIndex: number
  pageIndex: number
}

export function locatePage(tree: Tree, pageId: string | null): PageLocation | null {
  if (!pageId) return null
  for (const [spaceIndex, space] of tree.spaces.entries()) {
    for (const [chapterIndex, chapter] of space.chapters.entries()) {
      const pageIndex = chapter.pages.findIndex((p) => p.id === pageId)
      if (pageIndex >= 0) {
        return {
          space,
          chapter,
          page: chapter.pages[pageIndex]!,
          spaceIndex,
          chapterIndex,
          pageIndex,
        }
      }
    }
  }
  return null
}

export function locateChapter(
  tree: Tree,
  chapterId: string,
): { space: SpaceNode; chapter: ChapterNode } | null {
  for (const space of tree.spaces) {
    const chapter = space.chapters.find((c) => c.id === chapterId)
    if (chapter) return { space, chapter }
  }
  return null
}

export function findSpace(tree: Tree, spaceId: string | null): SpaceNode | null {
  return tree.spaces.find((s) => s.id === spaceId) ?? null
}

export function firstPage(space: SpaceNode | null | undefined): PageNode | null {
  for (const chapter of space?.chapters ?? []) if (chapter.pages[0]) return chapter.pages[0]
  return null
}

/** Pages of a space in reading order (chapter by chapter). */
export function pagesOf(space: SpaceNode | null | undefined): PageNode[] {
  return (space?.chapters ?? []).flatMap((c) => c.pages)
}

/** The page before or after `pageId` within its space, crossing chapter boundaries. */
export function adjacentPage(tree: Tree, pageId: string | null, step: 1 | -1): PageNode | null {
  const loc = locatePage(tree, pageId)
  if (!loc) return null
  const pages = pagesOf(loc.space)
  const i = pages.findIndex((p) => p.id === pageId)
  return pages[i + step] ?? null
}

/**
 * When the current page disappears (deleted here or elsewhere), pick the page
 * that took its place, so the user lands somewhere sensible.
 */
export function fallbackPage(
  previous: Tree,
  next: Tree,
  pageId: string | null,
  spaceId: string | null,
): PageNode | null {
  const old = locatePage(previous, pageId)
  if (old) {
    const chapter = next.spaces.flatMap((s) => s.chapters).find((c) => c.id === old.chapter.id)
    if (chapter?.pages.length)
      return chapter.pages[Math.min(old.pageIndex, chapter.pages.length - 1)] ?? null
  }
  return firstPage(findSpace(next, old?.space.id ?? spaceId)) ?? firstPage(next.spaces[0])
}

/** Index to pass to ops.move so `dragged` lands before/after `target` in `ids`. */
export function dropIndex(ids: string[], dragged: string, target: string, after: boolean): number {
  const without = ids.filter((id) => id !== dragged)
  const at = without.indexOf(target)
  return at < 0 ? without.length : at + (after ? 1 : 0)
}
