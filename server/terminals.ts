import fs from "node:fs"
import path from "node:path"
import * as pty from "node-pty"
import type { WebSocket } from "ws"
import { cleanEnv } from "./pipeline"
import os from "node:os"
import { project, VENV } from "./workspace"

/**
 * Integrated terminal sessions. A session is a login shell in the project workspace that outlives
 * any one WebSocket: a page reload, a Vite hot reload or a dropped connection re-attaches to the
 * same shell and replays its recent output, like VS Code's terminal. Sessions end when the shell
 * exits, when the user closes the tab, or after sitting detached for DETACHED_TTL.
 *
 * Wire protocol (JSON text frames, both directions):
 *   client → { t: "input", d } | { t: "resize", cols, rows }
 *   server → { t: "ready", id, replay, title, exited? } | { t: "o", d } | { t: "title", title } | { t: "exit", code }
 */

const MAX_SESSIONS = 12
const REPLAY_BYTES = 256 * 1024
const DETACHED_TTL = 30 * 60_000
/** Pause the shell while the browser hasn't drained this much output, so `cat hugefile` can't exhaust memory. */
const HIGH_WATER = 1024 * 1024
const ID = /^[a-z0-9-]{8,40}$/

export interface TerminalInfo {
  id: string
  title: string
  pid: number
  cwd: string
  attached: boolean
  exited: boolean
  createdAt: number
}

class Session {
  readonly createdAt = Date.now()
  title: string
  exited: { code: number } | null = null
  private replay: string[] = []
  private replayBytes = 0
  private client: WebSocket | null = null
  private pending = ""
  private flushTimer: NodeJS.Timeout | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private paused = false

  constructor(
    readonly id: string,
    readonly shell: pty.IPty,
    readonly cwd: string,
    private onGone: (id: string) => void,
  ) {
    // Named after where it opened (the project), until the shell sets its own title.
    this.title = cwd === os.homedir() ? "~" : path.basename(cwd)
    shell.onData((d) => this.output(d))
    shell.onExit(({ exitCode }) => {
      this.exited = { code: exitCode }
      this.flush()
      this.send({ t: "exit", code: exitCode })
      // Keep the exited session briefly so a reconnecting tab can still show why it ended.
      this.scheduleIdle(60_000)
    })
    this.scheduleIdle(DETACHED_TTL)
  }

  info(): TerminalInfo {
    return { id: this.id, title: this.title, pid: this.shell.pid, cwd: this.cwd, attached: !!this.client, exited: !!this.exited, createdAt: this.createdAt }
  }

  attach(ws: WebSocket) {
    // One viewer per session: a newer tab (e.g. after reload) takes over from the stale one.
    if (this.client && this.client !== ws) this.client.close(4000, "attached elsewhere")
    this.client = ws
    this.clearIdle()
    this.flush()
    ws.send(JSON.stringify({ t: "ready", id: this.id, title: this.title, replay: this.replay.join(""), exited: this.exited?.code }))

    ws.on("message", (raw) => {
      let msg: { t?: string; d?: unknown; cols?: unknown; rows?: unknown }
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (this.exited) return
      try {
        if (msg.t === "input" && typeof msg.d === "string") this.shell.write(msg.d)
        else if (msg.t === "resize") {
          const cols = Number(msg.cols)
          const rows = Number(msg.rows)
          if (Number.isInteger(cols) && Number.isInteger(rows) && cols > 1 && rows > 1 && cols < 1000 && rows < 500) this.shell.resize(cols, rows)
        }
      } catch {
        // the shell exited between the check and the write; onExit reports it
      }
    })
    ws.on("close", () => {
      if (this.client !== ws) return
      this.client = null
      this.resume()
      this.scheduleIdle(this.exited ? 5_000 : DETACHED_TTL)
    })
    ws.on("error", () => ws.terminate())
  }

  kill() {
    this.clearIdle()
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.client?.close(1000, "closed")
    this.client = null
    if (!this.exited) {
      try {
        this.shell.kill()
      } catch {
        // already gone
      }
    }
  }

