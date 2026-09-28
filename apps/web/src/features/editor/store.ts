import { create } from "zustand"
import { persist } from "zustand/middleware"

/**
 * Editor-only UI state (Code mode): which sidebar view is showing, the explorer's expanded
 * folders, recently opened and recently closed files, and pending "go to this position"
 * requests. Kept apart from the app store so the editor can grow without touching it.
 */

export type SidebarView = "explorer" | "search" | "scm"
export type Palette = "files" | "line" | "symbol" | null

/** Where to put the cursor once a file is showing (from search results, go to line/symbol). */
export interface Reveal {
  path: string
  line: number
  /** 0-based column. */
  col: number
  len: number
  nonce: number
}

/** An inline input in the explorer: renaming an entry, or naming a new one inside a folder. */
export type TreeEdit = { kind: "rename"; path: string } | { kind: "new-file" | "new-folder"; dir: string } | null

interface EditorState {
  view: SidebarView
  setView: (v: SidebarView) => void
  /** Bumped to move focus into the find-in-files input. */
  searchFocusTick: number
  /** Text to seed find-in-files with (the editor selection when ⌘⇧F is pressed). */
  searchSeed: string | null
  focusSearch: (seed?: string) => void

  palette: Palette
  setPalette: (p: Palette) => void

  recent: string[]
  touchRecent: (path: string) => void
  closed: string[]
  pushClosed: (path: string) => void
  popClosed: () => string | undefined

  expanded: Record<string, boolean>
  setExpanded: (path: string, open: boolean) => void
  /** Open every ancestor folder of a path (reveal in explorer). */
  expandTo: (path: string) => void
  collapseAll: () => void
  /** The explorer row the user last clicked (targets for "new file", F2, delete). */
  selected: string | null
  select: (path: string | null) => void

  emptyDirs: string[]
  setEmptyDirs: (d: string[]) => void
  edit: TreeEdit
  setEdit: (e: TreeEdit) => void

  /** Dirty open files whose content changed on disk underneath them. */
  conflicts: string[]
  setConflict: (path: string, on: boolean) => void

  reveal: Reveal | null
  revealAt: (r: Omit<Reveal, "nonce">) => void
  clearReveal: () => void

  /** Remap paths after a rename/move (recent, closed, expanded, selection). */
  remap: (from: string, to: string) => void
}

const under = (p: string, root: string) => p === root || p.startsWith(`${root}/`)
const moved = (p: string, from: string, to: string) => (under(p, from) ? to + p.slice(from.length) : p)

export const useEditor = create<EditorState>()(
  persist(
    (set, get) => ({
      view: "explorer",
      setView: (view) => set({ view }),
      searchFocusTick: 0,
      searchSeed: null,
      focusSearch: (seed) => set((s) => ({ view: "search", searchFocusTick: s.searchFocusTick + 1, searchSeed: seed ?? null })),

      palette: null,
      setPalette: (palette) => set({ palette }),

      recent: [],
      touchRecent: (path) => set((s) => ({ recent: [path, ...s.recent.filter((p) => p !== path)].slice(0, 50) })),
      closed: [],
      pushClosed: (path) => set((s) => ({ closed: [...s.closed.filter((p) => p !== path), path].slice(-30) })),
      popClosed: () => {
        const closed = [...get().closed]
        const last = closed.pop()
        set({ closed })
        return last
      },

      expanded: {},
      setExpanded: (path, open) => set((s) => ({ expanded: { ...s.expanded, [path]: open } })),
      expandTo: (path) =>
        set((s) => {
          const expanded = { ...s.expanded }
          const segs = path.split("/")
          for (let i = 1; i < segs.length; i++) expanded[segs.slice(0, i).join("/")] = true
          return { expanded }
        }),
      collapseAll: () => set({ expanded: {} }),
      selected: null,
      select: (selected) => set({ selected }),

      emptyDirs: [],
      setEmptyDirs: (emptyDirs) => set({ emptyDirs }),
      edit: null,
      setEdit: (edit) => set({ edit }),

      conflicts: [],
      setConflict: (path, on) => set((s) => ({ conflicts: on ? [...new Set([...s.conflicts, path])] : s.conflicts.filter((p) => p !== path) })),

      reveal: null,
      revealAt: (r) => set({ reveal: { ...r, nonce: Date.now() } }),
      clearReveal: () => set({ reveal: null }),

      remap: (from, to) =>
        set((s) => ({
          recent: s.recent.map((p) => moved(p, from, to)),
          closed: s.closed.map((p) => moved(p, from, to)),
          conflicts: s.conflicts.map((p) => moved(p, from, to)),
          selected: s.selected ? moved(s.selected, from, to) : null,
          expanded: Object.fromEntries(Object.entries(s.expanded).map(([p, v]) => [moved(p, from, to), v])),
        })),
    }),
    {
      name: "kivo:editor",
      partialize: (s) => ({ view: s.view, recent: s.recent, expanded: s.expanded }),
    },
  ),
)

export { under }
