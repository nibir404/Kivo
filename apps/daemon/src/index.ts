import http from "node:http"
import path from "node:path"
import { WebSocketServer } from "ws"
import type { ServiceSpec } from "@kivo/core/types"
import { aiAvailable, checkAll, currentModel, describe, parseJsonLoose, setActive, stream, type Msg } from "./ai/ai"
import { bus } from "./events/bus"
import { keyEditable, loadSavedKey, setGroqKey } from "./ai/settings"
import { HttpError, json, readJson, requireObject, requireString, sse } from "./http/http"
import { isBuilding, runBuild, serviceUrl, stopAll, type BuildEvent } from "./build/pipeline"
import { chatSystem, EDIT_SYSTEM, editUser, INTENT_SYSTEM, intentUser } from "@kivo/ai/prompts"
import { normalizeSpec, parseServices, projectContext, resolveStack, sanitizeStack, validateBuildSpec } from "@kivo/ai/spec"
import { attachTerminal, killAllTerminals, killTerminal, listTerminals } from "./terminal/terminals"
import { allToolchains } from "./build/toolchains"
import { hostOk, originOk, PORT, serveUi, uiBuilt } from "./http/web"
import { handle as handleAgent } from "./agent/agent"
import { handle as handleEditor } from "./editor/editor"
import { handleProjects } from "./projects/projects"
import { handle as handleScm } from "./scm/scm"
import { analyze, ensureWorkspace, git, isGitRepo, listFiles, project, projectDir, publicProject, readFile, writeFile } from "./projects/workspace"

/**
 * Kivo daemon — local only. Binds to 127.0.0.1 and rejects requests from any origin
 * other than the Kivo UI, so a web page can't reach the terminal or the filesystem.
 *
 * Robustness rules: every input is validated (4xx, never a crash), every child process and
 * outbound request has an error path and a timeout, and shutdown stops what Kivo started.
 */

/** `npm start`: the daemon also serves the built UI, so Kivo is one process on one port. */
const SERVE_UI = process.argv.includes("--serve")
const PROXY_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
/** Headers the API client may not set: they describe the connection, which the daemon owns. */
const HOP_HEADERS = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade", "te", "trailer", "proxy-authorization", "proxy-connection", "expect"])
const PROXY_MAX_BODY = 2_000_000

const [major, minor] = process.versions.node.split(".").map(Number)
if (major < 22 || (major === 22 && minor < 9)) {
  console.error(`[kivo] Node ${process.versions.node} is too old — Kivo needs Node 22.9 or newer.`)
  process.exit(1)
}

// A bug in one request must never take down the terminal, running services and other builds with it.
process.on("unhandledRejection", (err) => console.error("[kivo] unhandled rejection:", err))
process.on("uncaughtException", (err) => console.error("[kivo] uncaught exception:", err))

await ensureWorkspace()
loadSavedKey()
await checkAll()

