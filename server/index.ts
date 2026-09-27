import http from "node:http"
import path from "node:path"
import * as pty from "node-pty"
import { WebSocketServer } from "ws"
import { parseIntent } from "../src/core/intent"
import type { Decision, Endpoint, ServiceSpec, StackChoice } from "../src/core/types"
import { bus } from "./bus"
import { aiAvailable, checkAll, currentModel, describe, parseJsonLoose, setActive, stream, type Msg } from "./ai"
import { cleanEnv, runBuild, serviceUrl, type BuildEvent } from "./pipeline"
import { chatSystem, EDIT_SYSTEM, editUser, INTENT_SYSTEM, intentUser } from "./prompts"
import { analyze, ensureWorkspace, git, listFiles, PROJECT, PROJECT_DIR, readFile, VENV, writeFile } from "./workspace"

/**
 * Kivo daemon — local only. Binds to 127.0.0.1 and rejects requests from any origin
 * other than the Kivo UI, so a web page can't reach the terminal or the filesystem.
 */

const PORT = Number(process.env.KIVO_DAEMON_PORT ?? 5175)
const ALLOWED = new Set(["http://localhost:5174", "http://127.0.0.1:5174", "http://localhost:4173", "http://127.0.0.1:4173"])

await ensureWorkspace()
await checkAll()

const originOk = (req: http.IncomingMessage) => !req.headers.origin || ALLOWED.has(req.headers.origin)

async function body<T>(req: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return JSON.parse(Buffer.concat(chunks).toString() || "{}") as T
}

function json(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(data))
}

