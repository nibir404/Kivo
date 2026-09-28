import { toast } from "sonner"
import { create } from "zustand"
import { api } from "@/lib/api"
import { diffTabPath, scm, type DiffKind, type StatusResult } from "@/lib/scm-api"
import { useKivo } from "@/state/store"

/**
 * Source-control state shared by the sidebar panel and diff tabs. `version` bumps whenever the
 * status actually changes, so open diffs know to reload their sides.
 */
interface ScmState {
  status: StatusResult | null
  error: string | null
  version: number
  /** A long-running action (commit, sync, checkout…) — disables conflicting buttons. */
  busy: string | null
  /** The commit message draft survives switching sidebar views. */
  message: string
  setMessage: (message: string) => void
  refresh: () => Promise<void>
  /** Run a mutation, toast its error, and refresh either way. */
  act: <T>(label: string, fn: () => Promise<T>) => Promise<T | undefined>
}

let inflight: Promise<void> | null = null

export const useScm = create<ScmState>((set, get) => ({
  status: null,
  error: null,
  version: 0,
  busy: null,
  message: "",
  setMessage: (message) => set({ message }),
  refresh: () => {
    // Coalesce: focus, poll and daemon events can all fire at once.
    inflight ??= scm
      .status()
      .then((status) => {
        const prev = get().status
        if (JSON.stringify(prev) !== JSON.stringify(status)) set((s) => ({ status, error: null, version: s.version + 1 }))
        else if (get().error) set({ error: null })
      })
      .catch((err: Error) => set({ error: err.message }))
      .finally(() => (inflight = null))
    return inflight
  },
  act: async (label, fn) => {
    set({ busy: label })
    try {
      return await fn()
    } catch (err) {
      toast.error(label, { description: (err as Error).message })
      return undefined
    } finally {
      set({ busy: null })
      await get().refresh()
    }
  },
}))

export const STATUS_LABEL: Record<string, string> = {
  M: "Modified",
  A: "Added",
  D: "Deleted",
  R: "Renamed",
  C: "Copied",
  T: "Type changed",
  U: "Conflict",
  "?": "Untracked",
}

/** Status letter colours, VS Code style: modified amber, added/untracked green, deleted/conflict red. */
export const STATUS_COLOR: Record<string, string> = {
  M: "text-warning",
  T: "text-warning",
  A: "text-success",
  "?": "text-success",
  R: "text-info",
  C: "text-info",
  D: "text-destructive",
  U: "text-destructive",
}

/**
 * After git rewrites files (discard, checkout, pull), reload any open editor tab that has no
 * unsaved edits, so the editor never shows stale content. Tabs with edits are left alone.
 */
export async function reloadOpenBuffers(only?: string[]) {
  const { fileCache, openFiles } = useKivo.getState()
  const targets = openFiles.filter((p) => !p.includes("://") && fileCache[p] && fileCache[p].content === fileCache[p].saved && (!only || only.includes(p)))
  await Promise.all(
    targets.map(async (p) => {
      try {
        const { content } = await api.read(p)
        const s = useKivo.getState()
        if (s.fileCache[p] && s.fileCache[p].content === s.fileCache[p].saved && s.fileCache[p].content !== content) {
          s.editFile(p, content)
          s.markSaved(p)
        }
      } catch {
        // deleted by the operation — the editor track decides what to do with the tab
      }
    }),
  )
}

/** Open a diff tab (the store's openFile, not the runner's — there's nothing on disk to read). */
export function openDiff(kind: DiffKind, path: string, ref?: string) {
  useKivo.getState().openFile(diffTabPath(kind, path, ref), "")
}
