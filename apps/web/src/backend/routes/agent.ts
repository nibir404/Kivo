import { runAgentIn, ToolError, waitDecision, type AgentEvent, type AgentWorkspace, type Decision } from "@kivo/ai/agent"
import { aiAvailable } from "@kivo/ai/client"
import { buildMatcher, matchLine, splitLines } from "@kivo/core/match"
import { bus } from "../bus"
import { cleanPath, type ProjectFS } from "../fs/types"
import { HttpError, json, readJson, requireString, sse } from "../http"
import { activeFS, currentFS, currentProject } from "../projects"
import { providerStatus } from "../settings"
import type { Route } from "./types"

/**
 * The coding agent in the browser: the shared loop (@kivo/ai/agent) over the current project's
 * files. There's no shell, so run_command isn't offered; every edit still waits for the user.
 */

function workspace(fs: ProjectFS, name: string, onWrite: (rel: string) => void): AgentWorkspace {
  const resolve = (p: unknown, o?: { write?: boolean }) => {
    try {
      return cleanPath(p, { write: o?.write, allowRoot: true })
    } catch (err) {
      throw new ToolError((err as Error).message)
    }
  }
  const read = async (rel: string) => {
    const kind = await fs.stat(rel)
    if (!kind) throw new ToolError("file not found")
    if (kind === "dir") throw new ToolError("that is a folder — use list_files")
    try {
      return await fs.read(rel)
    } catch (err) {
      throw new ToolError((err as Error).message)
    }
  }
  return {
    name,
    where: "(opened in Kivo in the browser; there is no shell)",
    files: () => fs.list(),
    resolve,
    exists: async (rel) => (await fs.stat(rel)) !== null,
    isDir: async (rel) => rel === "." || (await fs.stat(rel)) === "dir",
    read,
    write: async (rel, content) => {
      await fs.write(rel, content)
      onWrite(rel)
    },
    search: async ({ query, regex, caseSensitive, scope }) => {
      let re: RegExp
      try {
        re = buildMatcher({ query, regex, caseSensitive })
      } catch (err) {
        throw new ToolError((err as Error).message)
      }
      const lines: string[] = []
      const deadline = Date.now() + 5000
      for (const f of await fs.list()) {
        if (lines.length >= 120 || Date.now() > deadline) break
        if (scope && f !== scope && !f.startsWith(`${scope}/`)) continue
        const text = await fs.read(f).catch(() => null)
        if (text === null) continue
        splitLines(text).forEach((l, i) => {
          // Very long lines are skipped for regex searches, so a model-written pattern can't stall the tab.
          if (regex && l.text.length > 2000) return
          if (matchLine(re, l.text, i + 1, 1).length) lines.push(`${f}:${i + 1}:${l.text}`)
        })
      }
      return { lines }
    },
  }
}

interface Run {
  ac: AbortController
  pending: Map<string, (d: Decision) => void>
}

const runs = new Map<string, Run>()
const RUN_PATH = /^\/api\/agent\/([\w-]{8,64})\/(respond|stop|kill)$/

async function run(req: Request) {
  await providerStatus()
  if (!aiAvailable()) throw new HttpError(503, "Add your Groq API key in Preferences → AI to use the agent in the browser.")
  const b = await readJson(req)
  const task = requireString(b.task, "task", 60_000)
  const history = (Array.isArray(b.history) ? b.history : [])
    .filter((m: { role?: unknown; content?: unknown }) => (m?.role === "user" || m?.role === "assistant") && typeof m.content === "string")
    .map((m: { role: "user" | "assistant"; content: string }) => ({ role: m.role, content: m.content }))
  const project = await currentProject()
  const fs = await currentFS()
  const id = crypto.randomUUID()
  const r: Run = { ac: new AbortController(), pending: new Map() }
  runs.set(id, r)
  const ws = workspace(fs, project.name, (rel) => bus.emit({ t: "fs", project: project.id, paths: [rel] }))
  return sse(req, async (send, signal) => {
    signal.addEventListener("abort", () => r.ac.abort(), { once: true })
    send({ t: "start", runId: id, project: project.name } satisfies AgentEvent)
    try {
      await runAgentIn(ws, task, history, {
        emit: send,
        decide: (p) => waitDecision(r.ac.signal, r.pending, p),
        signal: r.ac.signal,
        autoApply: b.autoApply === true,
        checkRoot: () => {
          if (activeFS() !== fs) throw new ToolError("The project was switched while the agent was running — start a new run.")
        },
      })
    } catch (err) {
      if (r.ac.signal.aborted) send({ t: "done", reason: "stopped", text: "" } satisfies AgentEvent)
      else throw err
    } finally {
      runs.delete(id)
    }
  })
}

export const agentRoutes: Route[] = [
  ["POST", "/api/agent/run", run],
]

/** /api/agent/:id/(respond|stop|kill) */
export async function agentControl(req: Request, url: URL): Promise<Response | null> {
  const m = url.pathname.match(RUN_PATH)
  if (!m || req.method !== "POST") return null
  const r = runs.get(m[1])
  if (!r) throw new HttpError(404, "That agent run has finished")
  const b = await readJson(req)
  if (m[2] === "stop") {
    r.ac.abort()
    return json(200, { ok: true })
  }
  if (m[2] === "kill") throw new HttpError(404, "That command isn't running")
  const id = requireString(b.id, "id", 128)
  const decision = b.decision
  if (decision !== "approve" && decision !== "deny" && decision !== "accept" && decision !== "reject") throw new HttpError(400, '"decision" must be approve, deny, accept or reject')
  const resolve = r.pending.get(id)
  if (!resolve) throw new HttpError(409, "Nothing is waiting for that answer (it may have timed out)")
  resolve({ decision, always: b.always === true, all: b.all === true })
  return json(200, { ok: true })
}
