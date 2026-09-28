import { useEffect } from "react"
import { create } from "zustand"
import { toast } from "sonner"
import { isDiffTab } from "@/features/scm/DiffView"
import { useEditor } from "@/features/editor/store"
import { isDirty } from "@/features/editor/tabs"
import { openFile } from "@/state/runners"
import { useKivo } from "@/state/store"
import { forgetViewState } from "./viewState"

/**
 * Tab actions: closing (with the unsaved-changes prompt), reopening, cycling, and the keyboard
 * shortcuts — ⌘W (also ⌃W, since browsers keep ⌘W), ⌘⇧T, ⌃Tab / ⌃⇧Tab, ⌥⌘→ / ⌥⌘←.
 */

/** "diff://working/app/x.py" → { kind: "working", path: "app/x.py" } */
export function parseDiffTab(tab: string) {
  const rest = tab.slice("diff://".length)
  const i = rest.indexOf("/")
  return { kind: i < 0 ? rest : rest.slice(0, i), path: i < 0 ? "" : rest.slice(i + 1) }
}

export function tabLabel(tab: string) {
  if (!isDiffTab(tab)) return tab.split("/").pop() ?? tab
  const { kind, path } = parseDiffTab(tab)
  const what = kind === "working" ? "Working Tree" : kind === "staged" ? "Staged" : kind === "commit" ? "Commit" : "Diff"
  return `${path.split("/").pop() || path} (${what})`
}

/** The file path behind a tab (a diff tab's file), for reveal / copy path. */
export const tabFile = (tab: string) => (isDiffTab(tab) ? parseDiffTab(tab).path : tab)

export const usePending = create<{ path: string | null; set: (p: string | null) => void }>((set) => ({ path: null, set: (path) => set({ path }) }))

export function doClose(path: string) {
  useEditor.getState().pushClosed(path)
  useEditor.getState().setConflict(path, false)
  forgetViewState(path)
  useKivo.getState().closeFile(path)
}

/** Close a tab; one with unsaved edits opens the save / don't save / cancel prompt instead. */
export function requestClose(path: string) {
  if (isDirty(path)) usePending.getState().set(path)
  else doClose(path)
}

/** Close several tabs at once. Tabs with unsaved edits stay open (no prompt storm). */
export function closeMany(paths: string[]) {
  const kept = paths.filter(isDirty)
  paths.filter((p) => !isDirty(p)).forEach(doClose)
  if (kept.length) toast(`Kept ${kept.length} tab${kept.length === 1 ? "" : "s"} with unsaved changes open`)
}

export async function reopenClosed() {
  const path = useEditor.getState().popClosed()
  if (!path) return
  if (isDiffTab(path)) useKivo.getState().openFile(path)
  else await openFile(path)
}

function cycle(delta: number) {
  const { openFiles, activeFile, setActiveFile } = useKivo.getState()
  if (openFiles.length < 2 || !activeFile) return
  const i = openFiles.indexOf(activeFile)
  setActiveFile(openFiles[(i + delta + openFiles.length) % openFiles.length])
}

/** Tab shortcuts, active whenever Code mode is on screen (with or without open tabs). */
export function useTabShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || (e.target as HTMLElement | null)?.closest?.(".xterm,[role=dialog]")) return
      const k = e.key.toLowerCase()
      const active = useKivo.getState().activeFile
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && k === "w" && active) {
        e.preventDefault()
        requestClose(active)
      } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && k === "t") {
        e.preventDefault()
        void reopenClosed()
      } else if (e.ctrlKey && !e.metaKey && e.key === "Tab") {
        e.preventDefault()
        cycle(e.shiftKey ? -1 : 1)
      } else if (e.metaKey && e.altKey && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
        e.preventDefault()
        cycle(e.key === "ArrowRight" ? 1 : -1)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])
}