  private output(d: string) {
    this.replay.push(d)
    this.replayBytes += d.length
    while (this.replayBytes > REPLAY_BYTES && this.replay.length > 1) this.replayBytes -= this.replay.shift()!.length
    // Shells announce their title with OSC 0/2 (e.g. the running command); show it on the tab.
    const osc = /\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/g
    let m: RegExpExecArray | null
    let title: string | null = null
    while ((m = osc.exec(d))) title = m[1]
    if (title !== null && title !== this.title) {
      this.title = title.slice(0, 80)
      this.send({ t: "title", title: this.title })
    }
    if (!this.client) return
    // Coalesce bursts into one frame per few ms instead of one frame per pty read.
    this.pending += d
    if (this.pending.length > 64 * 1024) this.flush()
    else if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 4)
  }

  private flush() {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    if (!this.pending || !this.client) {
      this.pending = ""
      return
    }
    const ws = this.client
    this.send({ t: "o", d: this.pending })
    this.pending = ""
    if (!this.paused && ws.bufferedAmount > HIGH_WATER) {
      this.paused = true
      this.shell.pause()
      const wait = setInterval(() => {
        if (ws.readyState !== ws.OPEN || ws.bufferedAmount < HIGH_WATER / 4) {
          clearInterval(wait)
          this.resume()
        }
      }, 20)
    }
  }

  private resume() {
    if (!this.paused) return
    this.paused = false
    try {
      this.shell.resume()
    } catch {
      // exited
    }
  }

  private send(msg: unknown) {
    const ws = this.client
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
  }

  private scheduleIdle(ms: number) {
    this.clearIdle()
    this.idleTimer = setTimeout(() => {
      this.kill()
      this.onGone(this.id)
    }, ms)
    this.idleTimer.unref()
  }

  private clearIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }
}

const sessions = new Map<string, Session>()
const gone = (id: string) => sessions.delete(id)

function shellEnv() {
  const env = cleanEnv()
  // Kivo's build venv goes first on PATH only in the Kivo-managed demo; in the user's own
  // project it would shadow their python/pip, so their shell is left exactly as they set it up.
  if (project().managed) {
    env.VIRTUAL_ENV = VENV
    env.PATH = `${path.join(VENV, "bin")}:${env.PATH ?? "/usr/bin:/bin"}`
  }
  env.TERM = "xterm-256color"
  env.COLORTERM = "truecolor"
  env.TERM_PROGRAM = "Kivo"
  env.KIVO = "1"
  // A shell started from a GUI app may not have a UTF-8 locale, which breaks prompts and box drawing.
  if (!env.LANG) env.LANG = "en_US.UTF-8"
  return env as Record<string, string>
}

function defaultShell() {
  if (process.platform === "win32") return process.env.COMSPEC || "powershell.exe"
  return process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash")
}

export function listTerminals(): TerminalInfo[] {
  return [...sessions.values()].map((s) => s.info()).sort((a, b) => a.createdAt - b.createdAt)
}

export function killTerminal(id: string) {
  const s = sessions.get(id)
  if (!s) return false
  s.kill()
  sessions.delete(id)
  return true
}

export function killAllTerminals() {
  for (const s of sessions.values()) s.kill()
  sessions.clear()
}

/**
 * Attach a WebSocket to the session named in the URL, or start one. `?id=` re-attaches when that
 * session still exists (otherwise a fresh shell is started under the same id, and the client is told).
 */
export function attachTerminal(ws: WebSocket, url: URL) {
  const requested = url.searchParams.get("id")
  const id = requested && ID.test(requested) ? requested : crypto.randomUUID()
  const existing = sessions.get(id)
  if (existing) return existing.attach(ws)

  if (sessions.size >= MAX_SESSIONS) {
    ws.send(JSON.stringify({ t: "error", message: `Kivo allows ${MAX_SESSIONS} terminals at once — close one to open another.` }))
    return ws.close(4001, "too many terminals")
  }
  const cols = clamp(Number(url.searchParams.get("cols")), 2, 999, 100)
  const rows = clamp(Number(url.searchParams.get("rows")), 2, 499, 24)
  // It's the user's own shell on their own machine, so any existing folder is fine: "~", an absolute
  // path, or a path relative to the project (e.g. services/auth). Anything else starts in the project.
  const root = project().dir
  const sub = (url.searchParams.get("cwd") ?? "").replace(/^~(?=$|\/)/, os.homedir())
  const wanted = sub ? path.resolve(root, sub) : root
  const safeCwd = fs.statSync(wanted, { throwIfNoEntry: false })?.isDirectory() ? wanted : root

  let shell: pty.IPty
  try {
    const bin = defaultShell()
    shell = pty.spawn(bin, process.platform === "win32" ? [] : ["-l"], { name: "xterm-256color", cols, rows, cwd: safeCwd, env: shellEnv() })
  } catch (err) {
    ws.send(JSON.stringify({ t: "error", message: `Kivo couldn't start a shell: ${(err as Error).message}` }))
    return ws.close(4002, "spawn failed")
  }
  const session = new Session(id, shell, safeCwd, gone)
  sessions.set(id, session)
  session.attach(ws)
}

function clamp(n: number, min: number, max: number, fallback: number) {
  return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : fallback
}
