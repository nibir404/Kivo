import { execFile, spawn } from "node:child_process"
import fs from "node:fs"
import type http from "node:http"
import os from "node:os"
import path from "node:path"
import { aiAvailable, chatWithTools, CompletionRateLimited, estimateChars, ProviderError, quickComplete, tokenBudget, type ChatMsg, type Delta, type ToolCall, type ToolDef, type ToolTurn } from "./ai"
import { HttpError, json, readJson, requireString, sse } from "./http"
import { applyEdit, cleanEnv } from "./pipeline"
import { listFiles, project, projectDir } from "./workspace"

/**
 * Kivo's coding agent and editor autocomplete.
 *
 * The agent is a tool-calling loop on the daemon: the model reads, searches and proposes edits;
 * the user approves every command and (by default) every edit. Model output is untrusted: every
 * path goes through `resolveIn` (no escaping the project, no symlinks out, no .git), commands only
 * run after an explicit approval for that exact string, and the loop is capped in iterations,
 * tokens and wall-clock time. Stop aborts the model request, any pending approval and any command.
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

export class ToolError extends Error {}

const relOf = (root: string, abs: string) => path.relative(root, abs).split(path.sep).join("/") || "."

// ─── Tool schemas (kept terse: they're sent with every request against a small token budget) ──

const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ToolDef => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } },
})

export const TOOLS: ToolDef[] = [
  fn("list_files", "List project files. pattern: substring or glob (e.g. src/**/*.ts).", { pattern: { type: "string" }, limit: { type: "integer" } }),
  fn("read_file", "Read a text file (optionally a 1-based line range).", { path: { type: "string" }, start_line: { type: "integer" }, end_line: { type: "integer" } }, ["path"]),
  fn("search", "Search file contents. Returns path:line: text.", { query: { type: "string" }, regex: { type: "boolean" }, path: { type: "string", description: "limit to a file or folder" }, case_sensitive: { type: "boolean" } }, ["query"]),
  fn(
    "edit_file",
    "Edit a file with exact search/replace blocks copied from read_file output (each search must match once), or replace/create it with full `content`. The user reviews the diff.",
    {
      path: { type: "string" },
      edits: { type: "array", items: { type: "object", properties: { search: { type: "string" }, replace: { type: "string" } }, required: ["search", "replace"] } },
      content: { type: "string" },
    },
    ["path"],
  ),
  fn("create_file", "Create a new file. Fails if it exists (use edit_file).", { path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
  fn("run_command", "Run a shell command in the project (the user must approve it). Non-interactive, 120s timeout.", { command: { type: "string" }, cwd: { type: "string", description: "relative folder" } }, ["command"]),
  fn(
    "todo_write",
    "Replace your visible task list.",
    { todos: { type: "array", items: { type: "object", properties: { content: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] } }, required: ["content", "status"] } } },
    ["todos"],
  ),
]

// ─── Events and decisions ─────────────────────────────────────────────────────

export interface Todo {
  content: string
  status: "pending" | "in_progress" | "completed"
}

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

export interface Decision {
  decision: "approve" | "deny" | "accept" | "reject"
  /** Approve: also allow this exact command for the rest of the session. */
  always?: boolean
  /** Accept: also auto-apply every later edit in this run. */
  all?: boolean
}

export type Pending = { kind: "command"; id: string; command: string; cwd: string } | { kind: "edit"; id: string; path: string }

export interface ExecResult {
  code: number | null
  timedOut: boolean
  killed: boolean
  output: string
}

export type ExecFn = (command: string, cwd: string, opts: { signal: AbortSignal; onOutput: (s: string) => void; register: (kill: () => void) => void }) => Promise<ExecResult>

export type ModelFn = (messages: ChatMsg[], tools: ToolDef[], opts: { signal: AbortSignal; onDelta: (d: Delta) => void; onWait: (waitMs: number, model: string) => void; maxTokens: number }) => Promise<ToolTurn>

