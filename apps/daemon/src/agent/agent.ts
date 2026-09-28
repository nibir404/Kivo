import { execFile, spawn } from "node:child_process"
import fs from "node:fs"
import type http from "node:http"
import os from "node:os"
import path from "node:path"
import { aiAvailable, CompletionRateLimited, quickComplete } from "@kivo/ai/client"
import {
  cleanCompletion,
  COMPLETE_SYSTEM,
  completionPrompt,
  LIMITS,
  readRange,
  runAgentIn,
  searchResult,
  ToolError,
  waitDecision,
  type AgentEvent,
  type AgentWorkspace,
  type Args,
  type Decision,
  type ExecResult,
  type ModelFn,
  type Pending,
  type RunOptions,
} from "@kivo/ai/agent"
import { HttpError, json, readJson, requireString, sse } from "../http/http"
import { cleanEnv } from "../build/pipeline"
import { listFiles, project, projectDir } from "../projects/workspace"

// The loop, tools and completion helpers live in @kivo/ai (shared with the browser); re-exported for callers and tests.
export { applyEdits, cleanCompletion, compact, listTool, ToolError, validateEdits, validateTodos } from "@kivo/ai/agent"
export type { AgentEvent, Decision, ModelFn, Pending } from "@kivo/ai/agent"

/**
 * The daemon side of Kivo's coding agent: the real filesystem (confined to the project, no
 * symlinks out, no .git writes), git grep, a sandboxed shell for approved commands, and the HTTP
 * routes. The loop itself is `runAgentIn` from @kivo/ai.
 */

// ─── Paths ────────────────────────────────────────────────────────────────────

/** Resolve a model-supplied, project-relative path. Throws on anything that leaves the project. */
export function resolveIn(root: string, rel: unknown, { write = false } = {}): string {
  if (typeof rel !== "string" || !rel.trim()) throw new ToolError("path must be a non-empty string")
  if (rel.includes("\0")) throw new ToolError("path contains a NUL byte")
  const base = path.resolve(root)
  // Absolute paths are accepted only when they point inside the project.
  const abs = path.resolve(base, rel.trim())
  const inside = (p: string) => p === base || p.startsWith(base + path.sep)
  if (!inside(abs)) throw new ToolError("Path outside workspace")
  // A symlink inside the project could point anywhere: check the real location of the deepest existing ancestor.
  let probe = abs
  while (!fs.existsSync(probe) && probe !== base) probe = path.dirname(probe)
  const realBase = fs.realpathSync(base)
  const real = fs.realpathSync(probe)
  if (real !== realBase && !real.startsWith(realBase + path.sep)) throw new ToolError("Path outside workspace")
  const relPath = path.relative(base, abs)
  if (write && relPath.split(path.sep).includes(".git")) throw new ToolError("Refusing to write inside .git")
  return abs
}

const relOf = (root: string, abs: string) => path.relative(root, abs).split(path.sep).join("/") || "."

// ─── Tools over the real filesystem ──────────────────────────────────────────

function readText(abs: string) {
  const st = fs.statSync(abs, { throwIfNoEntry: false })
  if (!st) throw new ToolError("file not found")
  if (st.isDirectory()) throw new ToolError("that is a folder — use list_files")
  if (st.size > 2 * 1024 * 1024) throw new ToolError("file too large (2 MB max)")
  const buf = fs.readFileSync(abs)
  if (buf.subarray(0, 8192).includes(0)) throw new ToolError("binary file")
  return buf.toString("utf8")
}

export function readTool(root: string, a: Args) {
  const abs = resolveIn(root, a.path)
  return readRange(relOf(root, abs), readText(abs), a)
}

export async function searchTool(root: string, a: Args, files: () => string[]) {
  const query = typeof a.query === "string" && a.query.trim() ? a.query.slice(0, 500) : ""
  if (!query) throw new ToolError('"query" is required')
  const regex = a.regex === true || a.regex === "true"
  const cs = a.case_sensitive === true || a.case_sensitive === "true"
  const scope = a.path ? relOf(root, resolveIn(root, a.path)) : undefined
  let lines: string[] = []
  let note = ""
  if (fs.existsSync(path.join(root, ".git"))) {
    // Arguments, not a shell string; -e and "--" keep the query and path from being read as options.
    const args = ["--literal-pathspecs", "-C", root, "grep", "-n", "-I", "--untracked", "--no-color", "--max-count=20", cs ? "" : "-i", regex ? "-E" : "-F", "-e", query, "--", ...(scope && scope !== "." ? [scope] : [])].filter(Boolean)
    lines = await new Promise<string[]>((resolve, reject) =>
      execFile("git", args, { maxBuffer: 8 * 1024 * 1024, timeout: 15_000 }, (err, stdout, stderr) => {
        if (err && (err as { code?: unknown }).code !== 1) return reject(new ToolError(`search failed: ${(stderr || err.message).split("\n")[0]}`))
        resolve(stdout.split("\n").filter(Boolean))
      }),
    )
  } else {
    // No git: a bounded literal scan (a model-supplied regex could backtrack for ever in-process).
    if (regex) note = "(regex needs a git repository — searched for the literal text instead)\n"
    const q = cs ? query : query.toLowerCase()
    const deadline = Date.now() + 5000
    for (const f of files()) {
      if (lines.length >= LIMITS.searchMatches * 2 || Date.now() > deadline) break
      if (scope && scope !== "." && f !== scope && !f.startsWith(`${scope}/`)) continue
      let text: string
      try {
        text = readText(path.join(root, f))
      } catch {
        continue
      }
      text.split("\n").forEach((l, i) => {
        if ((cs ? l : l.toLowerCase()).includes(q)) lines.push(`${f}:${i + 1}:${l}`)
      })
    }
  }
  return { lines, note, ...searchResult(lines, note) }
}

