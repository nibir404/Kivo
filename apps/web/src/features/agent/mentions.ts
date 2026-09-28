import { api } from "@/lib/api"
import { useKivo } from "@/state/store"
import type { Mention } from "./store"

/** Caps keep a message with attachments inside the provider's small per-minute token budget. */
export const MENTION_FILE_CHARS = 6000
export const MENTION_TOTAL_CHARS = 12_000

/** Fuzzy file match: every query character in order; contiguous runs and basename hits score higher. */
export function fuzzyFiles(query: string, files: string[], limit = 8): string[] {
  const q = query.toLowerCase()
  if (!q) return files.slice(0, limit)
  const scored: { f: string; s: number }[] = []
  for (const f of files) {
    const p = f.toLowerCase()
    const base = p.slice(p.lastIndexOf("/") + 1)
    let s = 0
    let at = -1
    let run = 0
    let ok = true
    for (const ch of q) {
      const i = p.indexOf(ch, at + 1)
      if (i < 0) {
        ok = false
        break
      }
      run = i === at + 1 ? run + 1 : 0
      s += 1 + run * 2
      at = i
    }
    if (!ok) continue
    if (base.startsWith(q)) s += 30
    else if (base.includes(q)) s += 15
    else if (p.includes(q)) s += 8
    s -= p.length / 100
    scored.push({ f, s })
  }
  return scored
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.f)
}

export const mentionLabel = (m: Mention) => (m.kind === "file" ? m.path : m.kind === "open" ? `open: ${m.path}` : `selection: ${m.label}`)

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n[… ${s.length - n} more characters not attached]` : s)

/** The attached context for a message: mentioned files' contents (unsaved editor text wins), capped. */
export async function mentionContext(mentions: Mention[]): Promise<string> {
  if (!mentions.length) return ""
  const s = useKivo.getState()
  const parts: string[] = []
  let budget = MENTION_TOTAL_CHARS
  for (const m of mentions) {
    if (budget <= 200) {
      parts.push(`(${mentionLabel(m)} not attached — context limit reached)`)
      continue
    }
    let body: string
    let title: string
    if (m.kind === "selection") {
      title = `Selected code: ${m.label}`
      body = m.text
    } else {
      title = m.kind === "open" ? `File open in the editor: ${m.path}` : `File: ${m.path}`
      const cached = s.fileCache[m.path]
      try {
        body = cached ? cached.content : (await api.read(m.path)).content
        if (cached && cached.content !== cached.saved) title += " (unsaved changes)"
      } catch (err) {
        parts.push(`(${m.path} could not be read: ${(err as Error).message})`)
        continue
      }
    }
    const text = clip(body, Math.min(MENTION_FILE_CHARS, budget))
    budget -= text.length
    parts.push(`--- ${title} ---\n${text}`)
  }
  return `Attached by the user with @:\n\n${parts.join("\n\n")}`
}