export interface AgentDeps {
  root: string
  emit: (e: AgentEvent) => void
  /** Waits for the user's answer. Must reject (or resolve "deny"/"reject") on abort/timeout. */
  decide: (p: Pending) => Promise<Decision>
  signal: AbortSignal
  model?: ModelFn
  exec?: ExecFn
  listFiles?: () => string[]
  /** Throws if the project changed under the run (the daemon's current project is switched at runtime). */
  checkRoot?: () => void
  /** Kill switches for running commands, by tool-call id (the HTTP layer exposes them to the UI). */
  kills?: Map<string, () => void>
  autoApply?: boolean
  allow?: Set<string>
  maxIterations?: number
  maxTokens?: number
  projectName?: string
}

export const LIMITS = { iterations: 25, tokens: 200_000, readChars: 9000, readLines: 300, listMax: 300, searchMatches: 60, commandMs: 120_000, commandBytes: 400_000, resultChars: 6000, decisionMs: 10 * 60_000 }

// ─── Argument validation ──────────────────────────────────────────────────────

type Args = Record<string, unknown>

function parseArgs(raw: string): Args {
  let v: unknown
  try {
    v = JSON.parse(raw || "{}")
  } catch {
    throw new ToolError("arguments were not valid JSON — call the tool again with a JSON object")
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new ToolError("arguments must be a JSON object")
  return v as Args
}

const str = (a: Args, k: string, { required = false, max = 1_000_000 } = {}): string | undefined => {
  const v = a[k]
  if (v === undefined || v === null) {
    if (required) throw new ToolError(`"${k}" is required`)
    return undefined
  }
  if (typeof v !== "string") throw new ToolError(`"${k}" must be a string`)
  if (required && !v.trim()) throw new ToolError(`"${k}" must not be empty`)
  if (v.length > max) throw new ToolError(`"${k}" is too long (max ${max} characters)`)
  return v
}

const int = (a: Args, k: string): number | undefined => {
  const v = a[k]
  if (v === undefined || v === null) return undefined
  const n = typeof v === "string" ? Number(v) : v
  if (typeof n !== "number" || !Number.isFinite(n)) throw new ToolError(`"${k}" must be a number`)
  return Math.floor(n)
}

const bool = (a: Args, k: string) => a[k] === true || a[k] === "true"

export function validateTodos(v: unknown): Todo[] {
  if (!Array.isArray(v)) throw new ToolError('"todos" must be an array')
  if (v.length > 30) throw new ToolError("at most 30 todos")
  return v.map((t, i) => {
    const o = (t ?? {}) as Record<string, unknown>
    if (typeof o.content !== "string" || !o.content.trim()) throw new ToolError(`todos[${i}].content must be a non-empty string`)
    const status = o.status === "in_progress" || o.status === "completed" ? o.status : "pending"
    return { content: o.content.slice(0, 200), status }
  })
}

export function validateEdits(v: unknown): { search: string; replace: string }[] {
  if (!Array.isArray(v) || !v.length) throw new ToolError('"edits" must be a non-empty array of {search, replace}')
  if (v.length > 20) throw new ToolError("at most 20 edit blocks per call")
  return v.map((e, i) => {
    const o = (e ?? {}) as Record<string, unknown>
    if (typeof o.search !== "string" || !o.search) throw new ToolError(`edits[${i}].search must be a non-empty string`)
    if (typeof o.replace !== "string") throw new ToolError(`edits[${i}].replace must be a string`)
    return { search: o.search, replace: o.replace }
  })
}

// ─── Tools ────────────────────────────────────────────────────────────────────

function readText(abs: string) {
  const st = fs.statSync(abs, { throwIfNoEntry: false })
  if (!st) throw new ToolError("file not found")
  if (st.isDirectory()) throw new ToolError("that is a folder — use list_files")
  if (st.size > 2 * 1024 * 1024) throw new ToolError("file too large (2 MB max)")
  const buf = fs.readFileSync(abs)
  if (buf.subarray(0, 8192).includes(0)) throw new ToolError("binary file")
  return buf.toString("utf8")
}

export function globToRegExp(glob: string) {
  let re = ""
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*"
      i++
      if (glob[i + 1] === "/") i++
    } else if (c === "*") re += "[^/]*"
    else if (c === "?") re += "[^/]"
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(`^${re}$`, "i")
}

