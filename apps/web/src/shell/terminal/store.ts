import { create } from "zustand"

/**
 * Terminal tabs. Each tab names a daemon-side session that outlives the page, so the ids are kept
 * in sessionStorage: a reload re-attaches to the same shells (with their scrollback) instead of
 * starting over. A fresh browser tab adopts sessions nobody is viewing.
 */

export type TerminalStatus = "connecting" | "open" | "reconnecting" | "exited" | "taken" | "error"

export interface TerminalTab {
  id: string
  title: string
  status: TerminalStatus
  exitCode?: number
  /** Workspace-relative directory the shell starts in. */
  cwd?: string
  /** Bumped to re-attach this view to its session (e.g. taking it over from another window). */
  epoch?: number
}

/** What a mounted session exposes to the toolbar and to "Run in terminal". */
export interface TerminalHandle {
  input: (data: string) => void
  focus: () => void
  clear: () => void
  isOpen: () => boolean
}

interface TerminalsState {
  tabs: TerminalTab[]
  active: string | null
  fontSize: number
  searchOpen: boolean
  /** Commands waiting for a session to connect. */
  queue: Record<string, string[]>
  hydrated: boolean
  hydrate: () => Promise<void>
  newTab: (cwd?: string) => string
  closeTab: (id: string) => void
  restart: (id: string) => void
  reattach: (id: string) => void
  setActive: (id: string) => void
  update: (id: string, patch: Partial<TerminalTab>) => void
  setFontSize: (n: number) => void
  setSearchOpen: (open: boolean) => void
  /** Type a command into the active terminal (starting one if needed). */
  run: (cmd: string) => void
  takeQueued: (id: string) => string[]
}

const KEY = "kivo-terminals"
const FONT_KEY = "kivo-terminal-font"
export const handles = new Map<string, TerminalHandle>()

const newId = () => crypto.randomUUID()

function persist(tabs: TerminalTab[], active: string | null) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ tabs: tabs.map(({ id, title, cwd }) => ({ id, title, cwd })), active }))
  } catch {
    // storage unavailable (private mode) — sessions just won't survive a reload
  }
}

function stored(): { tabs: TerminalTab[]; active: string | null } {
  try {
    const raw = JSON.parse(sessionStorage.getItem(KEY) ?? "null")
    if (raw && Array.isArray(raw.tabs)) {
      const tabs = raw.tabs
        .filter((t: unknown): t is TerminalTab => !!t && typeof (t as TerminalTab).id === "string")
        .map((t: TerminalTab) => ({ id: t.id, title: typeof t.title === "string" ? t.title : "shell", cwd: t.cwd, status: "connecting" as const }))
      return { tabs, active: tabs.some((t: TerminalTab) => t.id === raw.active) ? raw.active : (tabs[0]?.id ?? null) }
    }
  } catch {
    // corrupt entry — start clean
  }
  return { tabs: [], active: null }
}

function storedFont() {
  try {
    const n = Number(localStorage.getItem(FONT_KEY))
    return n >= 9 && n <= 24 ? n : 12.5
  } catch {
    return 12.5
  }
}

export const useTerminals = create<TerminalsState>((set, get) => {
  const commit = (tabs: TerminalTab[], active: string | null) => {
    set({ tabs, active })
    persist(tabs, active)
  }
  return {
    tabs: [],
    active: null,
    fontSize: storedFont(),
    searchOpen: false,
    queue: {},
    hydrated: false,

    async hydrate() {
      if (get().hydrated) return
      set({ hydrated: true })
      const saved = stored()
      if (saved.tabs.length) return commit(saved.tabs, saved.active)
      // New browser tab: pick up shells that are running but not shown anywhere.
      try {
        const res = await fetch("/api/terminals")
        if (res.ok) {
          const { terminals } = (await res.json()) as { terminals: { id: string; title: string; attached: boolean; exited: boolean }[] }
          const orphans = terminals.filter((t) => !t.attached && !t.exited)
          if (orphans.length) return commit(orphans.map((t) => ({ id: t.id, title: t.title, status: "connecting" })), orphans[0].id)
        }
      } catch {
        // daemon not up yet — a fresh shell will connect once it is
      }
      if (!get().tabs.length) get().newTab()
    },

    newTab(cwd) {
      const id = newId()
      commit([...get().tabs, { id, title: "shell", status: "connecting", cwd }], id)
      return id
    },

    closeTab(id) {
      handles.delete(id)
      fetch(`/api/terminals?id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {})
      const tabs = get().tabs
      const i = tabs.findIndex((t) => t.id === id)
      const rest = tabs.filter((t) => t.id !== id)
      const active = get().active === id ? (rest[Math.min(i, rest.length - 1)]?.id ?? null) : get().active
      commit(rest, active)
    },

    restart(id) {
      // Same slot in the tab strip, a brand-new shell behind it.
      fetch(`/api/terminals?id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {})
      handles.delete(id)
      const fresh = newId()
      const tabs = get().tabs.map((t) => (t.id === id ? { id: fresh, title: "shell", status: "connecting" as const, cwd: t.cwd } : t))
      commit(tabs, get().active === id ? fresh : get().active)
    },

    reattach(id) {
      set({ tabs: get().tabs.map((t) => (t.id === id ? { ...t, status: "connecting" as const, epoch: (t.epoch ?? 0) + 1 } : t)) })
    },

    setActive(id) {
      commit(get().tabs, id)
    },

    update(id, patch) {
      const tabs = get().tabs.map((t) => (t.id === id ? { ...t, ...patch } : t))
      set({ tabs })
      if ("title" in patch) persist(tabs, get().active)
    },

    setFontSize(n) {
      const fontSize = Math.max(9, Math.min(24, Math.round(n * 2) / 2))
      set({ fontSize })
      try {
        localStorage.setItem(FONT_KEY, String(fontSize))
      } catch {
        // ignore
      }
    },

    setSearchOpen: (searchOpen) => set({ searchOpen }),

    run(cmd) {
      let { active } = get()
      const tab = get().tabs.find((t) => t.id === active)
      // An exited or taken-over tab can't run anything — use a new shell rather than dropping the command.
      if (!active || !tab || tab.status === "exited" || tab.status === "taken" || tab.status === "error") active = get().newTab()
      else get().setActive(active)
      const h = handles.get(active)
      if (h?.isOpen()) {
        h.input(cmd + "\r")
        h.focus()
      } else set((s) => ({ queue: { ...s.queue, [active]: [...(s.queue[active] ?? []), cmd] } }))
    },

    takeQueued(id) {
      const q = get().queue[id] ?? []
      if (q.length) set((s) => ({ queue: { ...s.queue, [id]: [] } }))
      return q
    },
  }
})
