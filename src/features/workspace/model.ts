import type { LucideIcon } from "lucide-react"
import type { Discipline, LogLine, ProjectAnalysis, ServiceSpec, SystemEdge, SystemNode, Trace } from "@/core/types"

/**
 * A workspace is a lens over the same project: its own sections, home screen, vocabulary and
 * accent, computed from what Kivo knows (files, detections, services, the system graph, runtime).
 *
 * Every section says where its content came from, so nothing invented is passed off as real:
 *   project — derived from this repository or its running services (evidence shown)
 *   example — nothing matching was found yet; illustrative data, labelled as such
 *   guide   — a checklist of good practice for this discipline (the user ticks items off)
 */

export interface WsContext {
  project: string
  files: string[]
  analysis: ProjectAnalysis
  services: ServiceSpec[]
  nodes: SystemNode[]
  edges: SystemEdge[]
  traces: Trace[]
  logs: LogLine[]
  runtimeLive: boolean
}

export type Tone = "good" | "warn" | "bad" | "info" | "neutral"
export type Cell = string | number | { text: string; tone?: Tone; mono?: boolean; sub?: string }

export interface TablePanel {
  kind: "table"
  title?: string
  columns: { key: string; label: string; align?: "right"; mono?: boolean }[]
  rows: Record<string, Cell>[]
  empty?: string
}

export interface ChartSeries {
  name: string
  points: number[]
}

export interface Chart {
  title: string
  /** Formats y values (tooltips, axis). */
  unit?: string
  /** What one step on the x axis is ("epoch", "episode", "min"). */
  x: string
  series: ChartSeries[]
  /** A horizontal reference line (target, SLO, budget). */
  target?: { value: number; label: string }
}

export interface MetricsPanel {
  kind: "metrics"
  title?: string
  tiles: { label: string; value: string; hint?: string; tone?: Tone }[]
  charts: Chart[]
}

export interface BoardPanel {
  kind: "board"
  title?: string
  columns: { title: string; tone?: Tone; cards: { title: string; meta?: string; tone?: Tone }[] }[]
}

export interface ChecklistPanel {
  kind: "checklist"
  title?: string
  /** Ids are stable, so ticks persist across sessions. */
  items: { id: string; title: string; detail?: string; group?: string }[]
}

export interface TimelinePanel {
  kind: "timeline"
  title?: string
  events: { at: string; title: string; detail?: string; tone?: Tone }[]
}

export type Panel = TablePanel | MetricsPanel | BoardPanel | ChecklistPanel | TimelinePanel

export interface SectionData {
  source: "project" | "example" | "guide"
  /** Files or components the content was derived from. */
  evidence?: string[]
  /** One line shown under the title (e.g. what's missing, what to add). */
  note?: string
  /** A short count for the navigator and the section card. */
  count?: number
  panels: Panel[]
}

export interface SectionDef {
  id: string
  label: string
  icon: LucideIcon
  blurb: string
  build: (ctx: WsContext) => SectionData
  /** What "Set this up with Kivo" asks, when the section is showing example data. */
  setup?: string
}

export interface WorkspaceDef {
  id: Discipline
  label: string
  icon: LucideIcon
  /** OKLCH hue of the workspace accent. */
  hue: number
  tagline: string
  /** The first mode's name in this discipline's vocabulary (Build, Train, Assess, Operate…). */
  primaryMode: string
  hero: { title: string; body: string }
  placeholder: string
  examples: { icon: LucideIcon; label: string; text: string }[]
  /** Files and tools this workspace recognizes — shown when nothing has been detected yet. */
  looksFor: string[]
  /** Detected technologies that belong to this workspace. */
  relevant: (tech: string, category: string) => boolean
  stats: (ctx: WsContext) => { label: string; value: string; hint?: string; tone?: Tone }[]
  sections: SectionDef[]
  /** A standing note (e.g. the security scope rule). */
  notice?: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Deterministic pseudo-random numbers, so example data is stable across renders and reloads. */
export function rng(seed: string) {
  let h = 1779033703 ^ seed.length
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 3432918353)
  let a = (h << 13) | (h >>> 19)
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A noisy curve from `from` towards `to` (loss falling, reward rising, latency drifting). */
export function curve(seed: string, n: number, from: number, to: number, noise = 0.05, shape = 3) {
  const r = rng(seed)
  const span = Math.abs(to - from) || Math.abs(from) || 1
  return Array.from({ length: n }, (_, i) => {
    const t = 1 - Math.exp((-shape * i) / Math.max(1, n - 1))
    const v = from + (to - from) * (t / (1 - Math.exp(-shape)))
    return round(v + (r() - 0.5) * 2 * noise * span, 3)
  })
}

/** A series wandering around a baseline, with occasional spikes. */
export function jitter(seed: string, n: number, base: number, spread: number, spikes = 0) {
  const r = rng(seed)
  return Array.from({ length: n }, () => round(base + (r() - 0.5) * 2 * spread + (r() < spikes ? spread * (2 + r() * 3) : 0), 2))
}

export const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d

export const match = (files: string[], re: RegExp) => files.filter((f) => re.test(f))

export const base = (p: string) => p.split("/").pop() ?? p

export const stem = (p: string) => base(p).replace(/\.[^.]+$/, "")

export function percentile(values: number[], p: number) {
  if (!values.length) return 0
  const s = [...values].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}