function sse(res: http.ServerResponse) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" })
  return (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`)
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")

/** Model output is untrusted: coerce anything into a display string. */
const str = (v: unknown): string =>
  typeof v === "string" ? v : v && typeof v === "object" ? str((v as Record<string, unknown>).text ?? (v as Record<string, unknown>).question ?? (v as Record<string, unknown>).name ?? (v as Record<string, unknown>).title ?? JSON.stringify(v)) : v == null ? "" : String(v)
const strs = (v: unknown) => (Array.isArray(v) ? v.map(str).filter(Boolean) : [])

/** Merge the model's JSON into a complete ServiceSpec, using the deterministic parse as defaults. */
function normalizeSpec(ai: Record<string, unknown>, text: string, stack: StackChoice): ServiceSpec {
  const base = parseIntent(text, stack)
  const name = str(ai.name).trim() ? str(ai.name).trim().replace(/\s+service$/i, "") : base.name
  const reqs = Array.isArray(ai.requirements) && ai.requirements.length ? (ai.requirements as Record<string, unknown>[]).map((r) => ({ id: slug(str(r.id ?? r.title)).replace(/-/g, "_"), title: str(r.title ?? r.id), description: str(r.description) })) : base.requirements
  const endpoints = Array.isArray(ai.endpoints) && ai.endpoints.length ? (ai.endpoints as Record<string, unknown>[]).map((e) => ({ method: str(e.method).toUpperCase() as Endpoint["method"], path: str(e.path), summary: str(e.summary), requirement: str(e.requirement), auth: Boolean(e.auth) })) : base.api.endpoints
  const entities = Array.isArray(ai.entities) && ai.entities.length
    ? (ai.entities as Record<string, unknown>[]).map((e) => ({ name: str(e.name), fields: (Array.isArray(e.fields) ? e.fields : []).map((f: Record<string, unknown>) => ({ name: str(f.name), type: str(f.type), note: f.note ? str(f.note) : undefined })) }))
    : base.entities
  const aiDecisions: Decision[] = Array.isArray(ai.decisions) ? (ai.decisions as Record<string, unknown>[]).map((d) => ({ topic: str(d.topic), choice: str(d.choice), reason: str(d.reason), alternatives: strs(d.alternatives) })) : []
  const usesCache = ai.uses_cache === true && stack.cache && stack.cache !== "None"
  const auth = ai.authentication && typeof ai.authentication === "object" ? { strategy: str((ai.authentication as Record<string, unknown>).strategy), reason: str((ai.authentication as Record<string, unknown>).reason) } : undefined
  return {
    ...base,
    id: slug(name),
    name,
    purpose: str(ai.purpose) || base.purpose,
    requirements: reqs,
    entities,
    api: { style: "rest", endpoints },
    authentication: auth,
    cache: usesCache ? { type: stack.cache!, reason: "sessions, rate limits, hot reads" } : undefined,
    implementation: { ...stack, cache: usesCache ? stack.cache : undefined },
    dependsOn: Array.isArray(ai.depends_on) ? strs(ai.depends_on).map((d) => slug(d)) : base.dependsOn,
    decisions: [...base.decisions.filter((d) => d.topic === "Language & framework" || d.topic === "Storage" || (d.topic === "Cache" && usesCache)), ...aiDecisions.filter((d) => !["Language & framework", "Storage", "Cache"].includes(d.topic))],
    questions: strs(ai.questions),
  } as ServiceSpec
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost")
  if (!originOk(req)) return json(res, 403, { error: "origin not allowed" })

  try {
    if (url.pathname === "/api/health") return json(res, 200, { ...describe(), ai: aiAvailable(), model: currentModel(), project: PROJECT })

    if (url.pathname === "/api/providers" && req.method === "GET") return json(res, 200, await checkAll())

    if (url.pathname === "/api/providers/active" && req.method === "POST") {
      const b = await body<{ id: string }>(req)
      return json(res, 200, setActive(b.id))
    }

    if (url.pathname === "/api/project") return json(res, 200, analyze())

    if (url.pathname === "/api/fs/tree") return json(res, 200, { files: listFiles() })

    if (url.pathname === "/api/fs/read") return json(res, 200, { path: url.searchParams.get("path"), content: readFile(url.searchParams.get("path") ?? "") })

    if (url.pathname === "/api/fs/write" && req.method === "PUT") {
      const b = await body<{ path: string; content: string }>(req)
      writeFile(b.path, b.content)
      return json(res, 200, { ok: true })
    }

    if (url.pathname === "/api/git/log") {
      const { stdout } = await git(["log", "--stat", "--format=%h%x09%s%x09%ar", "-n", "15"])
      return json(res, 200, { log: stdout })
    }

    if (url.pathname === "/api/proxy" && req.method === "POST") {
      // In-app API client. Only reaches services Kivo itself launched on 127.0.0.1 — never arbitrary URLs.
      const b = await body<{ service: string; method: string; path: string; headers?: Record<string, string>; body?: string }>(req)
      const base = serviceUrl(b.service)
      if (!base) return json(res, 404, { error: `${b.service} is not running` })
      if (!b.path.startsWith("/") || b.path.startsWith("//")) return json(res, 400, { error: "path must start with /" })
      const started = performance.now()
      const r = await fetch(base + b.path, {
        method: b.method,
        headers: { "Content-Type": "application/json", ...(b.headers ?? {}) },
        body: ["GET", "HEAD"].includes(b.method.toUpperCase()) ? undefined : b.body,
      })
      const text = await r.text()
      return json(res, 200, { status: r.status, statusText: r.statusText, ms: Math.round(performance.now() - started), headers: Object.fromEntries(r.headers), body: text })
    }

    if (url.pathname === "/api/events") {
      const send = sse(res)
      const on = (e: unknown) => send(e)
      bus.on("event", on)
      const ping = setInterval(() => res.write(": ping\n\n"), 15000)
      req.on("close", () => {
        bus.off("event", on)
        clearInterval(ping)
      })
      return
    }

    if (!aiAvailable() && url.pathname.startsWith("/api/ai")) return json(res, 503, { error: "No AI provider is available — configure one in .env (see .env.example)" })

    if (url.pathname === "/api/ai/intent" && req.method === "POST") {
      const b = await body<{ text: string; stack: StackChoice }>(req)
      const send = sse(res)
      const a = analyze()
      const project = `Detected: ${a.detections.map((d) => `${d.tech} (${d.category})`).join(", ")}.\nExisting services: User Management (/users), Notifications (/notify).\nLanguages: ${a.languages.map((l) => `${l.name} ${l.share}%`).join(", ")}.`
      const content = await stream(
        [
          { role: "system", content: INTENT_SYSTEM },
          { role: "user", content: intentUser(b.text, b.stack, project) },
        ],
        (d) => send({ t: "delta", ...d }),
        { json: true, effort: "medium", onRateLimit: (r) => send({ t: "wait", ...r }) },
      )
      send({ t: "result", spec: normalizeSpec(parseJsonLoose(content), b.text, b.stack) })
      return res.end()
    }

    if (url.pathname === "/api/ai/chat" && req.method === "POST") {
      const b = await body<{ messages: Msg[]; context: string; level: string }>(req)
      const send = sse(res)
      const ac = new AbortController()
      req.on("close", () => ac.abort())
      await stream([{ role: "system", content: chatSystem(b.level, b.context) }, ...b.messages.slice(-12)], (d) => send({ t: "delta", ...d }), { effort: "low", maxTokens: 2048, signal: ac.signal, onRateLimit: (r) => send({ t: "wait", ...r }) })
      send({ t: "done" })
      return res.end()
    }

    if (url.pathname === "/api/ai/edit" && req.method === "POST") {
      const b = await body<{ path: string; content: string; from: number; to: number; instruction: string; previous?: string }>(req)
      const send = sse(res)
      const ac = new AbortController()
      res.on("close", () => ac.abort())
      await stream(
        [
          { role: "system", content: EDIT_SYSTEM },
          {
            role: "user",
            content: editUser({
              path: b.path,
              before: b.content.slice(0, b.from),
              region: b.content.slice(b.from, b.to),
              after: b.content.slice(b.to),
              instruction: b.instruction,
              previous: b.previous,
              projectNote: "Project: tandem (React Native + FastAPI). Python services target Python 3.9 (typing.Optional, no X | Y unions).",
            }),
          },
        ],
        (d) => send({ t: "delta", ...d }),
        { effort: "low", maxTokens: 3000, signal: ac.signal, onRateLimit: (r) => send({ t: "wait", ...r }) },
      )
      send({ t: "done" })
      return res.end()
    }

    if (url.pathname === "/api/build" && req.method === "POST") {
      const { spec } = await body<{ spec: ServiceSpec }>(req)
      const send = sse(res)
      const ac = new AbortController()
      res.on("close", () => ac.abort())
      await runBuild(spec, (e: BuildEvent) => send(e), ac.signal).catch((err) => send({ t: "error", message: String(err?.message ?? err) }))
      return res.end()
    }

    json(res, 404, { error: "not found" })
  } catch (err) {
    if (res.headersSent) {
      res.write(`data: ${JSON.stringify({ t: "error", message: String((err as Error).message) })}\n\n`)
      res.end()
    } else json(res, 500, { error: String((err as Error).message) })
  }
})

// ─── Terminal: a real shell in the project workspace ─────────────────────────

const wss = new WebSocketServer({ noServer: true })

server.on("upgrade", (req, socket, head) => {
  if (!req.url?.startsWith("/ws/terminal") || !originOk(req) || !req.headers.origin) {
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const env = cleanEnv()
    env.VIRTUAL_ENV = VENV
    env.PATH = `${path.join(VENV, "bin")}:${env.PATH}`
    env.TERM = "xterm-256color"
    env.KIVO = "1"
    const shell = pty.spawn(process.env.SHELL || "/bin/zsh", ["-l"], { name: "xterm-256color", cols: 100, rows: 24, cwd: PROJECT_DIR, env: env as Record<string, string> })
    shell.onData((d) => ws.readyState === ws.OPEN && ws.send(d))
    shell.onExit(() => ws.close())
    ws.on("message", (raw) => {
      const msg = raw.toString()
      if (msg.startsWith("\u0000resize:")) {
        const [cols, rows] = msg.slice(8).split("x").map(Number)
        if (cols > 0 && rows > 0) shell.resize(cols, rows)
      } else shell.write(msg)
    })
    ws.on("close", () => shell.kill())
  })
})

server.listen(PORT, "127.0.0.1", () => {
  const d = describe()
  console.log(`kivo daemon  http://127.0.0.1:${PORT}  workspace ${PROJECT_DIR}  active=${d.active}`)
  for (const p of d.providers) console.log(`  ${p.id.padEnd(7)} ${p.status.padEnd(13)} ${p.message ?? p.models.join(", ")}`)
})
