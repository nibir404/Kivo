/** Client for the daemon's agent (/api/agent/*) and autocomplete (/api/ai/complete) routes. */
import { sse } from "@/lib/api"
import { apiFetch } from "@/lib/transport"

export interface Todo {
  content: string
  status: "pending" | "in_progress" | "completed"
}

/** Mirrors `AgentEvent` in server/agent.ts. */
export type AgentEvent =
  | { t: "start"; runId: string; project: string }
  | { t: "step"; n: number }
  | { t: "delta"; channel: "reasoning" | "content"; text: string }
  | { t: "tool"; id: string; name: string; summary: string }
  | { t: "tool-done"; id: string; ok: boolean; summary: string; detail?: string }
  | { t: "edit"; id: string; path: string; original: string; proposed: string; isNew: boolean }
  | { t: "edit-result"; id: string; path: string; status: "applied" | "rejected" | "error"; message?: string }
  | { t: "approval"; id: string; command: string; cwd: string; auto: boolean }
  | { t: "cmd-start"; id: string }
  | { t: "cmd-output"; id: string; text: string }
  | { t: "cmd-exit"; id: string; code: number | null; timedOut: boolean; killed: boolean }
  | { t: "cmd-denied"; id: string; reason: string }
  | { t: "todos"; todos: Todo[] }
  | { t: "wait"; waitMs: number; model: string }
  | { t: "usage"; tokens: number; model: string }
  | { t: "done"; reason: "final" | "iterations" | "tokens" | "stopped" | "timeout"; text: string }

export interface RunBody {
  task: string
  history: { role: "user" | "assistant"; content: string }[]
  autoApply: boolean
  allow: string[]
}

async function post(url: string, body: unknown) {
  const res = await apiFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`)
}

export const agentApi = {
  run: (body: RunBody, onEvent: (e: AgentEvent) => void, signal: AbortSignal) => sse<AgentEvent>("/api/agent/run", body, onEvent, signal),
  respond: (runId: string, body: { id: string; decision: "approve" | "deny" | "accept" | "reject"; always?: boolean; all?: boolean }) => post(`/api/agent/${runId}/respond`, body),
  stop: (runId: string) => post(`/api/agent/${runId}/stop`, {}),
  kill: (runId: string, id: string) => post(`/api/agent/${runId}/kill`, { id }),
}

export type CompleteResult = { ok: true; completion: string } | { ok: false; retryAfterMs: number }

/** One autocomplete request. A 429/503 comes back as a back-off hint rather than an exception. */
export async function requestCompletion(body: { path: string; language: string; prefix: string; suffix: string }, signal: AbortSignal): Promise<CompleteResult> {
  const res = await apiFetch("/api/ai/complete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal })
  const data = await res.json().catch(() => ({}))
  if (res.ok) return { ok: true, completion: typeof data.completion === "string" ? data.completion : "" }
  return { ok: false, retryAfterMs: Number(data.retryAfterMs) || 0 }
}
