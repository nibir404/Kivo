import { chatWithTools, estimateChars, ProviderError, tokenBudget, type ChatMsg, type Delta, type ToolCall, type ToolDef, type ToolTurn } from "./client"

/**
 * Kivo's coding agent and editor autocomplete, independent of where they run.
 *
 * The agent is a tool-calling loop: the model reads, searches and proposes edits; the user approves
 * every command and (by default) every edit. Model output is untrusted: every path goes through the
 * workspace's `resolve` (no escaping the project), commands only run after an explicit approval for
 * that exact string, and the loop is capped in iterations and tokens. Stop aborts the model request,
 * any pending approval and any command.
 *
 * The host supplies an `AgentWorkspace`: the daemon backs it with the real filesystem and a shell,
 * the browser with the demo project or a folder the user picked (and no shell).
 */

export class ToolError extends Error {}

// ─── The workspace a run operates on ──────────────────────────────────────────

export interface ExecResult {
  code: number | null
  timedOut: boolean
  killed: boolean
  output: string
}

/** Runs an approved command. `cwd` is project-relative ("." for the root). */
export type WorkspaceExec = (command: string, cwd: string, opts: { signal: AbortSignal; onOutput: (s: string) => void; register: (kill: () => void) => void }) => Promise<ExecResult>

export interface AgentWorkspace {
  /** Project name and a one-line description of where it lives, for the system prompt. */
  name: string
  where: string
  files(): string[] | Promise<string[]>
  /** Normalize a model-supplied path to a project-relative one ("." for the root); throws a ToolError if it escapes. */
  resolve(path: unknown, opts?: { write?: boolean }): string
  exists(rel: string): boolean | Promise<boolean>
  isDir(rel: string): boolean | Promise<boolean>
  /** Text content; throws a ToolError for missing, binary or oversized files. */
  read(rel: string): string | Promise<string>
  write(rel: string, content: string): void | Promise<void>
  /** Content search: "path:line:text" lines, plus an optional note shown to the model. */
  search(q: { query: string; regex: boolean; caseSensitive: boolean; scope?: string }): Promise<{ lines: string[]; note?: string }>
  /** Absent where there's no shell (the browser): run_command then isn't offered to the model. */
  exec?: WorkspaceExec
}

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

const toolsFor = (ws: AgentWorkspace) => (ws.exec ? TOOLS : TOOLS.filter((t) => t.function.name !== "run_command"))

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

export type ModelFn = (messages: ChatMsg[], tools: ToolDef[], opts: { signal: AbortSignal; onDelta: (d: Delta) => void; onWait: (waitMs: number, model: string) => void; maxTokens: number }) => Promise<ToolTurn>

export interface RunOptions {
  emit: (e: AgentEvent) => void
  /** Waits for the user's answer. Must reject (or resolve "deny"/"reject") on abort/timeout. */
  decide: (p: Pending) => Promise<Decision>
  signal: AbortSignal
  model?: ModelFn
  /** Throws if the project changed under the run. */
  checkRoot?: () => void
  /** Kill switches for running commands, by tool-call id (the host exposes them to the UI). */
  kills?: Map<string, () => void>
  autoApply?: boolean
  allow?: Set<string>
  maxIterations?: number
  maxTokens?: number
}

export const LIMITS = { iterations: 25, tokens: 200_000, readChars: 9000, readLines: 300, listMax: 300, searchMatches: 60, commandMs: 120_000, commandBytes: 400_000, resultChars: 6000, decisionMs: 10 * 60_000 }

// ─── Argument validation ──────────────────────────────────────────────────────

export type Args = Record<string, unknown>

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

