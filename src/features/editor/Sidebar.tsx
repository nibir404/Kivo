import { useEffect, useState } from "react"
import { create } from "zustand"
import { Files, GitBranch, Search } from "lucide-react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ScmPanel } from "@/features/scm/ScmPanel"
import { cn } from "@/lib/utils"
import { useKivo } from "@/state/store"
import { selectedText } from "./activeView"
import { Explorer } from "./Explorer"
import { Palette } from "./Palette"
import { SearchPanel } from "./SearchPanel"
import { useEditor, type SidebarView } from "./store"
import { startFsWatch } from "./tabs"

/** Code mode's sidebar: an activity row switching Explorer / Search / Source Control (remembered). */

const VIEWS: { id: SidebarView; label: string; keys: string; icon: typeof Files }[] = [
  { id: "explorer", label: "Explorer", keys: "⌘⇧E", icon: Files },
  { id: "search", label: "Search", keys: "⌘⇧F", icon: Search },
  { id: "scm", label: "Source Control", keys: "⌃⇧G", icon: GitBranch },
]

export function CodeSidebar() {
  const view = useEditor((s) => s.view)
  const setView = useEditor((s) => s.setView)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-0.5 border-b px-1.5 py-1" role="tablist" aria-label="Sidebar views">
        {VIEWS.map((v) => (
          <Tooltip key={v.id}>
            <TooltipTrigger asChild>
              <button
                role="tab"
                aria-selected={view === v.id}
                aria-label={v.label}
                onClick={() => (v.id === "search" ? useEditor.getState().focusSearch() : setView(v.id))}
                className={cn(
                  "flex h-7 flex-1 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground aria-selected:bg-accent aria-selected:text-foreground",
                )}
              >
                <v.icon className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {v.label} {v.keys}
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        {view === "explorer" && <Explorer />}
        {view === "search" && <SearchPanel />}
        {view === "scm" && (
          <div className="h-full min-h-0 overflow-auto">
            <ScmPanel />
          </div>
        )}
      </div>
    </div>
  )
}

/** Mounted copies of EditorGlobal; the first one is the leader that listens and renders. */
const useLeader = create<{ ids: number[] }>(() => ({ ids: [] }))
let nextId = 0

/**
 * Editor features that work from any mode: the file watcher, the Quick Open palette, and the
 * shortcuts that reach into Code mode (⌘P, ⌘⇧F, ⌘⇧E, ⌃⇧G, ⌃G, ⌘⇧O). Mounted by the navigator
 * and the code view (the navigator isn't mounted in the compact layout); only one copy is active.
 */
export function EditorGlobal() {
  const [id] = useState(() => ++nextId)
  const leader = useLeader((s) => s.ids[0] === id)
  const palette = useEditor((s) => s.palette)

  useEffect(() => {
    useLeader.setState((s) => ({ ids: [...s.ids, id] }))
    return () => useLeader.setState((s) => ({ ids: s.ids.filter((x) => x !== id) }))
  }, [id])

  useEffect(() => {
    if (!leader) return
    startFsWatch()
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey) return
      const k = e.key.toLowerCase()
      const mod = e.metaKey || e.ctrlKey
      const s = useKivo.getState()
      const ed = useEditor.getState()
      const toCode = () => s.mode !== "code" && s.setMode("code")
      if (mod && !e.shiftKey && k === "p") {
        e.preventDefault()
        ed.setPalette(ed.palette === "files" ? null : "files")
      } else if (mod && e.shiftKey && k === "f") {
        e.preventDefault()
        toCode()
        ed.focusSearch(selectedText())
      } else if (mod && e.shiftKey && k === "e") {
        e.preventDefault()
        toCode()
        ed.setView("explorer")
      } else if (e.ctrlKey && e.shiftKey && k === "g") {
        e.preventDefault()
        toCode()
        ed.setView("scm")
      } else if (e.ctrlKey && !e.shiftKey && !e.metaKey && k === "g" && s.mode === "code" && s.activeFile) {
        e.preventDefault()
        ed.setPalette("line")
      } else if (mod && e.shiftKey && k === "o" && s.mode === "code" && s.activeFile) {
        e.preventDefault()
        ed.setPalette("symbol")
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [leader])

  return leader && palette ? <Palette key={palette} /> : null
}
