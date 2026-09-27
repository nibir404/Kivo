import { toast } from "sonner"
import { CONCEPTS } from "@/core/concepts"
import { answer, assembleContext } from "@/core/context"
import { parseIntent } from "@/core/intent"
import type { ContextItem, KivoRef, LogLine, ServiceSpec } from "@/core/types"
import { api, sse, subscribe } from "@/lib/api"
import { useKivo, type StepRun } from "./store"

/**
 * Runners connect the UI to the local daemon. Every one has an offline fallback so the
 * product still works (with simulated behaviour, clearly labelled) when the daemon is down.
 */

const S = () => useKivo.getState()
const set = useKivo.setState

let started = false
let unsubscribe: (() => void) | null = null
let warned = false

/** Connect to the daemon; if it isn't up yet (or restarts), keep retrying quietly and reconnect. */
export async function init() {
  if (started) return
  started = true
  connect()
  // Detect daemon restarts (e.g. after an update) and reconnect without a page reload.
  setInterval(async () => {
    if (!S().daemon) return
    try {
      await api.health()
    } catch {
      set({ daemon: false })
      connect()
    }
  }, 10_000)
}

async function connect(attempt = 0): Promise<void> {
  try {
    const health = await api.health()
    set({ ai: health, daemon: true, project: health.project })
    const [project, tree] = await Promise.all([api.project(), api.tree()])
    set({ analysis: project, files: tree.files })
    if (warned) toast.success("Reconnected to the Kivo daemon")
    warned = false
    unsubscribe?.()
    unsubscribe = subscribe((e) => {
      if (e.t === "service-log") {
        const line = String(e.line)
        const level: LogLine["level"] = /error|exception|traceback/i.test(line) ? "error" : /warn|\s4\d\d\b/i.test(line) ? "warn" : "info"
        set((s) => ({ logs: [...s.logs, { id: crypto.randomUUID(), at: Date.now(), level, source: String(e.service), message: line }].slice(-400) }))
      }
    })
  } catch {
    set({ daemon: false, ai: null })
    if (attempt === 3 && !warned) {
      warned = true
      toast("Kivo daemon not connected", { description: "Working offline with simulated builds. Kivo will reconnect automatically when it's running (npm run dev)." })
    }
    setTimeout(() => connect(attempt + 1), Math.min(10_000, 1000 + attempt * 1000))
  }
}

export async function refreshFiles() {
  if (!S().daemon) return
  const { files } = await api.tree()
  set({ files })
}

export async function openFile(path: string) {
  const s = S()
  if (s.fileCache[path]) return s.openFile(path)
  if (!s.daemon) return s.openFile(path, "// Daemon offline — file contents unavailable.\n")
  try {
    const { content } = await api.read(path)
    s.openFile(path, content)
  } catch (err) {
    toast.error(`Couldn't open ${path}`, { description: String((err as Error).message) })
  }
}

export async function saveFile(path: string) {
  const f = S().fileCache[path]
  if (!f) return
  await api.write(path, f.content)
  S().markSaved(path)
}

// ─── Describe → Understand ──────────────────────────────────────────────────

export async function understand(text: string) {
  const s = S()
  if (!s.ai?.ai) {
    s.setDraft(parseIntent(text, s.stack))
    return
  }
  set({ understanding: { text, reasoning: "" }, draft: null, activeServiceId: null, mode: "build" })
  try {
    await sse<{ t: string; channel?: string; text?: string; spec?: ServiceSpec; waitMs?: number; message?: string }>("/api/ai/intent", { text, stack: s.stack }, (e) => {
      if (e.t === "delta" && e.channel === "reasoning") set((st) => (st.understanding ? { understanding: { ...st.understanding, reasoning: st.understanding.reasoning + e.text, waiting: undefined } } : {}))
      if (e.t === "wait" && e.waitMs) set((st) => (st.understanding ? { understanding: { ...st.understanding, waiting: `Rate limit — retrying in ${Math.ceil(e.waitMs! / 1000)}s` } } : {}))
      if (e.t === "result" && e.spec) S().setDraft(e.spec)
      if (e.t === "error") throw new Error(e.message)
    })
  } catch (err) {
    set((st) => ({ understanding: st.understanding ? { ...st.understanding, error: String((err as Error).message) } : null }))
  }
}

// ─── Build ──────────────────────────────────────────────────────────────────

type BuildEvent =
  | { t: "step"; id: string; status: StepRun["status"]; note?: string }
  | { t: "delta"; id: string; channel: "reasoning" | "content"; text: string }
  | { t: "log"; id: string; text: string }
  | { t: "file"; id: string; path: string }
  | { t: "tests"; results: { name: string; status: "pass" | "fail" }[] }
  | { t: "url"; url: string; routes: string[] }
  | { t: "done"; ok: boolean; commit?: string }
  | { t: "error"; message: string }