/** Glob for list_files: `**` spans folders, `*` doesn't; case-insensitive, whole path. */
export function listGlob(glob: string) {
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
      const re = listGlob(pattern.replace(/^\.\//, ""))
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

/** read_file over any text: line range, capped in lines and characters. */
export function readRange(rel: string, content: string, a: Args) {
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
  const more = end < total ? `\n[… lines ${end + 1}-${total} not shown — call read_file with start_line=${end + 1}]` : ""
  return { text: `${rel} (lines ${start}-${end} of ${total})\n${body}${more}`, summary: `lines ${start}–${end} of ${total}` }
}

/** Format search hits for the model. */
export function searchResult(lines: string[], note = "") {
  const clip = (l: string) => (l.length > 200 ? `${l.slice(0, 200)}…` : l)
  const shown = lines.slice(0, LIMITS.searchMatches).map(clip)
  const more = lines.length - shown.length
  return { text: `${note}${lines.length ? shown.join("\n") : "No matches."}${more > 0 ? `\n… ${more} more matches (narrow the query or path)` : ""}`, summary: `${lines.length}${more > 0 ? "+" : ""} match${lines.length === 1 ? "" : "es"}` }
}

/**
 * Replace `search` with `replace` once: exact first, then ignoring trailing whitespace per line.
 * Returns null when it isn't found. The replacement is inserted literally ("$&" stays "$&").
 */
export function applyEdit(content: string, search: string, replace: string): string | null {
  if (content.includes(search)) return content.replace(search, () => replace)
  const norm = (l: string) => l.trimEnd()
  const lines = content.split("\n")
  const target = search.split("\n").map(norm)
  while (target.length && !target[target.length - 1]) target.pop()
  for (let i = 0; i + target.length <= lines.length; i++) {
    if (target.every((t, j) => norm(lines[i + j]) === t)) {
      return [...lines.slice(0, i), ...replace.split("\n"), ...lines.slice(i + target.length)].join("\n")
    }
  }
  return null
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

export function systemPrompt(ws: Pick<AgentWorkspace, "name" | "where" | "exec">) {
  const shell = !!ws.exec
  return [
    `You are Kivo's coding agent, working in the user's project "${ws.name}" ${ws.where}.`,
    `Tools: list_files, read_file, search, edit_file, create_file, ${shell ? "run_command, " : ""}todo_write. Paths are relative to the project root; nothing outside it is reachable.`,
    "- Explore with list_files/search/read_file. Read a file before editing it.",
    "- Make minimal, targeted edits: edit_file with exact search/replace blocks copied from read_file (enough context to be unique). Don't rewrite whole files unless creating them.",
    `- Act by calling tools; don't ask permission in text. Kivo itself shows the user every edit as a diff${shell ? " and every command for approval" : ""}. If one is rejected${shell ? " or denied" : ""}, don't retry it — adjust or ask.`,
    shell ? "- Use run_command for tests/builds/scripts, not for reading files. No interactive commands." : "- There is no shell here (Kivo is running in the browser): you can't run commands, tests or builds. Say so if the task needs one.",
    "- For multi-step work keep a short todo list with todo_write and update statuses as you go.",
    "- If the request is unclear or you're blocked, stop and ask in plain text.",
    "- Finish with a short summary of what you did. Be concise.",
  ].join("\n")
}

const defaultModel: ModelFn = (messages, tools, o) => chatWithTools(messages, tools, o.onDelta, { signal: o.signal, maxTokens: o.maxTokens, effort: "low", onRateLimit: (r) => o.onWait(r.waitMs, r.next) })

const clipResult = (s: string) => (s.length > LIMITS.resultChars ? `${s.slice(0, LIMITS.resultChars)}\n[… truncated]` : s)
const short = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** Runs the agent to completion in a workspace. Returns the final assistant text. */
export async function runAgentIn(ws: AgentWorkspace, task: string, history: { role: "user" | "assistant"; content: string }[], deps: RunOptions): Promise<string> {
  const { emit, signal } = deps
  const model = deps.model ?? defaultModel
  const tools = toolsFor(ws)
  const allow = deps.allow ?? new Set<string>()
  let autoApply = !!deps.autoApply
  const maxIter = deps.maxIterations ?? LIMITS.iterations
  const maxTokens = deps.maxTokens ?? LIMITS.tokens
  const messages: ChatMsg[] = [{ role: "system", content: systemPrompt(ws) }, ...history.slice(-8).map((m) => ({ role: m.role, content: m.content.slice(0, 4000) })), { role: "user", content: task }]
  let used = 0
  let malformed = 0
  let last = ""
  const aborted = () => signal.aborted
  const kills = deps.kills ?? new Map<string, () => void>()

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
      todo_write: `${Array.isArray(a.todos) ? a.todos.length : 0} items`,
      ...(ws.exec ? { run_command: short(String(a.command ?? ""), 80) } : {}),
    }
    if (!(call.name in label)) {
      emit({ t: "tool", id, name: call.name, summary: "unknown tool" })
      emit({ t: "tool-done", id, ok: false, summary: "unknown tool" })
      return `Error: unknown tool "${call.name}". Available: ${tools.map((t) => t.function.name).join(", ")}`
    }
    emit({ t: "tool", id, name: call.name, summary: label[call.name] })
    try {
      deps.checkRoot?.()
      switch (call.name) {
        case "list_files": {
          const r = listTool(await ws.files(), a)
          emit({ t: "tool-done", id, ok: true, summary: r.summary })
          return r.text
        }
        case "read_file": {
          const rel = ws.resolve(a.path)
          const r = readRange(rel, await ws.read(rel), a)
          emit({ t: "tool-done", id, ok: true, summary: r.summary })
          return r.text
        }
        case "search": {
          const query = str(a, "query", { required: true, max: 500 })!
          const scope = a.path ? ws.resolve(a.path) : undefined
          const found = await ws.search({ query, regex: bool(a, "regex"), caseSensitive: bool(a, "case_sensitive"), scope: scope && scope !== "." ? scope : undefined })
          const r = searchResult(found.lines, found.note)
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
      const msg = err instanceof ToolError || (err as { code?: unknown }).code ? (err as Error).message : `unexpected failure: ${(err as Error).message}`
      emit({ t: "tool-done", id, ok: false, summary: msg })
      return `Error: ${msg}`
    }
    return "Error: not handled"
  }

  const editTool = async (name: "edit_file" | "create_file", id: string, a: Args): Promise<string> => {
    const rel = ws.resolve(a.path, { write: true })
    if (rel === ".") throw new ToolError("path must be a file")
    const exists = await ws.exists(rel)
    const content = str(a, "content", { max: 400_000 })
    let original = ""
    let proposed: string
    if (name === "create_file") {
      if (exists) throw new ToolError(`${rel} already exists — use edit_file`)
      if (content === undefined) throw new ToolError('"content" is required')
      proposed = content
    } else if (content !== undefined && a.edits === undefined) {
      original = exists ? await ws.read(rel) : ""
      proposed = content
    } else {
      if (!exists) throw new ToolError(`${rel} does not exist — use create_file (or pass "content")`)
      original = await ws.read(rel)
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
    const now = (await ws.exists(rel)) ? await ws.read(rel) : ""
    let final = proposed
    if (now !== original) {
      const changed = () => {
        emit({ t: "edit-result", id, path: rel, status: "error", message: "The file changed on disk while this edit was waiting" })
        return `Error: ${rel} changed on disk before the edit was applied; read it again.`
      }
      if (name === "create_file" || (content !== undefined && a.edits === undefined)) return changed()
      try {
        final = applyEdits(now, validateEdits(a.edits))
      } catch {
        return changed()
      }
    }
    await ws.write(rel, final)
    emit({ t: "edit-result", id, path: rel, status: "applied" })
    return `${exists ? "Edited" : "Created"} ${rel} (${final.split("\n").length} lines). The user accepted the change.`
  }

  const commandTool = async (id: string, a: Args): Promise<string> => {
    const exec = ws.exec
    if (!exec) throw new ToolError("There's no shell here — commands can't run in the browser")
    const command = str(a, "command", { required: true, max: 4000 })!.trim()
    const cwd = a.cwd ? ws.resolve(a.cwd) : "."
    if (!(await ws.isDir(cwd))) throw new ToolError(`cwd ${cwd} is not a folder`)
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
    let flushT: ReturnType<typeof setTimeout> | undefined
    const flush = () => {
      flushT = undefined
      if (buf) emit({ t: "cmd-output", id, text: buf })
      buf = ""
    }
    const r = await exec(command, cwd, {
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

  for (let step = 1; ; step++) {
    if (aborted()) return finish("stopped")
    if (step > maxIter) return finish("iterations")
    if (used > maxTokens) return finish("tokens")
    emit({ t: "step", n: step })
    const maxOut = Math.max(1024, Math.min(4096, Math.floor(tokenBudget() * 0.3)))
    const budget = Math.max(2000, tokenBudget() - maxOut - estimateChars(JSON.stringify(tools).length) - 300)
    let turn: ToolTurn
    try {
      turn = await model(compact(messages, budget), tools, { signal, maxTokens: maxOut, onDelta: (d) => emit({ t: "delta", ...d }), onWait: (waitMs, m) => emit({ t: "wait", waitMs, model: m }) })
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

/** Wait for the user's decision on a pending item; resolves as a refusal on timeout or abort. */
export function waitDecision(signal: AbortSignal, pending: Map<string, (d: Decision) => void>, p: Pending): Promise<Decision> {
  const refuse: Decision = { decision: p.kind === "command" ? "deny" : "reject" }
  return new Promise((resolve) => {
    const done = (d: Decision) => {
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      pending.delete(p.id)
      resolve(d)
    }
    const onAbort = () => done(refuse)
    const timer = setTimeout(() => done(refuse), LIMITS.decisionMs)
    signal.addEventListener("abort", onAbort, { once: true })
    pending.set(p.id, done)
  })
}

// ─── Autocomplete ─────────────────────────────────────────────────────────────

export const COMPLETE_SYSTEM =
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
