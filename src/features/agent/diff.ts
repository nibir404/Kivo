/** A small line diff for reviewing agent edits (no dependency; big files degrade to a block replace). */

export type DiffLine = { type: "ctx" | "add" | "del"; text: string }
export type HunkLine = DiffLine | { type: "gap"; count: number }

const MAX_CELLS = 4_000_000

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before ? before.split("\n") : []
  const b = after ? after.split("\n") : []
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const head: DiffLine[] = a.slice(0, start).map((text) => ({ type: "ctx", text }))
  const tail: DiffLine[] = a.slice(endA).map((text) => ({ type: "ctx", text }))
  const x = a.slice(start, endA)
  const y = b.slice(start, endB)
  const n = x.length
  const m = y.length
  const mid: DiffLine[] = []
  if (n * m > MAX_CELLS) {
    x.forEach((text) => mid.push({ type: "del", text }))
    y.forEach((text) => mid.push({ type: "add", text }))
  } else {
    // LCS table over the changed middle only.
    const w = m + 1
    const t = new Uint32Array((n + 1) * w)
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i * w + j] = x[i] === y[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1])
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (x[i] === y[j]) {
        mid.push({ type: "ctx", text: x[i] })
        i++
        j++
      } else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) mid.push({ type: "del", text: x[i++] })
      else mid.push({ type: "add", text: y[j++] })
    }
    while (i < n) mid.push({ type: "del", text: x[i++] })
    while (j < m) mid.push({ type: "add", text: y[j++] })
  }
  return [...head, ...mid, ...tail]
}

/** Collapse unchanged runs to `context` lines around each change. */
export function hunks(lines: DiffLine[], context = 3): HunkLine[] {
  const keep = new Array(lines.length).fill(false)
  lines.forEach((l, i) => {
    if (l.type === "ctx") return
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true
  })
  const out: HunkLine[] = []
  let gap = 0
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (gap) out.push({ type: "gap", count: gap })
      gap = 0
      out.push(l)
    } else gap++
  })
  if (gap) out.push({ type: "gap", count: gap })
  return out
}

export function diffStats(lines: DiffLine[]) {
  return { added: lines.filter((l) => l.type === "add").length, removed: lines.filter((l) => l.type === "del").length }
}