/** Editor language note for inline edits, from the file being edited rather than a fixed assumption. */
function editNote(file: string) {
  const ext = path.extname(file).slice(1)
  const lang = { py: "Python 3.9 (typing.Optional, no X | Y unions)", ts: "TypeScript", tsx: "TypeScript + React", js: "JavaScript", java: "Java", kt: "Kotlin", go: "Go", rs: "Rust", sql: "SQL" }[ext]
  return `Project: ${project().name}. ${lang ? `This file is ${lang}.` : ""}`.trim()
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost")
  if (!hostOk(req)) return json(res, 421, { error: "Kivo only answers on localhost" })
  if (!originOk(req)) return json(res, 403, { error: "origin not allowed" })

  try {
    if (url.pathname === "/api/health") return json(res, 200, { ...describe(), keyEditable: keyEditable(), ai: aiAvailable(), model: currentModel(), project: project().name, projectInfo: publicProject(project()), toolchains: await allToolchains() })

    // Feature modules own their routes (projects, editor, source control, agent).
    for (const h of [handleProjects, handleEditor, handleScm, handleAgent]) if (await h(req, res, url)) return

    if (url.pathname === "/api/providers" && req.method === "GET") return json(res, 200, await checkAll())

    if (url.pathname === "/api/providers/active" && req.method === "POST") {
      const b = await readJson(req)
      return json(res, 200, setActive(requireString(b.id, "id", 40)))
    }

    if (url.pathname === "/api/settings/key" && req.method === "POST") {
      // Only where there's no .env to edit (the desktop app); otherwise keys live in .env.
      if (!keyEditable()) throw new HttpError(404, "Keys are set in .env on this computer")
      const b = await readJson(req)
      if (typeof b.key !== "string") throw new HttpError(400, '"key" must be a string')
      try {
        return json(res, 200, await setGroqKey(b.key))
      } catch (err) {
        throw new HttpError(400, (err as Error).message)
      }
    }

    if (url.pathname === "/api/project") return json(res, 200, analyze())

    if (url.pathname === "/api/fs/tree") return json(res, 200, { files: listFiles() })

    if (url.pathname === "/api/fs/read") {
      const file = requireString(url.searchParams.get("path"), "path", 1024)
      return json(res, 200, { path: file, content: readFile(file) })
    }

    if (url.pathname === "/api/fs/write" && req.method === "PUT") {
      const b = await readJson(req)
      const file = requireString(b.path, "path", 1024)
      if (typeof b.content !== "string") throw new HttpError(400, '"content" must be a string')
      writeFile(file, b.content)
      return json(res, 200, { ok: true })
    }

    if (url.pathname === "/api/terminals" && req.method === "GET") return json(res, 200, { terminals: listTerminals() })

    if (url.pathname === "/api/terminals" && req.method === "DELETE") {
      const id = requireString(url.searchParams.get("id"), "id", 64)
      return json(res, killTerminal(id) ? 200 : 404, { ok: true })
    }

    if (url.pathname === "/api/git/log") {
      const log = await (isGitRepo() ? git(["log", "--stat", "--format=%h%x09%s%x09%ar", "-n", "15"]) : Promise.reject()).then(
        (r) => r.stdout,
        () => "",
      )
      return json(res, 200, { log })
    }

    if (url.pathname === "/api/proxy" && req.method === "POST") {
      // In-app API client. Only reaches services Kivo itself launched on 127.0.0.1 — never arbitrary URLs.
      const b = await readJson(req)
      const service = requireString(b.service, "service", 64)
      const method = requireString(b.method, "method", 10).toUpperCase()
      const target = requireString(b.path, "path", 2048)
      if (!PROXY_METHODS.has(method)) throw new HttpError(400, `Unsupported method ${method}`)
      if (!target.startsWith("/") || target.startsWith("//")) throw new HttpError(400, "path must start with /")
      const base = serviceUrl(service)
      if (!base) return json(res, 404, { error: `${service} is not running` })
      const headers: Record<string, string> = { "Content-Type": "application/json" }
      if (b.headers && typeof b.headers === "object")
        for (const [k, v] of Object.entries(b.headers)) if (typeof v === "string" && /^[!#-'*+.^-`|~\w]+$/.test(k) && !HOP_HEADERS.has(k.toLowerCase())) headers[k] = v
      const started = performance.now()
      try {
        const r = await fetch(base + target, {
          method,
          headers,
          body: ["GET", "HEAD"].includes(method) || typeof b.body !== "string" ? undefined : b.body,
          signal: AbortSignal.timeout(30_000),
        })
        const text = await readCapped(r, PROXY_MAX_BODY)
        return json(res, 200, { status: r.status, statusText: r.statusText, ms: Math.round(performance.now() - started), headers: Object.fromEntries(r.headers), body: text })
      } catch (err) {
        const timedOut = (err as Error).name === "TimeoutError"
        return json(res, 502, { error: timedOut ? `${service} didn't respond within 30s` : `Couldn't reach ${service}: ${(err as Error).message}` })
      }
    }

    if (url.pathname === "/api/events") {
      const send = sse(res)
      const on = (e: unknown) => send(e)
      bus.on("event", on)
      const ping = setInterval(() => !res.writableEnded && res.write(": ping\n\n"), 15000)
      req.on("close", () => {
        bus.off("event", on)
        clearInterval(ping)
      })
      return
    }

    if (url.pathname.startsWith("/api/ai") && !aiAvailable()) return json(res, 503, { error: "No AI provider is available — configure one in .env (see .env.example)" })

    if (url.pathname === "/api/ai/intent" && req.method === "POST") {
      const b = await readJson(req)
      const text = requireString(b.text, "text", 4000)
      // A language named in the request ("…in Java") wins over the picker — and the UI is told which one was used.
      const stack = resolveStack(text, sanitizeStack(b.stack))
      const ac = new AbortController()
      res.on("close", () => ac.abort())
      const send = sse(res)
      const content = await stream(
        [
          { role: "system", content: INTENT_SYSTEM },
          { role: "user", content: intentUser(text, stack, projectContext(analyze(), parseServices(b.services))) },
        ],
        (d) => send({ t: "delta", ...d }),
        { json: true, effort: "medium", signal: ac.signal, onRateLimit: (r) => send({ t: "wait", ...r }) },
      )
      send({ t: "result", spec: normalizeSpec(parseJsonLoose(content), text, stack) })
      return res.end()
    }

    if (url.pathname === "/api/ai/chat" && req.method === "POST") {
      const b = await readJson(req)
      if (!Array.isArray(b.messages)) throw new HttpError(400, '"messages" must be an array')
      const messages = (b.messages as Msg[]).filter((m) => (m?.role === "user" || m?.role === "assistant") && typeof m.content === "string").slice(-12)
      const ac = new AbortController()
      res.on("close", () => ac.abort())
      const send = sse(res)
      await stream([{ role: "system", content: chatSystem(String(b.level ?? "intermediate"), String(b.context ?? "").slice(0, 40_000)) }, ...messages], (d) => send({ t: "delta", ...d }), {
        effort: "low",
        maxTokens: 2048,
        signal: ac.signal,
        onRateLimit: (r) => send({ t: "wait", ...r }),
      })
      send({ t: "done" })
      return res.end()
    }

    if (url.pathname === "/api/ai/edit" && req.method === "POST") {
      const b = await readJson(req)
      const file = requireString(b.path, "path", 1024)
      const content = typeof b.content === "string" ? b.content : ""
      const from = Math.max(0, Math.min(Number(b.from) || 0, content.length))
      const to = Math.max(from, Math.min(Number(b.to) || 0, content.length))
      const instruction = requireString(b.instruction, "instruction", 4000)
      const ac = new AbortController()
      res.on("close", () => ac.abort())
      const send = sse(res)
      await stream(
        [
          { role: "system", content: EDIT_SYSTEM },
          {
            role: "user",
            content: editUser({
              path: file,
              before: content.slice(0, from),
              region: content.slice(from, to),
              after: content.slice(to),
              instruction,
              previous: typeof b.previous === "string" ? b.previous : undefined,
              projectNote: editNote(file),
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
      const b = await readJson(req)
      const spec: ServiceSpec = validateBuildSpec(requireObject(b.spec, "spec"))
      if (isBuilding(spec.id)) throw new HttpError(409, `${spec.name} is already being built`)
      const ac = new AbortController()
      res.on("close", () => ac.abort())
      const send = sse(res)
      await runBuild(spec, (e: BuildEvent) => send(e), ac.signal).catch((err) => send({ t: "error", message: String(err?.message ?? err) }))
      return res.end()
    }

    if (SERVE_UI && !url.pathname.startsWith("/api/") && serveUi(req, res, url.pathname)) return

    json(res, 404, { error: "not found" })
  } catch (err) {
    const e = err as Error & { code?: string }
    const status = err instanceof HttpError ? err.status : e.code === "ENOENT" ? 404 : e.message === "Path outside workspace" ? 403 : e.name === "AbortError" ? 499 : 500
    const message = e.code === "ENOENT" ? "File not found" : e.message
    if (status >= 500) console.error(`[kivo] ${req.method} ${url.pathname} failed:`, err)
    if (res.headersSent) {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ t: "error", message })}\n\n`)
        res.end()
      }
    } else json(res, status, { error: message })
  }
})

/** Read at most `max` bytes of a response body, then stop downloading. */
async function readCapped(r: Response, max: number) {
  if (!r.body) return ""
  const reader = r.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    size += value.length
    if (size >= max) {
      await reader.cancel().catch(() => {})
      break
    }
  }
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, max))
}

server.on("clientError", (_err, socket) => {
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n")
})

// ─── Terminal: persistent shells in the project workspace (see terminals.ts) ──

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost")
  // A WebSocket upgrade must come from the Kivo UI itself — browsers always send Origin here.
  if (url.pathname !== "/ws/terminal" || !hostOk(req) || !req.headers.origin || !originOk(req)) {
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => attachTerminal(ws, url))
})

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") console.error(`[kivo] port ${PORT} is already in use — is another Kivo daemon running? Set KIVO_DAEMON_PORT to use a different port.`)
  else console.error("[kivo] server error:", err)
  process.exit(1)
})

server.listen(PORT, "127.0.0.1", () => {
  const d = describe()
  console.log(`kivo daemon  http://127.0.0.1:${PORT}  project ${projectDir()}  active=${d.active}`)
  if (SERVE_UI) console.log(uiBuilt() ? `  ui      open http://localhost:${PORT}` : "  ui      not built — run `npm run build` first")
  for (const p of d.providers) console.log(`  ${p.id.padEnd(7)} ${p.status.padEnd(13)} ${p.message ?? p.models.join(", ")}`)
  allToolchains().then((t) => Object.values(t).forEach((s) => console.log(`  ${s.language.padEnd(7)} ${s.ok ? `ok            ${s.version ?? ""}` : `missing       ${s.message}`}`)))
})

/** Graceful shutdown: stop running services and shells so nothing is left holding ports. */
function shutdown(signal: string) {
  console.log(`[kivo] ${signal} — stopping services and shells`)
  stopAll()
  killAllTerminals()
  server.close()
  setTimeout(() => process.exit(0), 500).unref()
}
process.on("SIGINT", () => shutdown("SIGINT"))
process.on("SIGTERM", () => shutdown("SIGTERM"))