export async function build() {
  const s = S()
  if (!s.daemon || !s.ai?.ai) return s.startBuild()
  const spec = s.beginRealBuild()
  if (!spec) return

  // Tokens arrive very fast; buffer and flush to the store a few times per second.
  const pending: Record<string, { output: string; reasoning: string; logs: string[]; waiting?: string | null }> = {}
  const out: string[] = []
  const flush = () => {
    const ids = Object.keys(pending)
    if (!ids.length && !out.length) return
    S().patchBuild((b) => {
      const runs = { ...b.runs }
      for (const id of ids) {
        const p = pending[id]
        runs[id] = {
          ...runs[id],
          output: runs[id].output + p.output,
          reasoning: runs[id].reasoning + p.reasoning,
          logs: [...runs[id].logs, ...p.logs].slice(-400),
          waiting: p.waiting === undefined ? runs[id].waiting : (p.waiting ?? undefined),
        }
        delete pending[id]
      }
      return { ...b, runs }
    })
    if (out.length) S().appendOutput(out.splice(0))
  }
  const timer = setInterval(flush, 90)
  const buf = (id: string) => (pending[id] ??= { output: "", reasoning: "", logs: [] })
  let tests: ServiceSpec["tests"] | undefined
  let url: string | undefined
  let routes: string[] | undefined

  try {
    await sse<BuildEvent>("/api/build", { spec }, (e) => {
      switch (e.t) {
        case "delta":
          buf(e.id)[e.channel === "content" ? "output" : "reasoning"] += e.text
          buf(e.id).waiting = null
          break
        case "log":
          buf(e.id).logs.push(e.text)
          if (e.text.startsWith("⏳")) buf(e.id).waiting = e.text.replace(/^⏳\s*/, "")
          else if (!e.text.startsWith("↻")) buf(e.id).waiting = null
          out.push(e.text)
          break
        case "file":
          flush()
          S().patchBuild((b) => ({ ...b, runs: { ...b.runs, [e.id]: { ...b.runs[e.id], files: [...new Set([...b.runs[e.id].files, e.path])] } } }))
          // Keep open editor tabs in sync with files the pipeline rewrites.
          if (S().fileCache[e.path]) api.read(e.path).then(({ content }) => set((st) => ({ fileCache: { ...st.fileCache, [e.path]: { content, saved: content } } })))
          break
        case "step": {
          flush()
          const b = S().build!
          const index = b.steps.findIndex((x) => x.id === e.id)
          S().patchBuild((bb) => ({
            ...bb,
            index: e.status === "active" ? index : bb.index,
            runs: {
              ...bb.runs,
              [e.id]: {
                ...bb.runs[e.id],
                status: e.status,
                note: e.note,
                waiting: undefined,
                ...(e.status === "active" ? { startedAt: Date.now() } : { endedAt: Date.now() }),
              },
            },
          }))
          if (e.status === "active") {
            set((st) => ({ focusStepId: !st.focusStepId || st.build?.runs[st.focusStepId]?.status !== "todo" ? e.id : st.focusStepId }))
            out.push(`▸ ${b.steps[index]?.title}`)
          } else if (e.note) out.push(`  ${e.status === "failed" ? "✗" : e.status === "skipped" ? "–" : "✓"} ${e.note}`)
          break
        }
        case "tests":
          tests = e.results.map((r) => ({ name: r.name, status: r.status }))
          break
        case "url":
          url = e.url
          routes = e.routes
          break
        case "done":
          flush()
          S().finishRealBuild(e.ok, { url, routes, commit: e.commit, tests })
          out.push(e.ok ? `✓ ${spec.name} built, tested and running — commit ${e.commit}` : `✗ ${spec.name} finished with failures — see the failed step${e.commit ? ` (checkpoint ${e.commit})` : ""}`)
          break
        case "error":
          throw new Error(e.message)
      }
    })
  } catch (err) {
    flush()
    S().finishRealBuild(false, { url, routes, tests, error: String((err as Error).message) })
    toast.error("Build stopped", { description: String((err as Error).message) })
  } finally {
    clearInterval(timer)
    flush()
    refreshFiles()
  }
}

// ─── Ask AI / Explain ───────────────────────────────────────────────────────

function contextText(items: ContextItem[], ref: KivoRef | null, extra = "") {
  const s = S()
  const services = s.services.map((x) => `- ${x.name} (${x.status}): ${x.purpose} — ${x.api.endpoints.map((e) => `${e.method} ${e.path}`).join(", ")}`).join("\n")
  const c = ref?.conceptId ? CONCEPTS[ref.conceptId] : undefined
  return [
    `Project "${s.project}": ${s.analysis.summary}. Detected: ${s.analysis.detections.map((d) => d.tech).join(", ")}.`,
    `Services:\n${services}`,
    ref ? `The user selected (${ref.kind}): ${ref.label}${ref.detail ? `\n${ref.detail}` : ""}` : "",
    c ? `Concept: ${c.name} — ${c.what} In this project: ${c.whyHere}` : "",
    items.filter((i) => i.source === "knowledge" || i.source === "experience").map((i) => `${i.label}: ${i.detail}`).join("\n"),
    extra,
  ]
    .filter(Boolean)
    .join("\n\n")
}