// ─── Commands ─────────────────────────────────────────────────────────────────

const liveGroups = new Set<number>()

function killGroup(pid: number, sig: NodeJS.Signals) {
  try {
    process.kill(-pid, sig)
  } catch {
    // already gone
  }
}

// A daemon restart must not leave approved commands running unattended.
process.on("exit", () => liveGroups.forEach((pid) => killGroup(pid, "SIGKILL")))

/** Runs an approved command: /bin/sh -c in its own process group, no stdin, Kivo's secrets stripped, time- and size-capped. */
export const execCommand: ExecFn = (command, cwd, { signal, onOutput, register }) =>
  new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], { cwd, env: cleanEnv(), detached: true, stdio: ["ignore", "pipe", "pipe"] })
    let output = ""
    let bytes = 0
    let timedOut = false
    let killed = false
    const pid = child.pid
    if (pid) liveGroups.add(pid)
    const stop = (why: "timeout" | "kill") => {
      if (!pid || child.exitCode !== null) return
      if (why === "timeout") timedOut = true
      else killed = true
      killGroup(pid, "SIGTERM")
      setTimeout(() => child.exitCode === null && killGroup(pid, "SIGKILL"), 2000).unref()
    }
    register(() => stop("kill"))
    const timer = setTimeout(() => stop("timeout"), LIMITS.commandMs)
    const onAbort = () => stop("kill")
    signal.addEventListener("abort", onAbort, { once: true })
    const take = (b: Buffer) => {
      bytes += b.length
      if (bytes > LIMITS.commandBytes) {
        if (!output.endsWith("[output truncated]\n")) {
          output += "\n[output truncated]\n"
          onOutput("\n[output truncated]\n")
        }
        return
      }
      const s = b.toString()
      output += s
      onOutput(s)
    }
    child.stdout.on("data", take)
    child.stderr.on("data", take)
    const finish = (code: number | null) => {
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      if (pid) liveGroups.delete(pid)
      resolve({ code, timedOut, killed, output })
    }
    child.on("error", (err) => {
      output += `\n${err.message}\n`
      finish(null)
    })
    child.on("close", (code) => finish(code))
  })


// ─── The workspace and the run ────────────────────────────────────────────────

/** A shell runner for an approved command; `cwd` is absolute. */
export type ExecFn = (command: string, cwd: string, opts: { signal: AbortSignal; onOutput: (s: string) => void; register: (kill: () => void) => void }) => Promise<ExecResult>

/** The project on disk as an agent workspace. */
export function nodeWorkspace(root: string, opts: { name?: string; files?: () => string[]; exec?: ExecFn } = {}): AgentWorkspace {
  const abs = (rel: string) => (rel === "." ? root : path.join(root, rel))
  const files = opts.files ?? listFiles
  const exec = opts.exec ?? execCommand
  return {
    name: opts.name ?? path.basename(root),
    where: `at ${root} (${os.type()} ${os.release()}, shell /bin/sh)`,
    files,
    resolve: (p, o) => relOf(root, resolveIn(root, p, o)),
    exists: (rel) => fs.existsSync(abs(rel)),
    isDir: (rel) => fs.statSync(abs(rel), { throwIfNoEntry: false })?.isDirectory() ?? false,
    read: (rel) => readText(abs(rel)),
    write: (rel, content) => {
      fs.mkdirSync(path.dirname(abs(rel)), { recursive: true })
      fs.writeFileSync(abs(rel), content)
    },
    search: async (q) => {
      const r = await searchTool(root, { query: q.query, regex: q.regex, case_sensitive: q.caseSensitive, path: q.scope }, files)
      return { lines: r.lines, note: r.note }
    },
    exec: (command, cwd, o) => exec(command, abs(cwd), o),
  }
}

export interface AgentDeps extends RunOptions {
  root: string
  exec?: ExecFn
  listFiles?: () => string[]
  projectName?: string
}

/** Runs the agent in a project folder. Returns the final assistant text. */
export function runAgent(task: string, history: { role: "user" | "assistant"; content: string }[], deps: AgentDeps): Promise<string> {
  const ws = nodeWorkspace(deps.root, { name: deps.projectName, files: deps.listFiles, exec: deps.exec })
  return runAgentIn(ws, task, history, deps)
}

