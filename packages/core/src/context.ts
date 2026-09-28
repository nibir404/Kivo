import { CONCEPTS } from "./concepts"
import { CONCEPT_ENCOUNTERS } from "./seed"
import type { ContextItem, Experience, KivoRef, LibraryItem, ServiceSpec, SystemNode } from "./types"

/**
 * Context Engine — Personal AI without retraining.
 *
 *   Foundation model + Project Graph + Personal Knowledge + Experiences + Intent
 *
 * Retrieval is concept-anchored: the selected object resolves to concept ids, and
 * knowledge/experience items are scored by concept overlap and recency. Items the
 * user has excluded (`useAsContext: false`) are never retrieved.
 */
export function assembleContext(opts: {
  ref: KivoRef | null
  question?: string
  nodes: SystemNode[]
  services: ServiceSpec[]
  library: LibraryItem[]
  experiences: Experience[]
  personalEnabled: boolean
}): ContextItem[] {
  const { ref, question, nodes, services, library, experiences, personalEnabled } = opts
  // Primary concepts: the selection itself and anything named in the question. Related concepts count for less.
  const primary = new Set<string>()
  const related = new Set<string>()
  if (ref?.conceptId) primary.add(ref.conceptId)
  const q = (question ?? "").toLowerCase()
  for (const c of Object.values(CONCEPTS)) if (q.includes(c.name.toLowerCase())) primary.add(c.id)
  for (const p of primary) for (const r of CONCEPTS[p]?.related ?? []) if (!primary.has(r)) related.add(r)
  const anchor = new Set([...primary, ...related])
  const weight = (id?: string) => (!id ? 0 : primary.has(id) ? 1 : related.has(id) ? 0.4 : 0)

  const items: ContextItem[] = []
  if (question) items.push({ source: "intent", label: "Your question", detail: question, score: 1 })

  const node = nodes.find((n) => n.id === ref?.id || n.concept === ref?.conceptId)
  if (node) items.push({ source: "project", label: `System Graph · ${node.label}`, detail: `${node.tech} — ${node.purpose}`, score: 0.95 })
  for (const s of services) {
    if (anchor.has("jwt") || anchor.has("password-hashing") || ref?.id === s.id) {
      if (s.id === "authentication" || ref?.id === s.id) items.push({ source: "project", label: `Service IR · ${s.name}`, detail: `${s.requirements.length} requirements, ${s.api.endpoints.length} endpoints`, score: 0.9 })
    }
  }

  if (!personalEnabled) return items

  const now = Date.now()
  const recency = (t: number) => Math.max(0.3, 1 - (now - t) / (180 * 86_400_000))

  for (const li of library) {
    if (!li.useAsContext) continue
    const hit = Math.max(weight(li.conceptId), ...li.tags.map((t) => weight(t) * 0.8))
    if (hit >= 0.4) items.push({ source: "knowledge", label: `Note · ${li.title}`, detail: li.myUnderstanding || li.systemExplanation, score: round(hit * recency(li.createdAt)) })
  }
  for (const ex of experiences) {
    if (!ex.useAsContext) continue
    const overlap = ex.concepts.reduce((a, c) => a + weight(c), 0)
    // An experience must share a primary concept to be worth bringing up unprompted.
    if (ex.concepts.some((c) => primary.has(c))) {
      items.push({
        source: "experience",
        label: `Experience #${ex.number} · ${ex.title}`,
        detail: `${ex.lesson}${ex.metric ? ` (${ex.metric.label} ${ex.metric.before} → ${ex.metric.after})` : ""}`,
        score: round(Math.min(1, 0.4 + overlap * 0.3) * recency(ex.createdAt)),
      })
    }
  }
  return items.sort((a, b) => b.score - a.score)
}

/** Compose the AI answer. Production calls the model with the assembled context; this is a grounded template. */
export function answer(ref: KivoRef | null, question: string, ctx: ContextItem[]): string {
  const c = ref?.conceptId ? CONCEPTS[ref.conceptId] : undefined
  const exp = ctx.find((x) => x.source === "experience")
  const note = ctx.find((x) => x.source === "knowledge" && x.score >= 0.6)
  const parts: string[] = []
  if (c) parts.push(`${c.name}: ${c.whyHere}`)
  else parts.push(`Looking at ${ref?.label ?? "the project"} in the context of your question.`)
  if (/without/i.test(question) && c) parts.push(`Without it, the reason it exists stops being handled: ${c.layers.why.charAt(0).toLowerCase()}${c.layers.why.slice(1)} The trade-off it resolves: ${c.layers.tradeoffs}`)
  else if (/why/i.test(question) && c) parts.push(c.layers.why)
  else if (/slow|latency|perf|optimi/i.test(question) && c) parts.push(c.layers.tradeoffs)
  else if (c) parts.push(c.layers.how)
  if (exp) parts.push(`You've seen something similar before — ${exp.label.replace(/^Experience /, "experience ")}: "${exp.detail}". This project has a comparable pattern.`)
  else if (note) parts.push(`In your own words from an earlier note: "${note.detail}"`)
  return parts.join("\n\n")
}

export interface LearningInsight {
  conceptId: string
  name: string
  count: number
  explored: string[]
  unexplored: string[]
}

export function learningInsights(library: LibraryItem[], experiences: Experience[]): LearningInsight[] {
  return Object.entries(CONCEPT_ENCOUNTERS)
    .map(([id, e]) => {
      const c = CONCEPTS[id]
      const extra = library.filter((l) => l.conceptId === id).length + experiences.filter((x) => x.concepts.includes(id)).length
      return {
        conceptId: id,
        name: c.name,
        count: e.count + Math.max(0, extra - 2),
        explored: e.explored,
        unexplored: c.subtopics.filter((s) => !e.explored.includes(s)),
      }
    })
    .filter((i) => i.unexplored.length)
    .sort((a, b) => b.count - a.count)
}

const round = (x: number) => Math.round(x * 100) / 100
