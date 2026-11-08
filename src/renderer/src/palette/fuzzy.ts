/**
 * A small subsequence matcher for action names: "tgn" matches "Toggle notes".
 * Rewards consecutive letters and word starts. Returns null when it doesn't match.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, '')
  if (!q) return 0
  const t = text.toLowerCase()
  let score = 0
  let ti = 0
  let streak = 0
  for (const ch of q) {
    const found = t.indexOf(ch, ti)
    if (found < 0) return null
    const wordStart = found === 0 || /[\s/:·-]/.test(t[found - 1] ?? '')
    streak = found === ti ? streak + 1 : 0
    score += 1 + streak * 2 + (wordStart ? 3 : 0) - Math.min(found - ti, 5) * 0.2
    ti = found + 1
  }
  return score - t.length * 0.01
}

export function fuzzyFilter<T>(
  query: string,
  items: T[],
  text: (item: T) => string,
  limit = 8,
): T[] {
  return items
    .map((item) => ({ item, score: fuzzyScore(query, text(item)) }))
    .filter((x): x is { item: T; score: number } => x.score !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.item)
}