/** Answer the latest user message. Streams from the active AI provider when available, grounded template otherwise. */
export async function ask(question: string, ref: KivoRef | null) {
  const s = S()
  s.pushChat({ id: crypto.randomUUID(), role: "user", text: question, ref })
  const ctx = assembleContext({ ref, question, nodes: s.nodes, services: s.services, library: s.library, experiences: s.experiences, personalEnabled: s.personalContext })
  const id = crypto.randomUUID()

  if (!s.ai?.ai) {
    s.pushChat({ id, role: "assistant", text: answer(ref, question, ctx), context: ctx })
    return
  }
  s.pushChat({ id, role: "assistant", text: "", reasoning: "", context: ctx, streaming: true, model: s.ai.model })

  let code = ""
  if (ref && (ref.kind === "code" || ref.kind === "text") && S().activeFile && S().fileCache[S().activeFile!]) {
    code = `Open file ${S().activeFile}:\n${S().fileCache[S().activeFile!].content.slice(0, 6000)}`
  }
  const history = S()
    .chat.filter((m) => m.id !== id && m.text)
    .slice(-8)
    .map((m) => ({ role: m.role, content: m.text }))

  let text = ""
  let reasoning = ""
  const flush = () => S().updateChat(id, { text, reasoning })
  const timer = setInterval(flush, 80)
  try {
    await sse<{ t: string; channel?: string; text?: string; waitMs?: number }>("/api/ai/chat", { messages: history, context: contextText(ctx, ref, code), level: s.level }, (e) => {
      if (e.t === "delta") {
        if (e.channel === "content") text += e.text
        else reasoning += e.text
      }
      if (e.t === "wait" && e.waitMs && !text) S().updateChat(id, { text: `_Rate limit — retrying in ${Math.ceil(e.waitMs / 1000)}s…_` })
    })
  } catch (err) {
    text ||= `Couldn't reach the model: ${(err as Error).message}\n\n${answer(ref, question, ctx)}`
  } finally {
    clearInterval(timer)
    S().updateChat(id, { text, reasoning, streaming: false })
  }
}

/** One-off explanation for the Explanation tab (doesn't enter the chat history). */
export async function explainInline(ref: KivoRef, onText: (text: string) => void, signal: AbortSignal) {
  const s = S()
  const ctx = assembleContext({ ref, nodes: s.nodes, services: s.services, library: s.library, experiences: s.experiences, personalEnabled: s.personalContext })
  const file = ref.kind === "code" && s.activeFile ? s.fileCache[s.activeFile]?.content : undefined
  const surrounding = file ? `Surrounding file ${s.activeFile}:\n${file.slice(0, 5000)}` : ""
  let text = ""
  await sse<{ t: string; channel?: string; text?: string }>(
    "/api/ai/chat",
    {
      level: s.level,
      context: contextText(ctx, ref, surrounding),
      messages: [{ role: "user", content: `Explain the selected ${ref.kind === "code" ? "code" : "text"} in this project: what it does, why it's here, and anything worth noticing. Be brief — at most ~120 words, short paragraphs or bullets.` }],
    },
    (e) => {
      if (e.t === "delta" && e.channel === "content") onText((text += e.text!))
    },
    signal,
  )
  return text
}

/** Re-run the build for an existing service spec. */
export function rebuild(specId: string) {
  const spec = S().services.find((s) => s.id === specId)
  if (!spec) return
  set({ draft: { ...spec, status: "draft", files: [], tests: [] } })
  return build()
}

/** Ask the AI about a failed build, with the real failure output as context. */
export function askAboutFailure(specId: string) {
  const b = S().build
  if (!b || b.specId !== specId) return
  const failed = b.steps.find((st) => b.runs[st.id]?.status === "failed")
  const run = failed ? b.runs[failed.id] : undefined
  const tail = run?.logs.filter((l) => !/^(⏳|↻)/.test(l)).slice(-40).join("\n") ?? ""
  const ref: KivoRef = { kind: "step", id: failed?.id ?? "build", label: failed ? `${failed.title} failed` : "Build", detail: `${run?.note ?? ""}\n\n${tail}` }
  S().select(ref, "ai")
  return ask(`Why did "${failed?.title ?? "the build"}" fail, and what's the smallest fix?`, ref)
}

/** Re-check every provider live, or switch the active one; keeps the top-bar status truthful. */
export async function refreshProviders() {
  const d = await api.providers()
  set((s) => ({ ai: s.ai ? { ...s.ai, ...d, ai: d.providers.some((p) => p.status === "ok" || p.status === "unknown") } : s.ai }))
}

export async function switchProvider(id: string) {
  try {
    const d = await api.setProvider(id)
    set((s) => ({ ai: s.ai ? { ...s.ai, ...d } : s.ai }))
    const p = d.providers.find((x) => x.id === id)
    toast.success(`Using ${p?.label} · ${d.model}`)
  } catch (err) {
    toast.error("Couldn't switch provider", { description: String((err as Error).message) })
  }
}
