/** Client for the daemon's /api/editor routes (explorer file operations, find & replace in files). */

export interface SearchParams {
  query: string
  regex?: boolean
  caseSensitive?: boolean
  wholeWord?: boolean
  include?: string
  exclude?: string
  maxResults?: number
}

export interface SearchHit {
  line: number
  col: number
  len: number
  before: string
  text: string
  after: string
}

export interface SearchResult {
  files: { path: string; matches: SearchHit[] }[]
  total: number
  truncated: boolean
  engine: "rg" | "git" | "js"
}

export interface ReplaceParams extends SearchParams {
  replace: string
  paths?: string[]
  skip?: string[]
  dryRun?: boolean
}

export interface ReplaceResult {
  files: { path: string; count: number }[]
  total: number
}

async function post<T>(route: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`/api/editor/${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
  return data as T
}

export const editorApi = {
  dirs: async () => {
    const res = await fetch("/api/editor/dirs")
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return ((await res.json()) as { dirs: string[] }).dirs
  },
  create: (path: string, kind: "file" | "folder") => post<{ path: string }>("create", { path, kind }),
  rename: (from: string, to: string) => post<{ path: string }>("rename", { from, to }),
  duplicate: (path: string) => post<{ path: string }>("duplicate", { path }),
  trash: (path: string) => post<{ trashed: string }>("trash", { path }),
  reveal: (path: string) => post<{ ok: true }>("reveal", { path }),
  search: (p: SearchParams, signal?: AbortSignal) => post<SearchResult>("search", p, signal),
  replace: (p: ReplaceParams) => post<ReplaceResult>("replace", p),
}