export function listTool(files: string[], a: Args) {
  const pattern = str(a, "pattern", { max: 300 })?.trim()
  const limit = Math.max(1, Math.min(int(a, "limit") ?? 200, LIMITS.listMax))
  let hits = files
  if (pattern && pattern !== "." && pattern !== "*" && pattern !== "**") {
    if (/[*?]/.test(pattern)) {
      const re = globToRegExp(pattern.replace(/^\.\//, ""))
      hits = files.filter((f) => re.test(f))
    } else {
      const q = pattern.replace(/^\.\//, "").toLowerCase()
      hits = files.filter((f) => f.toLowerCase().includes(q))
    }
  }
  const shown = hits.slice(0, limit)
  const more = hits.length - shown.length
  return { text: `${hits.length} file${hits.length === 1 ? "" : "s"}${pattern ? ` matching "${pattern}"` : ""}\n${shown.join("\n")}${more > 0 ? `\n… ${more} more (narrow the pattern)` : ""}`, summary: `${hits.length} files` }
}

export function readTool(root: string, a: Args) {
  const abs = resolveIn(root, a.path)
  const content = readText(abs)
  const lines = content.split("\n")
  const total = lines.length
  const start = Math.max(1, int(a, "start_line") ?? 1)
  let end = Math.min(total, int(a, "end_line") ?? start + LIMITS.readLines - 1, start + LIMITS.readLines - 1)
  if (end < start) end = start
  let body = lines.slice(start - 1, end).join("\n")
  if (body.length > LIMITS.readChars) {
    body = body.slice(0, LIMITS.readChars)
    end = start + body.split("\n").length - 2
    body = lines.slice(start - 1, Math.max(start, end)).join("\n")
    end = Math.max(start, end)
  }
  const rel = relOf(root, abs)
  const more = end < total ? `\n[… lines ${end + 1}-${total} not shown — call read_file with start_line=${end + 1}]` : ""
  return { text: `${rel} (lines ${start}-${end} of ${total})\n${body}${more}`, summary: `lines ${start}–${end} of ${total}` }
}

export async function searchTool(root: string, a: Args, files: () => string[]) {
  const query = str(a, "query", { required: true, max: 500 })!
  const regex = bool(a, "regex")
  const cs = bool(a, "case_sensitive")
  const scope = a.path ? relOf(root, resolveIn(root, a.path)) : undefined
  const clip = (l: string) => (l.length > 200 ? `${l.slice(0, 200)}…` : l)
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
  const shown = lines.slice(0, LIMITS.searchMatches).map(clip)
  const more = lines.length - shown.length
  return { text: `${note}${lines.length ? shown.join("\n") : "No matches."}${more > 0 ? `\n… ${more} more matches (narrow the query or path)` : ""}`, summary: `${lines.length}${more > 0 ? "+" : ""} match${lines.length === 1 ? "" : "es"}` }
}

/** Apply search/replace blocks. Each block must match exactly one place (exact first, then whitespace-tolerant). */
export function applyEdits(content: string, edits: { search: string; replace: string }[]): string {
  let out = content
  edits.forEach((e, i) => {
    const count = out.split(e.search).length - 1
    if (count > 1) throw new ToolError(`edit ${i + 1}: search text matches ${count} places — include more surrounding lines so it is unique`)
    const next = applyEdit(out, e.search, e.replace)
    if (next === null) throw new ToolError(`edit ${i + 1}: search text not found — read the file again and copy the exact lines`)
    out = next
  })
  return out
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

// ─── Context management ──────────────────────────────────────────────────────

const msgChars = (m: ChatMsg) => JSON.stringify(m).length

/**
 * Keep the conversation inside the provider's per-minute token budget: older tool results are cut
 * to a stub first (the model can always re-read), then older assistant text. The system prompt and
 * the newest messages are kept.
 */
export function compact(messages: ChatMsg[], budgetTokens: number): ChatMsg[] {
  const out = messages.map((m) => ({ ...m }))
  const total = () => estimateChars(out.reduce((a, m) => a + msgChars(m), 0))
  const stub = (s: string, keep: number) => (s.length > keep + 80 ? `${s.slice(0, keep)}\n[… trimmed to save context — re-run the tool if you need it]` : s)
  for (const keep of [400, 120]) {
    for (let i = 1; i < out.length - 2 && total() > budgetTokens; i++) {
      const m = out[i]
      if (m.role === "tool") out[i] = { ...m, content: stub(m.content, keep) }
      else if (m.role === "assistant" && m.content) out[i] = { ...m, content: stub(m.content, keep) }
      else if (m.role === "user" && i < out.length - 3) out[i] = { ...m, content: stub(m.content, keep * 3) }
    }
  }
  // Still too big: the latest results themselves are huge.
  for (let i = out.length - 1; i > 0 && total() > budgetTokens; i--) {
    const m = out[i]
    if (m.role === "tool" || m.role === "user") out[i] = { ...m, content: stub(m.content, 1500) }
  }
  return out
}

// ─── The loop ─────────────────────────────────────────────────────────────────

export function systemPrompt(name: string, root: string) {
  return [
    `You are Kivo's coding agent, working in the user's project "${name}" at ${root} (${os.type()} ${os.release()}, shell /bin/sh).`,
    "Tools: list_files, read_file, search, edit_file, create_file, run_command, todo_write. Paths are relative to the project root; nothing outside it is reachable.",
    "- Explore with list_files/search/read_file. Read a file before editing it.",
    "- Make minimal, targeted edits: edit_file with exact search/replace blocks copied from read_file (enough context to be unique). Don't rewrite whole files unless creating them.",
    "- Act by calling tools; don't ask permission in text. Kivo itself shows the user every edit as a diff and every command for approval. If one is rejected or denied, don't retry it — adjust or ask.",
    "- Use run_command for tests/builds/scripts, not for reading files. No interactive commands.",
    "- For multi-step work keep a short todo list with todo_write and update statuses as you go.",
    "- If the request is unclear or you're blocked, stop and ask in plain text.",
    "- Finish with a short summary of what you did. Be concise.",
  ].join("\n")
}

const defaultModel: ModelFn = (messages, tools, o) => chatWithTools(messages, tools, o.onDelta, { signal: o.signal, maxTokens: o.maxTokens, effort: "low", onRateLimit: (r) => o.onWait(r.waitMs, r.next) })

const clipResult = (s: string) => (s.length > LIMITS.resultChars ? `${s.slice(0, LIMITS.resultChars)}\n[… truncated]` : s)
const short = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** Runs the agent to completion. Returns the final assistant text. */
export async function runAgent(task: string, history: { role: "user" | "assistant"; content: string }[], deps: AgentDeps): Promise<string> {
  const { root, emit, signal } = deps
  const model = deps.model ?? defaultModel
  const exec = deps.exec ?? execCommand
  const files = deps.listFiles ?? listFiles
  const allow = deps.allow ?? new Set<string>()
  let autoApply = !!deps.autoApply
  const maxIter = deps.maxIterations ?? LIMITS.iterations
  const maxTokens = deps.maxTokens ?? LIMITS.tokens
  const messages: ChatMsg[] = [{ role: "system", content: systemPrompt(deps.projectName ?? path.basename(root), root) }, ...history.slice(-8).map((m) => ({ role: m.role, content: m.content.slice(0, 4000) })), { role: "user", content: task }]
  let used = 0
  let malformed = 0
  let last = ""
  const aborted = () => signal.aborted

  const runTool = async (call: ToolCall): Promise<string> => {
    const id = call.id
    let a: Args
    try {
      a = parseArgs(call.arguments)
    } catch (err) {
      emit({ t: "tool", id, name: call.name, summary: "invalid arguments" })
      emit({ t: "tool-done", id, ok: false, summary: (err as Error).message })
      return `Error: ${(err as Error).message}`
    }
    const p = typeof a.path === "string" ? a.path : ""
    const label: Record<string, string> = {
      list_files: typeof a.pattern === "string" ? a.pattern : "all files",
      read_file: `${p}${a.start_line ? ` :${a.start_line}${a.end_line ? `-${a.end_line}` : ""}` : ""}`,
      search: `"${short(String(a.query ?? ""), 50)}"${p ? ` in ${p}` : ""}`,
      edit_file: p,
      create_file: p,
      run_command: short(String(a.command ?? ""), 80),
      todo_write: `${Array.isArray(a.todos) ? a.todos.length : 0} items`,
    }
    if (!(call.name in label)) {
      emit({ t: "tool", id, name: call.name, summary: "unknown tool" })
      emit({ t: "tool-done", id, ok: false, summary: "unknown tool" })
      return `Error: unknown tool "${call.name}". Available: ${TOOLS.map((t) => t.function.name).join(", ")}`
    }
    emit({ t: "tool", id, name: call.name, summary: label[call.name] })
    try {
      deps.checkRoot?.()
      switch (call.name) {
        case "list_files": {
          const r = listTool(files(), a)
          emit({ t: "tool-done", id, ok: true, summary: r.summary })
          return r.text
        }
        case "read_file": {
          const r = readTool(root, a)
          emit({ t: "tool-done", id, ok: true, summary: r.summary })
          return r.text
        }
        case "search": {
          const r = await searchTool(root, a, files)
          emit({ t: "tool-done", id, ok: true, summary: r.summary, detail: r.text.slice(0, 3000) })
          return r.text
        }
        case "todo_write": {
          const todos = validateTodos(a.todos)
          emit({ t: "todos", todos })
          emit({ t: "tool-done", id, ok: true, summary: `${todos.filter((t) => t.status === "completed").length}/${todos.length} done` })
          return "Todo list updated."
        }
        case "edit_file":
        case "create_file":
          return await editTool(call.name, id, a)
        case "run_command":
          return await commandTool(id, a)
      }
    } catch (err) {
      if (aborted()) throw err
      const msg = err instanceof ToolError || (err as NodeJS.ErrnoException).code ? (err as Error).message : `unexpected failure: ${(err as Error).message}`
      emit({ t: "tool-done", id, ok: false, summary: msg })
      return `Error: ${msg}`
    }
    return "Error: not handled"
  }

  const editTool = async (name: "edit_file" | "create_file", id: string, a: Args): Promise<string> => {
    const abs = resolveIn(root, a.path, { write: true })
    const rel = relOf(root, abs)
    const exists = fs.existsSync(abs)
    const content = str(a, "content", { max: 400_000 })
    let original = ""
    let proposed: string
    if (name === "create_file") {
      if (exists) throw new ToolError(`${rel} already exists — use edit_file`)
      if (content === undefined) throw new ToolError('"content" is required')
      proposed = content
    } else if (content !== undefined && a.edits === undefined) {
      original = exists ? readText(abs) : ""
      proposed = content
    } else {
      if (!exists) throw new ToolError(`${rel} does not exist — use create_file (or pass "content")`)
      original = readText(abs)
      proposed = applyEdits(original, validateEdits(a.edits))
    }
    if (exists && proposed === original) {
      emit({ t: "tool-done", id, ok: true, summary: "no changes" })
      return "The edit makes no changes."
    }
    emit({ t: "edit", id, path: rel, original, proposed, isNew: !exists })
    const d = autoApply ? ({ decision: "accept" } as Decision) : await deps.decide({ kind: "edit", id, path: rel })
    if (d.all) autoApply = true
    if (d.decision !== "accept") {
      emit({ t: "edit-result", id, path: rel, status: "rejected" })
      return `The user rejected this edit to ${rel}; the file is unchanged. Don't repeat it — adjust your approach or ask the user.`
    }
    deps.checkRoot?.()
    // The user may have saved the file while the diff was on screen; re-apply onto what's there now.
    const now = fs.existsSync(abs) ? readText(abs) : ""
    let final = proposed
    if (now !== original) {
      if (name === "create_file" || (content !== undefined && a.edits === undefined)) {
        emit({ t: "edit-result", id, path: rel, status: "error", message: "The file changed on disk while this edit was waiting" })
        return `Error: ${rel} changed on disk before the edit was applied; read it again.`
      }
      try {
        final = applyEdits(now, validateEdits(a.edits))
      } catch {
        emit({ t: "edit-result", id, path: rel, status: "error", message: "The file changed on disk while this edit was waiting" })
        return `Error: ${rel} changed on disk before the edit was applied; read it again.`
      }
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, final)
    emit({ t: "edit-result", id, path: rel, status: "applied" })
    return `${exists ? "Edited" : "Created"} ${rel} (${final.split("\n").length} lines). The user accepted the change.`
  }

  const commandTool = async (id: string, a: Args): Promise<string> => {
    const command = str(a, "command", { required: true, max: 4000 })!.trim()
    const cwdAbs = a.cwd ? resolveIn(root, a.cwd) : root
    if (!fs.statSync(cwdAbs, { throwIfNoEntry: false })?.isDirectory()) throw new ToolError(`cwd ${relOf(root, cwdAbs)} is not a folder`)
    const cwd = relOf(root, cwdAbs)
    const auto = allow.has(command)
    emit({ t: "approval", id, command, cwd, auto })
    // The approval is for this exact string: the model can't change it after the user said yes.
    if (!auto) {
      const d = await deps.decide({ kind: "command", id, command, cwd })
      if (d.decision !== "approve") {
        emit({ t: "cmd-denied", id, reason: "Denied by the user" })
        return "The user denied this command. Don't run it again; continue without it or ask the user."
      }
      if (d.always) allow.add(command)
    }
    if (aborted()) throw new DOMException("aborted", "AbortError")
    deps.checkRoot?.()
    emit({ t: "cmd-start", id })
    let buf = ""
    let flushT: NodeJS.Timeout | undefined
    const flush = () => {
      flushT = undefined
      if (buf) emit({ t: "cmd-output", id, text: buf })
      buf = ""
    }
    const r = await exec(command, cwdAbs, {
      signal,
      onOutput: (s) => {
        buf += s
        flushT ??= setTimeout(flush, 100)
      },
      register: (kill) => kills.set(id, kill),
    })
    clearTimeout(flushT)
    flush()
    kills.delete(id)
    emit({ t: "cmd-exit", id, code: r.code, timedOut: r.timedOut, killed: r.killed })
    const tail = r.output.length > 3500 ? `[… ${r.output.length - 3500} earlier characters omitted]\n${r.output.slice(-3500)}` : r.output
    const status = r.timedOut ? `timed out after ${LIMITS.commandMs / 1000}s` : r.killed ? "stopped by the user" : `exit code ${r.code}`
    return `$ ${command}\n${status}\n${tail || "(no output)"}`
  }

  const kills = deps.kills ?? new Map<string, () => void>()

  for (let step = 1; ; step++) {
    if (aborted()) return finish("stopped")
    if (step > maxIter) return finish("iterations")
    if (used > maxTokens) return finish("tokens")
    emit({ t: "step", n: step })
    const maxOut = Math.max(1024, Math.min(4096, Math.floor(tokenBudgetSafe() * 0.3)))
    const budget = Math.max(2000, tokenBudgetSafe() - maxOut - estimateChars(JSON.stringify(TOOLS).length) - 300)
    let turn: ToolTurn
    try {
      turn = await model(compact(messages, budget), TOOLS, { signal, maxTokens: maxOut, onDelta: (d) => emit({ t: "delta", ...d }), onWait: (waitMs, m) => emit({ t: "wait", waitMs, model: m }) })
    } catch (err) {
      if (aborted()) return finish("stopped")
      // Groq rejects a turn whose tool call wasn't valid JSON ("tool_use_failed"); tell the model and let it retry.
      if (err instanceof ProviderError && err.status === 400 && /tool_use_failed|Failed to call a function|failed_generation/i.test(err.body) && malformed++ < 3) {
        messages.push({ role: "user", content: "(Kivo) Your last tool call was malformed and was rejected. Call the tool again with a valid JSON object for its arguments, or answer in plain text." })
        continue
      }
      throw err
    }
    malformed = 0
    used += turn.tokens
    emit({ t: "usage", tokens: used, model: turn.model })
    last = turn.content || last
    if (!turn.toolCalls.length) return finish("final", turn.content)
    messages.push({ role: "assistant", content: turn.content || "", tool_calls: turn.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })) })
    for (const call of turn.toolCalls) {
      if (aborted()) {
        messages.push({ role: "tool", tool_call_id: call.id, content: "Stopped by the user." })
        continue
      }
      const result = await runTool(call)
      messages.push({ role: "tool", tool_call_id: call.id, content: clipResult(result) })
    }
  }

  function finish(reason: "final" | "iterations" | "tokens" | "stopped", text = last) {
    const note = { final: "", iterations: `\n\n_Stopped after ${maxIter} steps — say "continue" to keep going._`, tokens: `\n\n_Stopped at the token limit for one run (${maxTokens.toLocaleString()} tokens)._`, stopped: "" }[reason]
    const out = reason === "final" ? text : `${text}${note}`.trim()
    emit({ t: "done", reason, text: out })
    return out
  }
}

/** Tests inject no provider; fall back to a small default budget. */
function tokenBudgetSafe() {
  try {
    return tokenBudget() || 8000
  } catch {
    return 8000
  }
}

// ─── Runs (HTTP) ──────────────────────────────────────────────────────────────

interface Run {
  id: string
  ac: AbortController
  pending: Map<string, (d: Decision) => void>
  kills: Map<string, () => void>
}

const runs = new Map<string, Run>()

/** Wait for the user's decision on a pending item; resolves as a refusal on timeout or abort. */
function waitDecision(run: Run, p: Pending): Promise<Decision> {
  const refuse: Decision = { decision: p.kind === "command" ? "deny" : "reject" }
  return new Promise((resolve) => {
    const done = (d: Decision) => {
      clearTimeout(timer)
      run.ac.signal.removeEventListener("abort", onAbort)
      run.pending.delete(p.id)
      resolve(d)
    }
    const onAbort = () => done(refuse)
    const timer = setTimeout(() => done(refuse), LIMITS.decisionMs)
    run.ac.signal.addEventListener("abort", onAbort, { once: true })
    run.pending.set(p.id, done)
  })
}

// ─── Autocomplete ─────────────────────────────────────────────────────────────

const COMPLETE_SYSTEM =
  "You are a code completion engine. The user's file is shown with the cursor marked <CURSOR>. Output ONLY the exact text to insert at the cursor: no explanation, no markdown fences, and never repeat code that is already before or after the cursor. Complete the current statement or at most a few lines, matching the file's style and indentation. If unsure, output nothing."

export function completionPrompt(file: string, language: string, prefix: string, suffix: string) {
  return `File: ${file}${language ? ` (${language})` : ""}\n\n${prefix}<CURSOR>${suffix}`
}

/** Clean a model completion: strip fences/prose, drop text that repeats what's around the cursor, cap the length. */
export function cleanCompletion(raw: string, prefix: string, suffix: string): string {
  let s = raw.replace(/\r/g, "")
  const fence = s.match(/```[\w+#.-]*\n([\s\S]*?)(?:\n?```|$)/)
  if (fence) s = fence[1]
  s = s.replace(/<\/?CURSOR>/g, "")
  if (/^\s*(here('s| is)|sure[,!]|certainly|the (code|completion)|i (can|would|think))\b/i.test(s)) return ""
  const line = prefix.slice(prefix.lastIndexOf("\n") + 1)
  // The model restated the current line (or its text) before continuing it.
  if (line && s.startsWith(line)) s = s.slice(line.length)
  else if (line.trim().length >= 2 && s.trimStart().startsWith(line.trim())) s = s.trimStart().slice(line.trim().length)
  else
    for (let k = Math.min(s.length, prefix.length, 400); k >= 12; k--)
      if (prefix.endsWith(s.slice(0, k))) {
        s = s.slice(k)
        break
      }
  const restOfLine = suffix.split("\n")[0]
  // With text after the cursor on this line (even just closing brackets), only a same-line completion makes sense.
  if (restOfLine.trim()) s = s.split("\n")[0]
  if (restOfLine.trim() && s.endsWith(restOfLine.trim())) s = s.slice(0, s.length - restOfLine.trim().length)
  let out = s.split("\n")
  // Drop a trailing line that duplicates the next line after the cursor (e.g. a closing brace).
  const nextLine = suffix.split("\n").slice(1).find((l) => l.trim())?.trim()
  while (out.length > 1 && !out[out.length - 1].trim()) out.pop()
  if (out.length > 1 && nextLine && out[out.length - 1].trim() === nextLine) out.pop()
  if (out.length > 12) out = out.slice(0, 12)
  let text = out.join("\n")
  if (text.length > 600) text = text.slice(0, text.lastIndexOf("\n", 600) > 0 ? text.lastIndexOf("\n", 600) : 600)
  return text.trim() ? text.replace(/\s+$/, (m) => (m.includes("\n") ? "" : m)) : ""
}

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
      decide: (p) => waitDecision(run, p),
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
