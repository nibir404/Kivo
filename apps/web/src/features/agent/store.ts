import { create } from "zustand"
import type { Todo } from "@/lib/agent-api"

/** Something attached to a message with @: a file, the open editor file, or the code selection. */
export type Mention = { kind: "file"; path: string } | { kind: "open"; path: string } | { kind: "selection"; label: string; text: string }

export interface EditProposal {
  path: string
  original: string
  proposed: string
  isNew: boolean
  status: "pending" | "applied" | "rejected" | "error" | "expired"
  message?: string
  busy?: boolean
}

export interface CommandRun {
  command: string
  cwd: string
  auto: boolean
  status: "pending" | "running" | "done" | "denied" | "killed" | "timeout" | "expired"
  output: string
  code?: number | null
  busy?: boolean
}

export type AgentItem =
  | { kind: "user"; id: string; text: string; mentions: string[] }
  | { kind: "assistant"; id: string; text: string; reasoning: string; streaming: boolean }
  | { kind: "tool"; id: string; name: string; summary: string; status: "running" | "done" | "error"; result?: string; detail?: string; edit?: EditProposal; command?: CommandRun }
  | { kind: "notice"; id: string; text: string; tone: "info" | "error" }

interface AgentState {
  mode: "ask" | "agent"
  items: AgentItem[]
  todos: Todo[]
  runId: string | null
  running: boolean
  /** Rate-limit status line while the loop waits for the provider. */
  waiting: string | null
  tokens: number
  model: string | null
  /** Apply edits without review. Off by default; not persisted, so every session starts safe. */
  autoApply: boolean
  /** Commands the user chose to "always allow" — exact strings, this browser session only. */
  allow: string[]
  /** Final user/assistant texts, sent as history so follow-ups have context. */
  transcript: { role: "user" | "assistant"; content: string }[]
  setMode: (m: "ask" | "agent") => void
  setAutoApply: (v: boolean) => void
  patchTool: (id: string, patch: (t: Extract<AgentItem, { kind: "tool" }>) => Partial<Extract<AgentItem, { kind: "tool" }>>) => void
}

export const useAgent = create<AgentState>()((set) => ({
  mode: "ask",
  items: [],
  todos: [],
  runId: null,
  running: false,
  waiting: null,
  tokens: 0,
  model: null,
  autoApply: false,
  allow: [],
  transcript: [],
  setMode: (mode) => set({ mode }),
  setAutoApply: (autoApply) => set({ autoApply }),
  patchTool: (id, patch) => set((s) => ({ items: s.items.map((i) => (i.kind === "tool" && i.id === id ? { ...i, ...patch(i) } : i)) })),
}))
