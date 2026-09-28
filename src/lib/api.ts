/** Client for the local Kivo daemon (proxied by Vite at /api and /ws). */

export interface ProviderInfo {
  id: string
  label: string
  status: "ok" | "unauthorized" | "unreachable" | "unconfigured" | "unknown"
  message?: string
  models: string[]
  configured: boolean
  baseUrl: string
}

export interface ProjectInfo {
  id: string
  name: string
  /** Absolute path on this machine. */
  dir: string
  kind: "demo" | "local" | "git"
  /** Kivo's own demo: builds auto-commit and Kivo's Python venv is on the terminal's PATH. */
  managed: boolean
  remote?: string
  openedAt: number
}

export interface DirListing {
  path: string
  parent: string | null
  home: string
  git: boolean
  dirs: { name: string; path: string; git: boolean }[]
}

export interface Health {
  ai: boolean
  model: string
  project: string
  projectInfo?: ProjectInfo
  active: string
  providers: ProviderInfo[]
  /** Per-language build readiness on this machine (only languages Kivo can build). */
  toolchains?: Record<string, { language: string; ok: boolean; version?: string; message?: string }>
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
  return data as T
}

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `${res.status} ${url}`)
  return res.json()
}

export const api = {
  health: () => get<Health>("/api/health"),
  project: () => get<import("@/core/types").ProjectAnalysis & { files: string[]; project: ProjectInfo }>("/api/project"),
  projects: () => get<{ current: ProjectInfo; projects: ProjectInfo[]; cloneRoot: string; platform: string }>("/api/projects"),
  openProject: (path: string) => post<{ project: ProjectInfo }>("/api/projects/open", { path }),
  switchProject: (id: string) => post<{ project: ProjectInfo }>("/api/projects/switch", { id }),
  forgetProject: async (id: string) => {
    const res = await fetch(`/api/projects?id=${encodeURIComponent(id)}`, { method: "DELETE" })
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`)
  },
  /** Native folder picker (macOS). Resolves null when the user cancels. */
  pickFolder: () => post<{ path: string | null }>("/api/projects/pick", {}),
  dirs: (path: string) => get<DirListing>(`/api/projects/dirs?path=${encodeURIComponent(path)}`),
  tree: () => get<{ files: string[] }>("/api/fs/tree"),
  read: (path: string) => get<{ content: string }>(`/api/fs/read?path=${encodeURIComponent(path)}`),
  write: async (path: string, content: string) => {
    const res = await fetch("/api/fs/write", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, content }) })
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Couldn't save ${path} (HTTP ${res.status})`)
  },
  gitLog: () => get<{ log: string }>("/api/git/log"),
  providers: () => get<Omit<Health, "ai" | "project">>("/api/providers"),
  setProvider: async (id: string) => {
    const res = await fetch("/api/providers/active", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
    return data as Omit<Health, "ai" | "project">
  },
}

/**
 * POST and consume a server-sent event stream. Resolves when the stream ends. A `{ t: "error" }`
 * frame (the daemon failed after it had started streaming) rejects, so callers never mistake a
 * failed stream for an empty answer.
 */
export async function sse<E>(url: string, body: unknown, onEvent: (e: E) => void, signal?: AbortSignal) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal })
  if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`)
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i: number
    while ((i = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, i)
      buf = buf.slice(i + 2)
      const line = chunk.split("\n").find((l) => l.startsWith("data:"))
      if (!line) continue
      let event: E
      try {
        event = JSON.parse(line.slice(5))
      } catch {
        continue // a malformed frame is skipped, not fatal
      }
      const err = event as { t?: unknown; message?: unknown }
      if (err && err.t === "error") {
        await reader.cancel().catch(() => {})
        throw new Error(typeof err.message === "string" ? err.message : "The Kivo daemon reported an error")
      }
      onEvent(event)
    }
  }
}

/**
 * Subscribe to daemon-wide events (live service logs, project switches). Returns an unsubscribe
 * function. `onReconnect` runs when the stream comes back after a drop (e.g. the daemon restarted),
 * since events sent while it was down are lost.
 */
export function subscribe(onEvent: (e: { t: string; [k: string]: unknown }) => void, onReconnect?: () => void) {
  const es = new EventSource("/api/events")
  let dropped = false
  es.onerror = () => {
    dropped = true
  }
  es.onopen = () => {
    if (dropped) onReconnect?.()
    dropped = false
  }
  es.onmessage = (m) => {
    try {
      onEvent(JSON.parse(m.data))
    } catch {
      // one malformed frame shouldn't break the live log stream
    }
  }
  return () => es.close()
}
