/**
 * Find-in-files matching, shared by the daemon (search + replace on disk) and the editor (replace
 * inside unsaved buffers), so both sides agree on exactly what a query matches. Matching is
 * line-oriented like ripgrep: `^`/`$` anchor to lines and a match never spans a newline.
 * No imports on purpose — the daemon includes this file directly.
 */

export interface MatchOptions {
  query: string
  regex?: boolean
  caseSensitive?: boolean
  wholeWord?: boolean
}

export interface LineMatch {
  /** 1-based line number. */
  line: number
  /** 0-based UTF-16 offset of the match within the line. */
  col: number
  len: number
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** A global RegExp for the query. Throws (with a readable message) when a regex doesn't compile. */
export function buildMatcher(o: MatchOptions): RegExp {
  let src = o.regex ? o.query : escape(o.query)
  // Lookarounds rather than \b, so a query that starts or ends with punctuation still works.
  if (o.wholeWord) src = `(?<![A-Za-z0-9_])(?:${src})(?![A-Za-z0-9_])`
  try {
    return new RegExp(src, o.caseSensitive ? "g" : "gi")
  } catch (err) {
    throw new Error(`Invalid regular expression: ${(err as Error).message.replace(/^Invalid regular expression: /, "")}`)
  }
}

/** Split into lines, remembering each line's terminator so a rewrite keeps CRLF files CRLF. */
export function splitLines(text: string): { text: string; eol: string }[] {
  const out: { text: string; eol: string }[] = []
  let start = 0
  for (;;) {
    const i = text.indexOf("\n", start)
    if (i === -1) {
      out.push({ text: text.slice(start), eol: "" })
      return out
    }
    const cr = i > start && text[i - 1] === "\r"
    out.push({ text: text.slice(start, cr ? i - 1 : i), eol: cr ? "\r\n" : "\n" })
    start = i + 1
  }
}

/** Every non-empty match in one line. Zero-length matches (e.g. `a*`) are skipped, not looped on. */
export function matchLine(re: RegExp, text: string, line: number, limit = Infinity): LineMatch[] {
  const out: LineMatch[] = []
  re.lastIndex = 0
  let m: RegExpExecArray | null
  while (out.length < limit && (m = re.exec(text))) {
    if (m[0].length === 0) {
      re.lastIndex++
      continue
    }
    out.push({ line, col: m.index, len: m[0].length })
  }
  return out
}

/** A match with context around it for a results list, trimmed for very long lines. */
export function previewHit(lineText: string, line: number, col: number, len: number) {
  const from = Math.max(0, col - 48)
  const before = from > 0 ? `…${lineText.slice(from, col)}` : lineText.slice(0, col).trimStart()
  return { line, col, len, before, text: lineText.slice(col, col + len).slice(0, 400), after: lineText.slice(col + len, col + len + 160) }
}

export function findInText(re: RegExp, text: string, limit = Infinity): LineMatch[] {
  const out: LineMatch[] = []
  const lines = splitLines(text)
  for (let i = 0; i < lines.length && out.length < limit; i++) out.push(...matchLine(re, lines[i].text, i + 1, limit - out.length))
  return out
}

/**
 * Replace every match. In regex mode the replacement understands $1, $<name> and $&; otherwise it
 * is inserted literally (a "$" in it stays a "$").
 */
export function replaceInText(re: RegExp, text: string, replacement: string, regex: boolean): { text: string; count: number } {
  let count = 0
  const lines = splitLines(text).map(({ text: line, eol }) => {
    re.lastIndex = 0
    const next = line.replace(re, (...args: unknown[]) => {
      const matched = args[0] as string
      if (!matched) return matched
      count++
      if (!regex) return replacement
      // Expand $-patterns for this one match by replaying String#replace on it with the same groups.
      const groups = args.slice(1)
      const named = typeof groups[groups.length - 1] === "object" ? (groups.pop() as Record<string, string> | undefined) : undefined
      const captures = groups.slice(0, -2) as (string | undefined)[]
      return replacement.replace(/\$(\$|&|\d{1,2}|<[^>]*>)/g, (tok, k: string) => {
        if (k === "$") return "$"
        if (k === "&") return matched
        if (k.startsWith("<")) return named?.[k.slice(1, -1)] ?? tok
        const n = Number(k)
        return n >= 1 && n <= captures.length ? (captures[n - 1] ?? "") : tok
      })
    })
    return next + eol
  })
  return { text: lines.join(""), count }
}

/**
 * Glob → RegExp for include/exclude filters, VS Code style: `*.ts` (no slash) matches at any
 * depth, `**` crosses folders, `{a,b}` alternates. A pattern also matches everything inside a
 * folder it matches, so `src` or `node_modules` work as folder filters.
 */
export function globToRegExp(glob: string): RegExp {
  let g = glob.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "")
  if (!g.includes("/")) g = `**/${g}`
  let re = ""
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === "*" && g[i + 1] === "*") {
      const slash = g[i + 2] === "/"
      re += slash ? "(?:.*/)?" : ".*"
      i += slash ? 2 : 1
    } else if (c === "*") re += "[^/]*"
    else if (c === "?") re += "[^/]"
    else if (c === "{") re += "(?:"
    else if (c === "}") re += ")"
    else if (c === "," && re.lastIndexOf("(?:") > re.lastIndexOf(")")) re += "|"
    else re += escape(c)
  }
  return new RegExp(`^${re}(?:/.*)?$`)
}

/** Comma-separated globs → a path predicate (null when the list is empty). */
export function globFilter(list: string | undefined): ((path: string) => boolean) | null {
  const globs = (list ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  if (!globs.length) return null
  const res = globs.map(globToRegExp)
  return (p) => res.some((r) => r.test(p))
}
