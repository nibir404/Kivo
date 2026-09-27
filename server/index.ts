import http from "node:http"
import path from "node:path"
import * as pty from "node-pty"
import { WebSocketServer } from "ws"
import type { ServiceSpec } from "../src/core/types"
import { aiAvailable, checkAll, currentModel, describe, parseJsonLoose, setActive, stream, type Msg } from "./ai"
import { bus } from "./bus"
import { HttpError, json, readJson, requireObject, requireString, sse } from "./http"
import { cleanEnv, isBuilding, runBuild, serviceUrl, stopAll, type BuildEvent } from "./pipeline"
import { chatSystem, EDIT_SYSTEM, editUser, INTENT_SYSTEM, intentUser } from "./prompts"
import { normalizeSpec, parseServices, projectContext, resolveStack, sanitizeStack, validateBuildSpec } from "./spec"
import { allToolchains } from "./toolchains"
import { analyze, ensureWorkspace, git, listFiles, PROJECT, PROJECT_DIR, readFile, VENV, writeFile } from "./workspace"

/**
 * Kivo daemon — local only. Binds to 127.0.0.1 and rejects requests from any origin
 * other than the Kivo UI, so a web page can't reach the terminal or the filesystem.
 *
 * Robustness rules: every input is validated (4xx, never a crash), every child process and
 * outbound request has an error path and a timeout, and shutdown stops what Kivo started.
 */

const PORT = Number(process.env.KIVO_DAEMON_PORT ?? 5175)
const ALLOWED = new Set(["http://localhost:5174", "http://127.0.0.1:5174", "http://localhost:4173", "http://127.0.0.1:4173"])
const PROXY_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])

// A bug in one request must never take down the terminal, running services and other builds with it.
process.on("unhandledRejection", (err) => console.error("[kivo] unhandled rejection:", err))
process.on("uncaughtException", (err) => console.error("[kivo] uncaught exception:", err))

await ensureWorkspace()
await checkAll()

const originOk = (req: http.IncomingMessage) => !req.headers.origin || ALLOWED.has(req.headers.origin)

/** Editor language note for inline edits, from the file being edited rather than a fixed assumption. */
function editNote(file: string) {
  const ext = path.extname(file).slice(1)
  const lang = { py: "Python 3.9 (typing.Optional, no X | Y unions)", ts: "TypeScript", tsx: "TypeScript + React", js: "JavaScript", java: "Java", kt: "Kotlin", go: "Go", rs: "Rust", sql: "SQL" }[ext]
  return `Project: ${PROJECT}. ${lang ? `This file is ${lang}.` : ""}`.trim()
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost")
  if (!originOk(req)) return json(res, 403, { error: "origin not allowed" })

  try {
    if (url.pathname === "/api/health") return json(res, 200, { ...describe(), ai: aiAvailable(), model: currentModel(), project: PROJECT, toolchains: await allToolchains() })

    if (url.pathname === "/api/providers" && req.method === "GET") return json(res, 200, await checkAll())

    if (url.pathname === "/api/providers/active" && req.method === "POST") {
      const b = await readJson(req)
      return json(res, 200, setActive(requireString(b.id, "id", 40)))
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

    if (url.pathname === "/api/git/log") {
      const { stdout } = await git(["log", "--stat", "--format=%h%x09%s%x09%ar", "-n", "15"])
      return json(res, 200, { log: stdout })
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
      if (b.headers && typeof b.headers === "object") for (const [k, v] of Object.entries(b.headers)) if (typeof v === "string") headers[k] = v
      const started = performance.now()
      try {
        const r = await fetch(base + target, {
          method,
          headers,
          body: ["GET", "HEAD"].includes(method) || typeof b.body !== "string" ? undefined : b.body,
          signal: AbortSignal.timeout(30_000),
        })
        const text = (await r.text()).slice(0, 2_000_000)
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

server.on("clientError", (_err, socket) => {
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n")
})

// ─── Terminal: a real shell in the project workspace ─────────────────────────

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })
const terminals = new Set<pty.IPty>()

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
    let shell: pty.IPty
    try {
      shell = pty.spawn(process.env.SHELL || "/bin/zsh", ["-l"], { name: "xterm-256color", cols: 100, rows: 24, cwd: PROJECT_DIR, env: env as Record<string, string> })
    } catch (err) {
      ws.send(`\r\nKivo couldn't start a shell: ${(err as Error).message}\r\n`)
      ws.close()
      return
    }
    terminals.add(shell)
    shell.onData((d) => ws.readyState === ws.OPEN && ws.send(d))
    shell.onExit(() => {
      terminals.delete(shell)
      if (ws.readyState === ws.OPEN) ws.close()
    })
    ws.on("message", (raw) => {
      const msg = raw.toString()
      try {
        if (msg.startsWith("\u0000resize:")) {
          const [cols, rows] = msg.slice(8).split("x").map(Number)
          if (cols > 0 && rows > 0 && cols < 1000 && rows < 1000) shell.resize(cols, rows)
        } else shell.write(msg)
      } catch {
        // the shell already exited; the close handler cleans up
      }
    })
    ws.on("error", () => ws.terminate())
    ws.on("close", () => {
      terminals.delete(shell)
      try {
        shell.kill()
      } catch {
        // already gone
      }
    })
  })
})

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") console.error(`[kivo] port ${PORT} is already in use — is another Kivo daemon running? Set KIVO_DAEMON_PORT to use a different port.`)
  else console.error("[kivo] server error:", err)
  process.exit(1)
})

server.listen(PORT, "127.0.0.1", () => {
  const d = describe()
  console.log(`kivo daemon  http://127.0.0.1:${PORT}  workspace ${PROJECT_DIR}  active=${d.active}`)
  for (const p of d.providers) console.log(`  ${p.id.padEnd(7)} ${p.status.padEnd(13)} ${p.message ?? p.models.join(", ")}`)
  allToolchains().then((t) => Object.values(t).forEach((s) => console.log(`  ${s.language.padEnd(7)} ${s.ok ? `ok            ${s.version ?? ""}` : `missing       ${s.message}`}`)))
})

/** Graceful shutdown: stop running services and shells so nothing is left holding ports. */
function shutdown(signal: string) {
  console.log(`[kivo] ${signal} — stopping services and shells`)
  stopAll()
  for (const t of terminals) {
    try {
      t.kill()
    } catch {
      // already gone
    }
  }
  server.close()
  setTimeout(() => process.exit(0), 500).unref()
}
process.on("SIGINT", () => shutdown("SIGINT"))
process.on("SIGTERM", () => shutdown("SIGTERM"))
