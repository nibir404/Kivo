/**
 * Fuzzy matching for Quick Open and Go to Symbol. Characters must appear in order; the score
 * rewards matches in the file name over the folder path, consecutive runs, and matches at word
 * starts (after "/", "_", "-", ".", or a camelCase hump), so "rtpy" finds router.py first.
 */

export interface Scored {
  score: number
  /** Indices into the candidate string that matched (for highlighting). */
  hits: number[]
}

const boundary = (s: string, i: number) => i === 0 || "/_-. ".includes(s[i - 1]) || (s[i] >= "A" && s[i] <= "Z" && s[i - 1] >= "a" && s[i - 1] <= "z")

/** Greedy subsequence match from `from`, preferring word starts. Returns null when it doesn't match. */
function match(q: string, s: string, from: number): Scored | null {
  const lower = s.toLowerCase()
  const hits: number[] = []
  let score = 0
  let i = from
  let prev = -2
  for (const ch of q) {
    // Prefer the next occurrence at a word boundary if there is one before the plain next occurrence's run breaks.
    let at = lower.indexOf(ch, i)
    if (at < 0) return null
    if (at !== prev + 1) {
      for (let j = at; j < lower.length; j++) {
        if (lower[j] === ch && boundary(s, j)) {
          at = j
          break
        }
      }
    }
    score += 1
    if (at === prev + 1) score += 5
    if (boundary(s, at)) score += 8
    if (s[at] === ch) score += 1
    hits.push(at)
    prev = at
    i = at + 1
  }
  return { score: score - s.length * 0.05, hits }
}

/** Score a query against a path: a hit in the base name counts far more than one in folders. */
export function scorePath(query: string, path: string): Scored | null {
  const q = query.replace(/\s+/g, "").toLowerCase()
  if (!q) return { score: 0, hits: [] }
  const slash = path.lastIndexOf("/") + 1
  const name = path.slice(slash).toLowerCase()
  const inName = match(q, path, slash)
  if (inName) {
    let bonus = 40
    if (name.startsWith(q)) bonus += 40
    else if (name.includes(q)) bonus += 25
    if (name === q || name.split(".")[0] === q) bonus += 30
    return { score: inName.score + bonus, hits: inName.hits }
  }
  const any = match(q, path, 0)
  if (!any) return null
  return { score: any.score + (path.toLowerCase().includes(q) ? 15 : 0), hits: any.hits }
}

export function scoreText(query: string, text: string): Scored | null {
  const q = query.replace(/\s+/g, "").toLowerCase()
  if (!q) return { score: 0, hits: [] }
  const m = match(q, text, 0)
  if (!m) return null
  return { score: m.score + (text.toLowerCase().startsWith(q) ? 30 : text.toLowerCase().includes(q) ? 15 : 0), hits: m.hits }
}
