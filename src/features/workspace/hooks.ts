import { useMemo } from "react"
import { create } from "zustand"
import { persist } from "zustand/middleware"
import { useShallow } from "zustand/react/shallow"
import { ask } from "@/state/runners"
import { useKivo } from "@/state/store"
import { useUi } from "@/shell/capture"
import type { Cell, SectionData, SectionDef, WorkspaceDef, WsContext } from "./model"

/** Everything a workspace derives its sections from, read from the main store. */
export function useWsContext(): WsContext {
  const s = useKivo(
    useShallow((k) => ({
      project: k.project,
      files: k.files,
      analysis: k.analysis,
      services: k.services,
      nodes: k.nodes,
      edges: k.edges,
      traces: k.traces,
      logs: k.logs,
      runtimeLive: k.runtimeLive,
    })),
  )
  return s
}

/** Build every section once per context change; a failing section shows its error instead of breaking the page. */
export function useSections(def: WorkspaceDef, ctx: WsContext) {
  return useMemo(
    () =>
      def.sections.map((section) => {
        let data: SectionData
        try {
          data = section.build(ctx)
        } catch (err) {
          data = { source: "example", note: `Couldn't read this section: ${(err as Error).message}`, panels: [] }
        }
        return { section, data }
      }),
    [def, ctx],
  )
}

/** Checklist ticks, per workspace + section + item. Stored in this browser only. */
export const useChecks = create<{ done: Record<string, boolean>; toggle: (key: string) => void }>()(
  persist(
    (set) => ({
      done: {},
      toggle: (key) => set((s) => ({ done: { ...s.done, [key]: !s.done[key] } })),
    }),
    { name: "kivo:workspace-checks" },
  ),
)

const cellText = (c: Cell) => (typeof c === "object" ? c.text : String(c))

/** A compact text form of a section, so an AI answer is grounded in what's on screen. */
export function digest(section: SectionDef, data: SectionData) {
  const lines: string[] = [`${section.label} (${data.source === "project" ? "from this project" : data.source === "example" ? "example data — nothing detected yet" : "checklist"})`]
  if (data.note) lines.push(data.note)
  for (const p of data.panels) {
    if (p.kind === "table") {
      lines.push(p.columns.map((c) => c.label || "·").join(" | "))
      for (const r of p.rows.slice(0, 30)) lines.push(p.columns.map((c) => (r[c.key] === undefined ? "" : cellText(r[c.key]))).join(" | "))
    } else if (p.kind === "metrics") {
      for (const t of p.tiles) lines.push(`${t.label}: ${t.value}${t.hint ? ` (${t.hint})` : ""}`)
      for (const c of p.charts) lines.push(`${c.title}: ${c.series.map((s) => `${s.name} ${s.points[0]} → ${s.points[s.points.length - 1]}`).join(", ")}`)
    } else if (p.kind === "board") {
      for (const col of p.columns) lines.push(`${col.title}: ${col.cards.map((c) => c.title).join("; ") || "none"}`)
    } else if (p.kind === "checklist") {
      for (const i of p.items.slice(0, 30)) lines.push(`- ${i.title}`)
    } else if (p.kind === "timeline") {
      for (const e of p.events.slice(0, 20)) lines.push(`${e.at} ${e.title}${e.detail ? ` — ${e.detail}` : ""}`)
    }
  }
  return lines.join("\n").slice(0, 4000)
}

/** Ask Kivo from a workspace: the question is framed with the workspace (and section) it came from. */
export function askInWorkspace(def: WorkspaceDef, text: string, section?: { def: SectionDef; data: SectionData }) {
  const where = section ? `${def.label} workspace › ${section.def.label}` : `${def.label} workspace`
  const context = `The user is in Kivo's ${where}.${section ? `\nWhat Kivo shows in this section:\n${digest(section.def, section.data)}` : ""}`
  void ask(`${where} — ${text}`, null, context)
  useKivo.getState().setContextTab("ai")
  useUi.getState().openRight()
}
