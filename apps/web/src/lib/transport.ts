/**
 * Where the UI's /api requests go.
 *
 * - "daemon": the Kivo daemon on this machine (`npm run dev` / `npm start` on localhost) — the full
 *   system: your real files, terminal, git, builds.
 * - "browser": no daemon (the hosted web app). Requests are answered inside the page by the browser
 *   backend (src/backend): the same API over browser storage, a folder you pick (File System Access),
 *   and Groq called directly with your own key. Anything that needs a shell says so.
 *
 * The choice is made once at startup (resolveBackend): the desktop app and localhost-with-a-daemon
 * use the daemon; a hosted site, or localhost when no daemon answers, runs in the page.
 * `?backend=browser` (remembered) forces browser mode locally for testing, `?backend=daemon` undoes it.
 */

export type BackendMode = "daemon" | "browser"

type Handler = (req: Request) => Promise<Response>

let handler: Handler | null = null
let loading: Promise<Handler> | null = null

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])
const PREF = "kivo.backend"

/** Set once by resolveBackend(), before the UI renders. */
export let backendMode: BackendMode = "daemon"
export let inBrowser = false
/** Browser mode because no daemon answered on this machine (rather than by choice or because the site is hosted). */
export let daemonMissing = false

/** The desktop app (Electron) always ships its own daemon. */
export const inDesktop = typeof window !== "undefined" && !!(window as { kivoDesktop?: unknown }).kivoDesktop

function forced(): BackendMode | null {
  const param = new URLSearchParams(location.search).get("backend")
  try {
    if (param === "browser" || param === "daemon") localStorage.setItem(PREF, param)
    const pref = localStorage.getItem(PREF)
    if (pref === "browser" || pref === "daemon") return pref
  } catch {
    // storage blocked: fall through to the host rule
  }
  return null
}

/** The Groq key is pasted into the app (hosted site, desktop app) rather than kept in a .env file. */
export const keyInApp = () => inBrowser || inDesktop

/** Is a Kivo daemon answering at this origin? (A static server answers /api/health with HTML, or 404.) */
export async function daemonAnswers(timeoutMs = 1500): Promise<boolean> {
  try {
    const r = await fetch("/api/health", { signal: AbortSignal.timeout(timeoutMs), cache: "no-store" })
    return r.ok && (r.headers.get("content-type") ?? "").includes("json")
  } catch {
    return false
  }
}

/**
 * Pick the backend before the UI renders:
 *  - `?backend=` (remembered) wins; the desktop app always has its daemon;
 *  - a hosted site (not localhost) is the whole app in the page;
 *  - on localhost, use the daemon if one answers. The dev daemon can start a little after the page,
 *    so it's asked a few times; if it still isn't there, Kivo runs in the browser instead of
 *    showing "offline", and offers to switch once the daemon appears (watchForDaemon).
 */
export async function resolveBackend(): Promise<BackendMode> {
  let mode = forced() ?? (inDesktop ? "daemon" : null)
  if (!mode && !LOCAL_HOSTS.has(location.hostname)) mode = "browser"
  if (!mode) {
    for (let i = 0; i < 3 && !mode; i++) if (await daemonAnswers(i ? 1200 : 800)) mode = "daemon"
    if (!mode) {
      mode = "browser"
      daemonMissing = true
    }
  }
  backendMode = mode
  inBrowser = mode === "browser"
  return mode
}

/** While running in the browser only because no daemon answered: call `found` once one does. */
export function watchForDaemon(found: () => void, everyMs = 5000): () => void {
  if (!daemonMissing) return () => {}
  let stopped = false
  const t = setInterval(async () => {
    if (!stopped && (await daemonAnswers())) {
      stopped = true
      clearInterval(t)
      found()
    }
  }, everyMs)
  return () => {
    stopped = true
    clearInterval(t)
  }
}

/** The browser backend, loaded on first use (it isn't needed, or downloaded, when a daemon is present). */
function local(): Promise<Handler> {
  if (handler) return Promise.resolve(handler)
  loading ??= import("@/backend").then((m) => (handler = m.createBackend()))
  return loading
}

/** fetch() for Kivo's API: to the daemon, or to the in-page backend. */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  if (!inBrowser || !path.startsWith("/api/")) return fetch(path, init)
  const h = await local()
  const req = new Request(new URL(path, location.origin), init)
  try {
    return await h(req)
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err
    return Response.json({ error: (err as Error).message }, { status: 500 })
  }
}

/** Kivo's event stream (project switches, file changes, service logs). */
export function openEvents(on: { message: (data: string) => void; open?: () => void; error?: () => void }): () => void {
  if (!inBrowser) {
    const es = new EventSource("/api/events")
    es.onmessage = (m) => on.message(m.data)
    es.onopen = () => on.open?.()
    es.onerror = () => on.error?.()
    return () => es.close()
  }
  let off: (() => void) | null = null
  let closed = false
  void import("@/backend/bus").then(({ bus }) => {
    if (closed) return
    off = bus.listen((e) => on.message(JSON.stringify(e)))
    on.open?.()
  })
  return () => {
    closed = true
    off?.()
  }
}
