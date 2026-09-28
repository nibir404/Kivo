import fs from "node:fs"
import type http from "node:http"
import path from "node:path"
import { WEB_DIST } from "../paths"

/**
 * Who may talk to the daemon, and serving the built UI (`npm start`).
 *
 * The daemon controls a shell and the filesystem, so two checks guard every request:
 *  - Host must be a loopback name. This defeats DNS rebinding, where a web page points its own
 *    hostname at 127.0.0.1: the browser then sends `Host: attacker.example`, which we refuse.
 *  - Origin, when present, must be the Kivo UI. Browsers always send it on cross-origin requests
 *    and on WebSocket upgrades, so another site can't drive the API or the terminal.
 */

export const PORT = Number(process.env.KIVO_DAEMON_PORT ?? 5175)
const UI_PORT = Number(process.env.KIVO_UI_PORT ?? 5174)
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"])
const PORTS = new Set([PORT, UI_PORT, 4173])

const ORIGINS = new Set(
  [...PORTS].flatMap((p) => [`http://localhost:${p}`, `http://127.0.0.1:${p}`]).concat(
    (process.env.KIVO_UI_ORIGINS ?? "")
      .split(",")
      .map((o) => o.trim().replace(/\/$/, ""))
      .filter(Boolean),
  ),
)

export function hostOk(req: http.IncomingMessage) {
  const host = req.headers.host
  if (!host) return false
  try {
    const u = new URL(`http://${host}`)
    return LOOPBACK.has(u.hostname)
  } catch {
    return false
  }
}

export const originOk = (req: http.IncomingMessage) => !req.headers.origin || ORIGINS.has(req.headers.origin)

// ─── Built UI ────────────────────────────────────────────────────────────────

const DIST = WEB_DIST
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
}

/** Hardening for every page the daemon serves. Inline styles are needed by the UI libraries; scripts are not. */
export const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws://localhost:* ws://127.0.0.1:*; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
}

export const uiBuilt = () => fs.existsSync(path.join(DIST, "index.html"))

/** Serve dist/ with an SPA fallback. Returns false when the request isn't for the UI. */
export function serveUi(req: http.IncomingMessage, res: http.ServerResponse, pathname: string) {
  if (req.method !== "GET" && req.method !== "HEAD") return false
  let rel: string
  try {
    rel = decodeURIComponent(pathname)
  } catch {
    return false
  }
  let file = path.resolve(DIST, "." + rel)
  if (file !== DIST && !file.startsWith(DIST + path.sep)) return false
  let stat = fs.statSync(file, { throwIfNoEntry: false })
  if (!stat?.isFile()) {
    // Client-side routes get the app; a missing asset is a real 404.
    if (path.extname(rel)) return false
    file = path.join(DIST, "index.html")
    stat = fs.statSync(file, { throwIfNoEntry: false })
    if (!stat?.isFile()) return false
  }
  const hashed = file.startsWith(path.join(DIST, "assets") + path.sep)
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream",
    "Content-Length": stat.size,
    // Vite fingerprints assets, so they can be cached forever; index.html must always be fresh.
    "Cache-Control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
  })
  if (req.method === "HEAD") res.end()
  else fs.createReadStream(file).on("error", () => res.destroy()).pipe(res)
  return true
}
