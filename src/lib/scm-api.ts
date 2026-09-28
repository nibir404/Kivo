/** Client for the daemon's source-control routes (/api/scm/*). Types mirror server/scm.ts. */
import { sse } from "./api"

export interface FileChange {
  path: string
  orig?: string
  /** M A D R C T, U = conflict, ? = untracked. */
  status: string
  code: string
}

export interface RepoStatus {
  repo: true
  branch: string | null
  detached: boolean
  oid: string | null
  upstream: string | null
  ahead: number
  behind: number
  staged: FileChange[]
  unstaged: FileChange[]
  untracked: FileChange[]
  conflicted: FileChange[]
}

export type StatusResult = RepoStatus | { repo: false }

export type DiffKind = "working" | "staged" | "commit"

export interface DiffContent {
  path: string
  originalPath?: string
  original: string
  modified: string
  binary?: boolean
  tooLarge?: boolean
  editable: boolean
  originalLabel: string
  modifiedLabel: string
}

export interface Branch {
  name: string
  remote: boolean
  current: boolean
  hash: string
  upstream?: string
  date: string
}

export interface Commit {
  hash: string
  short: string
  subject: string
  author: string
  date: string
}

export interface CommitDetail extends Commit {
  body: string
  parent?: string
  files: FileChange[]
}

export type RemoteOp = "fetch" | "pull" | "push" | "sync"

async function request<T>(method: "GET" | "POST", route: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/scm/${route}`, method === "POST" ? { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) } : undefined)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? `Source control request failed (HTTP ${res.status})`)
  return data as T
}

const qs = (params: Record<string, string | undefined>) => new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => !!e[1])).toString()

export const scm = {
  status: () => request<StatusResult>("GET", "status"),
  diff: (kind: DiffKind, path: string, ref?: string) => request<DiffContent>("GET", `diff?${qs({ kind, path, ref })}`),
  branches: () => request<{ branches: Branch[] }>("GET", "branches").then((r) => r.branches),
  log: () => request<{ commits: Commit[] }>("GET", "log").then((r) => r.commits),
  commit: (ref: string) => request<CommitDetail>("GET", `commit?${qs({ ref })}`),
  init: () => request("POST", "init"),
  stage: (paths: string[] | "all") => request("POST", "stage", { paths }),
  unstage: (paths: string[] | "all") => request("POST", "unstage", { paths }),
  /** Only call after the user has confirmed. */
  discard: (paths: string[]) => request<{ restored: string[]; trashed: string[] }>("POST", "discard", { paths, confirm: true }),
  commitChanges: (message: string, all: boolean) => request<{ hash: string }>("POST", "commit", { message, all }),
  checkout: (branch: string) => request("POST", "checkout", { branch }),
  createBranch: (name: string) => request<{ name: string }>("POST", "branch", { name }),
  /** Streams git's output line by line; rejects with git's (explained) error. */
  remote: (op: RemoteOp, onLine: (line: string) => void, signal?: AbortSignal) => sse<{ t: string; line?: string }>("/api/scm/remote", { op }, (e) => e.line && onLine(e.line), signal),
  /** Streams a generated commit message; resolves with the cleaned-up final text. */
  commitMessage: async (onText: (text: string) => void, signal?: AbortSignal) => {
    let text = ""
    let final = ""
    await sse<{ t: string; text?: string; message?: string }>(
      "/api/scm/commit-message",
      {},
      (e) => {
        if (e.t === "delta" && e.text) onText((text += e.text))
        if (e.t === "done") final = e.message ?? text
      },
      signal,
    )
    return final || text
  },
}

/** Diff tab paths: diff://working/<path>, diff://staged/<path>, diff://commit/<hash>/<path>. */
export function diffTabPath(kind: DiffKind, path: string, ref?: string) {
  return kind === "commit" ? `diff://commit/${ref}/${path}` : `diff://${kind}/${path}`
}

export function parseDiffTab(tab: string): { kind: DiffKind; path: string; ref?: string } | null {
  const m = /^diff:\/\/(working|staged|commit)\/(.+)$/.exec(tab)
  if (!m) return null
  const kind = m[1] as DiffKind
  if (kind !== "commit") return { kind, path: m[2] }
  const i = m[2].indexOf("/")
  return i > 0 ? { kind, ref: m[2].slice(0, i), path: m[2].slice(i + 1) } : null
}