// ─── Runs (HTTP) ──────────────────────────────────────────────────────────────

interface Run {
  id: string
  ac: AbortController
  pending: Map<string, (d: Decision) => void>
  kills: Map<string, () => void>
}

const runs = new Map<string, Run>()

// ─── HTTP ─────────────────────────────────────────────────────────────────────

const RUN_PATH = /^\/api\/agent\/([\w-]{8,64})\/(respond|stop|kill)$/

/** Handles this feature's /api routes. Returns false for anything it doesn't own. */
export async function handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname === "/api/ai/complete" && req.method === "POST") {
    if (!aiAvailable()) return json(res, 503, { error: "No AI provider is available" }), true
    const b = await readJson(req)
    const prefix = typeof b.prefix === "string" ? b.prefix.slice(-1500) : ""
    const suffix = typeof b.suffix === "string" ? b.suffix.slice(0, 500) : ""
    const file = typeof b.path === "string" ? b.path.slice(0, 300) : "untitled"
    const language = typeof b.language === "string" ? b.language.slice(0, 40) : ""
    if (!prefix.trim()) return json(res, 200, { completion: "" }), true
    const ac = new AbortController()
    res.on("close", () => !res.writableFinished && ac.abort())
    try {
      const r = await quickComplete(
        [
          { role: "system", content: COMPLETE_SYSTEM },
          { role: "user", content: completionPrompt(file, language, prefix, suffix) },
        ],
        { signal: ac.signal, maxTokens: 512 },
      )
      json(res, 200, { completion: cleanCompletion(r.text, prefix, suffix), model: r.model })
    } catch (err) {
      if (err instanceof CompletionRateLimited) json(res, 429, { error: "rate limited", retryAfterMs: err.waitMs })
      else if (ac.signal.aborted) res.destroy()
      else json(res, 502, { error: (err as Error).message })
    }
    return true
  }

  if (url.pathname === "/api/agent/run" && req.method === "POST") {
    if (!aiAvailable()) return json(res, 503, { error: "No AI provider is available — configure one in .env (see .env.example)" }), true
    const b = await readJson(req)
    const task = requireString(b.task, "task", 60_000)
    const history = (Array.isArray(b.history) ? b.history : [])
      .filter((m: { role?: unknown; content?: unknown }) => (m?.role === "user" || m?.role === "assistant") && typeof m.content === "string")
      .map((m: { role: "user" | "assistant"; content: string }) => ({ role: m.role, content: m.content }))
    const allow = new Set<string>((Array.isArray(b.allow) ? b.allow : []).filter((c: unknown): c is string => typeof c === "string").slice(0, 200))
    const root = projectDir()
    const run: Run = { id: crypto.randomUUID(), ac: new AbortController(), pending: new Map(), kills: new Map() }
    runs.set(run.id, run)
    res.on("close", () => run.ac.abort())
    const send = sse(res)
    const ping = setInterval(() => !res.writableEnded && res.write(": ping\n\n"), 15_000)
    const deps: AgentDeps = {
      root,
      emit: (e) => send(e),
      decide: (p) => waitDecision(run.ac.signal, run.pending, p),
      signal: run.ac.signal,
      autoApply: b.autoApply === true,
      allow,
      kills: run.kills,
      projectName: project().name,
      checkRoot: () => {
        if (projectDir() !== root) throw new ToolError("The project was switched while the agent was running — start a new run.")
      },
    }
    send({ t: "start", runId: run.id, project: project().name } satisfies AgentEvent)
    try {
      await runAgent(task, history, deps)
    } catch (err) {
      if (!run.ac.signal.aborted) send({ t: "error", message: (err as Error).message })
      else send({ t: "done", reason: "stopped", text: "" } satisfies AgentEvent)
    } finally {
      clearInterval(ping)
      run.kills.forEach((k) => k())
      runs.delete(run.id)
      res.end()
    }
    return true
  }

  const m = url.pathname.match(RUN_PATH)
  if (m && req.method === "POST") {
    const run = runs.get(m[1])
    if (!run) throw new HttpError(404, "That agent run has finished")
    const b = await readJson(req)
    if (m[2] === "stop") {
      run.ac.abort()
      return json(res, 200, { ok: true }), true
    }
    const id = requireString(b.id, "id", 128)
    if (m[2] === "kill") {
      const kill = run.kills.get(id)
      if (!kill) throw new HttpError(404, "That command isn't running")
      kill()
      return json(res, 200, { ok: true }), true
    }
    const decision = b.decision
    if (decision !== "approve" && decision !== "deny" && decision !== "accept" && decision !== "reject") throw new HttpError(400, '"decision" must be approve, deny, accept or reject')
    const resolve = run.pending.get(id)
    if (!resolve) throw new HttpError(409, "Nothing is waiting for that answer (it may have timed out)")
    resolve({ decision, always: b.always === true, all: b.all === true })
    return json(res, 200, { ok: true }), true
  }

  return false
}
