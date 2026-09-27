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

export interface Health {
  ai: boolean
  model: string
  project: string
  active: string
  providers: ProviderInfo[]
  /** Per-language build readiness on this machine (only languages Kivo can build). */
  toolchains?: Record<string, { language: string; ok: boolean; version?: string; message?: string }>
}

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `${res.status} ${url}`)
  return res.json()
}

export const api = {
  health: () => get<Health>("/api/health"),
  project: () => get<import("@/core/types").ProjectAnalysis & { files: string[] }>("/api/project"),
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

/** POST and consume a server-sent event stream. Resolves when the stream ends. */
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
      onEvent(event)
    }
  }
}

/** Subscribe to daemon-wide events (live service logs). Returns an unsubscribe function. */
export function subscribe(onEvent: (e: { t: string; [k: string]: unknown }) => void) {
  const es = new EventSource("/api/events")
  es.onmessage = (m) => onEvent(JSON.parse(m.data))
  return () => es.close()
}
