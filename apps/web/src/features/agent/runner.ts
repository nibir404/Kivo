import { toast } from "sonner"
import { agentApi, type AgentEvent } from "@/lib/agent-api"
import { api } from "@/lib/api"
import { ask, refreshFiles } from "@/state/runners"
import { useKivo } from "@/state/store"
import { mentionContext, mentionLabel } from "./mentions"
import { useAgent, type AgentItem, type Mention } from "./store"

/** Connects the Agent UI to the daemon's agent loop (server/agent.ts) over SSE. */

const A = () => useAgent.getState()
const set = useAgent.setState
const uid = () => crypto.randomUUID()

let controller: AbortController | null = null

const push = (item: AgentItem) => set((s) => ({ items: [...s.items, item] }))
const notice = (text: string, tone: "info" | "error" = "info") => push({ kind: "notice", id: uid(), text, tone })

/** An accepted edit landed on disk: refresh the tree, and reload the file if it's open and has no unsaved edits. */
async function syncFile(path: string) {
  refreshFiles().catch(() => {})
  const f = useKivo.getState().fileCache[path]
  if (!f) return
  if (f.content !== f.saved) {
    toast.warning(`${path} was changed by the agent`, { description: "Your unsaved edits in the editor were kept; save or reload to reconcile." })
    return
  }
  try {
    const { content } = await api.read(path)
    useKivo.setState((s) => (s.fileCache[path] && s.fileCache[path].content === s.fileCache[path].saved ? { fileCache: { ...s.fileCache, [path]: { content, saved: content } } } : {}))
  } catch {
    // deleted or unreadable since; the tree refresh shows the truth
  }
}

/** Ask mode with @-mentions: the existing grounded `ask`, with the attached files as hidden extra context. */
export async function askWithMentions(text: string, mentions: Mention[]) {
  const extra = await mentionContext(mentions)
  const shown = mentions.length ? `${mentions.map((m) => `@${m.kind === "file" ? m.path : m.kind}`).join(" ")} ${text}` : text
  return ask(shown, useKivo.getState().selection, extra || undefined)
}

