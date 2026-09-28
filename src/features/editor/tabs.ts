import { toast } from "sonner"
import { isDiffTab } from "@/features/scm/DiffView"
import { api, subscribe } from "@/lib/api"
import { editorApi } from "@/lib/editor-api"
import { openFile, refreshFiles } from "@/state/runners"
import { useKivo } from "@/state/store"
import { under, useEditor } from "./store"

/**
 * Keeps editor tabs in step with the disk: renames and deletes from the explorer, and changes
 * made outside the editor (the agent, a terminal, another app) arriving through the daemon's
 * file watcher. Operates on the app store's openFiles / fileCache / activeFile.
 */

const K = () => useKivo.getState()

export const isDirty = (path: string) => {
  const f = K().fileCache[path]
  return !!f && f.content !== f.saved
}

/** Open a file and put the cursor on a position (search results, go to symbol). */
export async function openAt(path: string, line: number, col = 0, len = 0) {
  await openFile(path)
  if (line >= 1 && K().activeFile === path) useEditor.getState().revealAt({ path, line, col, len })
}

/** Tabs follow a renamed/moved file or folder, keeping unsaved edits. */
export function renameOpen(from: string, to: string) {
  const moved = (p: string) => (under(p, from) ? to + p.slice(from.length) : p)
  useKivo.setState((s) => ({
    openFiles: s.openFiles.map(moved),
    activeFile: s.activeFile ? moved(s.activeFile) : null,
    fileCache: Object.fromEntries(Object.entries(s.fileCache).map(([p, f]) => [moved(p), f])),
  }))
  useEditor.getState().remap(from, to)
}

/** Close every tab at or under a path (after it was moved to the trash). */
export function closeUnder(path: string) {
  for (const p of K().openFiles.filter((f) => under(f, path))) K().closeFile(p)
  useEditor.setState((s) => ({ recent: s.recent.filter((p) => !under(p, path)), conflicts: s.conflicts.filter((p) => !under(p, path)) }))
}

/** Replace a buffer with what's on disk (both the text and the saved baseline). */
export function setFromDisk(path: string, content: string) {
  useKivo.setState((s) => (s.fileCache[path] ? { fileCache: { ...s.fileCache, [path]: { content, saved: content } } } : {}))
  useEditor.getState().setConflict(path, false)
}

/**
 * Re-read open files that changed on disk. Clean buffers just update; a buffer with unsaved edits
 * is left alone and flagged, and the editor offers "reload / keep mine".
 */
export async function syncOpenFiles(changed?: string[]) {
  const s = K()
  const affected = s.openFiles.filter((p) => !isDiffTab(p) && s.fileCache[p] && (!changed || changed.some((c) => under(p, c))))
  await Promise.all(
    affected.map(async (p) => {
      let disk: string
      try {
        disk = (await api.read(p)).content
      } catch {
        return // gone or unreadable right now (e.g. mid atomic-save) — keep the buffer as it is
      }
      const f = K().fileCache[p]
      if (!f || disk === f.saved) return
      if (f.content === f.saved) setFromDisk(p, disk)
      else if (disk !== f.content) {
        if (!useEditor.getState().conflicts.includes(p))
          toast.warning(`${p.split("/").pop()} changed on disk`, {
            id: `conflict:${p}`,
            description: "You have unsaved edits in it. Reload to take the disk version, or keep yours and save over it.",
            action: { label: "Reload", onClick: () => void reloadFromDisk(p) },
            duration: 10_000,
          })
        useEditor.getState().setConflict(p, true)
      }
      else useKivo.setState((st) => ({ fileCache: { ...st.fileCache, [p]: { content: disk, saved: disk } } }))
    }),
  )
}

/** "Keep mine": treat the disk version as seen, so saving overwrites it and the notice goes away. */
export async function keepMine(path: string) {
  try {
    const disk = (await api.read(path)).content
    useKivo.setState((s) => (s.fileCache[path] ? { fileCache: { ...s.fileCache, [path]: { ...s.fileCache[path], saved: disk } } } : {}))
  } catch {
    // deleted on disk: saving will recreate it
  }
  useEditor.getState().setConflict(path, false)
}

export async function reloadFromDisk(path: string) {
  try {
    setFromDisk(path, (await api.read(path)).content)
  } catch (err) {
    toast.error(`Couldn't reload ${path}`, { description: (err as Error).message })
  }
}

/** Refresh the explorer's file list. Empty folders follow (see startFsWatch). */
export async function refreshTree() {
  await refreshFiles().catch(() => {})
}

/** Empty folders, which a file list can't show — re-read whenever the file list is replaced. */
async function refreshDirs() {
  if (!K().daemon) return
  try {
    useEditor.getState().setEmptyDirs(await editorApi.dirs())
  } catch {
    // daemon restarting; the next file-list refresh tries again
  }
}

let watching = false

/** Listen for the daemon's file-watcher events (once per page). */
export function startFsWatch() {
  if (watching) return
  watching = true
  let pending: Set<string> | null = null
  let all = false
  let timer: ReturnType<typeof setTimeout> | null = null
  subscribe((e) => {
    if (e.t !== "fs") return
    const paths = Array.isArray(e.paths) ? (e.paths as string[]) : []
    if (!paths.length || e.overflow) all = true
    pending ??= new Set()
    for (const p of paths) pending.add(p)
    // The daemon already debounces; this coalesces bursts that straddle its window.
    timer ??= setTimeout(() => {
      const changed = all ? undefined : [...pending!]
      pending = null
      all = false
      timer = null
      void refreshTree()
      void syncOpenFiles(changed)
    }, 100)
  })
  // Any new file list (a refresh, another project opened, reconnect) also re-reads empty folders.
  let dirsTimer: ReturnType<typeof setTimeout> | null = null
  useKivo.subscribe((st, prev) => {
    if (st.files === prev.files && st.daemon === prev.daemon) return
    if (dirsTimer) clearTimeout(dirsTimer)
    dirsTimer = setTimeout(refreshDirs, 50)
  })
  void refreshDirs()
}
