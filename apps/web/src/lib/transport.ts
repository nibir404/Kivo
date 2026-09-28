/**
 * Where the UI's /api requests go.
 *
 * - "daemon": the Kivo daemon on this machine (`npm run dev` / `npm start` on localhost) — the full
 *   system: your real files, terminal, git, builds.
 * - "browser": no daemon (the hosted web app). Requests are answered inside the page by the browser
 *   backend (src/backend): the same API over browser storage, a folder you pick (File System Access),
 *   and Groq called directly with your own key. Anything that needs a shell says so.
 *
 * The choice is made once at startup from the host: localhost means a daemon; anywhere else the
 * page is the whole app. `?backend=browser` (remembered) forces browser mode locally for testing,
 * `?backend=daemon` undoes it.
 */

export type BackendMode = "daemon" | "browser"

type Handler = (req: Request) => Promise<Response>

let handler: Handler | null = null
let loading: Promise<Handler> | null = null

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])
const PREF = "kivo.backend"

function chooseMode(): BackendMode {
  const param = new URLSearchParams(location.search).get("backend")
  try {
    if (param === "browser" || param === "daemon") localStorage.setItem(PREF, param)
    const pref = localStorage.getItem(PREF)
    if (pref === "browser" || pref === "daemon") return pref
  } catch {
    // storage blocked: fall through to the host rule
  }
  return LOCAL_HOSTS.has(location.hostname) ? "daemon" : "browser"
}

export const backendMode: BackendMode = typeof location === "undefined" ? "daemon" : chooseMode()
export const inBrowser = backendMode === "browser"

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