export async function runAgent(text: string, mentions: Mention[]) {
  if (A().running) return
  const k = useKivo.getState()
  if (!k.daemon || !k.ai?.ai) {
    notice("Agent mode needs the Kivo daemon and an AI provider — check the status in the top bar.", "error")
    return
  }
  set({ running: true, waiting: null })
  push({ kind: "user", id: uid(), text, mentions: mentions.map(mentionLabel) })
  let context = ""
  try {
    context = await mentionContext(mentions)
  } catch {
    // attachments are best-effort
  }
  const task = context ? `${text}\n\n${context}` : text
  const ac = new AbortController()
  controller = ac

  // Deltas arrive per token; buffer them and flush a few times a second.
  let assistantId: string | null = null
  let textBuf = ""
  let reasonBuf = ""
  const flush = () => {
    if (!assistantId || (!textBuf && !reasonBuf)) return
    const id = assistantId
    const t = textBuf
    const r = reasonBuf
    textBuf = ""
    reasonBuf = ""
    set((s) => ({ items: s.items.map((i) => (i.kind === "assistant" && i.id === id ? { ...i, text: i.text + t, reasoning: i.reasoning + r } : i)) }))
  }
  const closeAssistant = () => {
    flush()
    if (!assistantId) return
    const id = assistantId
    assistantId = null
    set((s) => ({ items: s.items.filter((i) => !(i.kind === "assistant" && i.id === id && !i.text.trim() && !i.reasoning.trim())).map((i) => (i.kind === "assistant" && i.id === id ? { ...i, streaming: false } : i)) }))
  }
  const timer = setInterval(flush, 80)
  let final = ""
  let finished = false

  const onEvent = (e: AgentEvent) => {
    switch (e.t) {
      case "start":
        set({ runId: e.runId })
        break
      case "step":
        closeAssistant()
        break
      case "delta":
        if (!assistantId) {
          assistantId = uid()
          push({ kind: "assistant", id: assistantId, text: "", reasoning: "", streaming: true })
        }
        if (e.channel === "content") textBuf += e.text
        else reasonBuf += e.text
        if (A().waiting) set({ waiting: null })
        break
      case "tool":
        closeAssistant()
        set({ waiting: null })
        push({ kind: "tool", id: e.id, name: e.name, summary: e.summary, status: "running" })
        break
      case "tool-done":
        A().patchTool(e.id, () => ({ status: e.ok ? "done" : "error", result: e.summary, detail: e.detail }))
        break
      case "edit":
        A().patchTool(e.id, () => ({ edit: { path: e.path, original: e.original, proposed: e.proposed, isNew: e.isNew, status: "pending" } }))
        break
      case "edit-result":
        A().patchTool(e.id, (t) => ({
          status: e.status === "error" ? "error" : "done",
          result: e.status === "applied" ? (t.edit?.isNew ? "created" : "applied") : e.status === "rejected" ? "rejected" : (e.message ?? "failed"),
          edit: t.edit && { ...t.edit, status: e.status, message: e.message, busy: false },
        }))
        if (e.status === "applied") syncFile(e.path)
        break
      case "approval":
        A().patchTool(e.id, () => ({ command: { command: e.command, cwd: e.cwd, auto: e.auto, status: e.auto ? "running" : "pending", output: "" } }))
        break
      case "cmd-start":
        A().patchTool(e.id, (t) => ({ command: t.command && { ...t.command, status: "running", busy: false } }))
        break
      case "cmd-output":
        // Keep the tail; the model gets its own capped copy on the daemon.
        A().patchTool(e.id, (t) => ({ command: t.command && { ...t.command, output: (t.command.output + e.text).slice(-20_000) } }))
        break
      case "cmd-exit":
        A().patchTool(e.id, (t) => ({
          status: e.code === 0 ? "done" : "error",
          result: e.timedOut ? "timed out" : e.killed ? "stopped" : `exit ${e.code}`,
          command: t.command && { ...t.command, status: e.timedOut ? "timeout" : e.killed ? "killed" : "done", code: e.code, busy: false },
        }))
        break
      case "cmd-denied":
        A().patchTool(e.id, (t) => ({ status: "error", result: "denied", command: t.command && { ...t.command, status: "denied", busy: false } }))
        break
      case "todos":
        set({ todos: e.todos })
        break
      case "wait":
        set({ waiting: e.waitMs > 0 ? `Rate limited — retrying ${e.model.split("/").pop()} in ${Math.ceil(e.waitMs / 1000)}s` : `Switching to ${e.model.split("/").pop()}` })
        break
      case "usage":
        set({ tokens: e.tokens, model: e.model })
        break
      case "done":
        closeAssistant()
        finished = true
        final = e.text
        if (e.reason === "iterations" || e.reason === "tokens") notice(e.text.split("\n").pop()!.replace(/_/g, ""))
        if (e.reason === "stopped") notice("Stopped.")
        // A final answer that wasn't streamed as deltas (e.g. a non-streaming gateway) still gets shown.
        if (e.reason === "final" && e.text && !A().items.some((i) => i.kind === "assistant" && i.text.trim() === e.text.trim()))
          push({ kind: "assistant", id: uid(), text: e.text, reasoning: "", streaming: false })
        break
    }
  }

  try {
    await agentApi.run({ task, history: A().transcript.slice(-8), autoApply: A().autoApply, allow: A().allow }, onEvent, ac.signal)
    if (!finished && !ac.signal.aborted) notice("The connection to the daemon closed before the agent finished.", "error")
  } catch (err) {
    if (ac.signal.aborted) notice("Stopped.")
    else notice(String((err as Error).message), "error")
  } finally {
    clearInterval(timer)
    closeAssistant()
    controller = null
    const mentionNote = mentions.length ? ` (attached: ${mentions.map(mentionLabel).join(", ")})` : ""
    set((s) => ({
      running: false,
      runId: null,
      waiting: null,
      transcript: [...s.transcript, { role: "user" as const, content: text + mentionNote }, ...(final ? [{ role: "assistant" as const, content: final }] : [])].slice(-12),
      // Nothing can answer these any more: the run that asked is gone.
      items: s.items.map((i) =>
        i.kind === "tool"
          ? {
              ...i,
              status: i.status === "running" ? "error" : i.status,
              edit: i.edit?.status === "pending" ? { ...i.edit, status: "expired", busy: false } : i.edit,
              command: i.command && (i.command.status === "pending" || i.command.status === "running") ? { ...i.command, status: "expired", busy: false } : i.command,
            }
          : i.kind === "assistant"
            ? { ...i, streaming: false }
            : i,
      ),
    }))
  }
}

export function stopAgent() {
  const runId = A().runId
  if (runId) agentApi.stop(runId).catch(() => {})
  controller?.abort()
}

export function clearAgent() {
  if (A().running) stopAgent()
  set({ items: [], todos: [], transcript: [], tokens: 0, waiting: null })
}

async function respond(id: string, body: { decision: "approve" | "deny" | "accept" | "reject"; always?: boolean; all?: boolean }) {
  const runId = A().runId
  if (!runId) return
  try {
    await agentApi.respond(runId, { id, ...body })
  } catch (err) {
    toast.error("The agent didn't take that answer", { description: String((err as Error).message) })
    A().patchTool(id, (t) => ({ edit: t.edit && { ...t.edit, busy: false }, command: t.command && { ...t.command, busy: false } }))
  }
}

export function decideEdit(id: string, accept: boolean, all = false) {
  A().patchTool(id, (t) => ({ edit: t.edit && { ...t.edit, busy: true } }))
  return respond(id, { decision: accept ? "accept" : "reject", all })
}

export function decideCommand(id: string, approve: boolean, always = false) {
  A().patchTool(id, (t) => ({ command: t.command && { ...t.command, busy: true } }))
  if (approve && always) {
    const cmd = A().items.find((i) => i.kind === "tool" && i.id === id)
    const text = cmd?.kind === "tool" ? cmd.command?.command : undefined
    if (text) set((s) => ({ allow: [...new Set([...s.allow, text])] }))
  }
  return respond(id, { decision: approve ? "approve" : "deny", always })
}

export function killCommand(id: string) {
  const runId = A().runId
  if (runId) agentApi.kill(runId, id).catch((err) => toast.error("Couldn't stop the command", { description: String(err.message) }))
}
