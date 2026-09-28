import { AlertTriangle, CheckCircle2, Circle, CircleDot, Info, XCircle } from "lucide-react"
import { cn } from "@/lib/utils"
import { useChecks } from "./hooks"
import { LineChart } from "./LineChart"
import type { BoardPanel, Cell, ChecklistPanel, MetricsPanel, Panel, TablePanel, TimelinePanel, Tone } from "./model"

/** Status colours always come with an icon and a text label — never colour alone. */
const TONE_TEXT: Record<Tone, string> = {
  good: "text-success",
  warn: "text-warning",
  bad: "text-destructive",
  info: "text-info",
  neutral: "text-muted-foreground",
}
const TONE_BG: Record<Tone, string> = {
  good: "bg-success/10",
  warn: "bg-warning/10",
  bad: "bg-destructive/10",
  info: "bg-info/10",
  neutral: "bg-muted",
}
const TONE_DOT: Record<Tone, string> = { good: "bg-success", warn: "bg-warning", bad: "bg-destructive", info: "bg-info", neutral: "bg-muted-foreground" }
const TONE_ICON: Record<Tone, typeof CheckCircle2> = { good: CheckCircle2, warn: AlertTriangle, bad: XCircle, info: Info, neutral: CircleDot }

export function ToneBadge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  const Icon = TONE_ICON[tone]
  return (
    <span className={cn("inline-flex max-w-full items-start gap-1 rounded-xl px-1.5 py-px text-[11px] leading-4", TONE_BG[tone], TONE_TEXT[tone])}>
      <Icon className="mt-0.5 size-3 shrink-0" />
      <span className="text-foreground/85">{children}</span>
    </span>
  )
}

function CellView({ cell, mono }: { cell: Cell | undefined; mono?: boolean }) {
  if (cell === undefined || cell === "") return <span className="text-muted-foreground">—</span>
  if (typeof cell !== "object") return <span className={cn(mono && "font-mono text-[12px]")}>{cell}</span>
  const body = cell.tone ? <ToneBadge tone={cell.tone}>{cell.text}</ToneBadge> : <span className={cn((cell.mono ?? mono) && "font-mono text-[12px]")}>{cell.text}</span>
  return (
    <span className="inline-flex flex-col">
      {body}
      {cell.sub && <span className="text-[10.5px] text-muted-foreground">{cell.sub}</span>}
    </span>
  )
}

function PanelTitle({ children }: { children?: string }) {
  return children ? <h3 className="text-[13px] font-medium">{children}</h3> : null
}

function TableView({ p }: { p: TablePanel }) {
  if (!p.rows.length) return <p className="rounded-xl border border-dashed p-4 text-[13px] text-muted-foreground">{p.empty ?? "Nothing here yet."}</p>
  return (
    <div className="space-y-2">
      <PanelTitle>{p.title}</PanelTitle>
      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b text-left text-[11px] text-muted-foreground">
              {p.columns.map((c) => (
                <th key={c.key} className={cn("px-3 py-2 font-normal whitespace-nowrap", c.align === "right" && "text-right")}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {p.rows.map((r, i) => (
              <tr key={i} className="border-b align-top last:border-0 hover:bg-accent/40">
                {p.columns.map((c) => (
                  <td key={c.key} className={cn("px-3 py-2", c.align === "right" && "text-right tabular-nums", c.mono && "break-all")}>
                    <CellView cell={r[c.key]} mono={c.mono} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function MetricsView({ p }: { p: MetricsPanel }) {
  return (
    <div className="space-y-4">
      <PanelTitle>{p.title}</PanelTitle>
      {p.tiles.length > 0 && (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2">
          {p.tiles.map((t) => (
            <div key={t.label} className="rounded-xl border p-3">
              <div className="text-[11px] text-muted-foreground">{t.label}</div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-xl font-semibold tabular-nums">{t.value}</span>
              </div>
              {(t.hint || (t.tone && t.tone !== "neutral")) && (
                <div className="mt-1">{t.tone && t.tone !== "neutral" ? <ToneBadge tone={t.tone}>{t.hint ?? (t.tone === "good" ? "healthy" : t.tone === "warn" ? "watch" : t.tone === "bad" ? "action needed" : "note")}</ToneBadge> : <span className="text-[11px] text-muted-foreground">{t.hint}</span>}</div>
              )}
            </div>
          ))}
        </div>
      )}
      {p.charts.map((c) => (
        <div key={c.title} className="rounded-xl border p-3">
          <LineChart chart={c} />
        </div>
      ))}
    </div>
  )
}

function BoardView({ p }: { p: BoardPanel }) {
  return (
    <div className="space-y-2">
      <PanelTitle>{p.title}</PanelTitle>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-2">
        {p.columns.map((col) => (
          <div key={col.title} className="flex flex-col gap-1.5 rounded-xl border bg-subtle p-2">
            <div className="flex items-center justify-between px-1 text-[12px]">
              <span className="flex items-center gap-1.5 font-medium">
                {col.tone && <span className={cn("size-1.5 rounded-full", TONE_DOT[col.tone])} />}
                {col.title}
              </span>
              <span className="text-muted-foreground tabular-nums">{col.cards.length}</span>
            </div>
            {col.cards.length === 0 && <div className="rounded-lg border border-dashed px-2 py-3 text-center text-[11px] text-muted-foreground">Empty</div>}
            {col.cards.map((c, i) => (
              <div key={i} className="rounded-lg border bg-background p-2 text-[12.5px] leading-snug">
                <div>{c.title}</div>
                {c.meta && <div className="mt-1 text-[11px] text-muted-foreground">{c.meta}</div>}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

function ChecklistView({ p, scope }: { p: ChecklistPanel; scope: string }) {
  const { done, toggle } = useChecks()
  const groups = p.items.reduce<Record<string, typeof p.items>>((acc, i) => {
    ;(acc[i.group ?? ""] ??= []).push(i)
    return acc
  }, {})
  const count = p.items.filter((i) => done[`${scope}:${i.id}`]).length
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <PanelTitle>{p.title}</PanelTitle>
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={count} aria-valuemax={p.items.length} aria-label="Checked">
          <div className="h-full rounded-full bg-(--ws) transition-all" style={{ width: `${p.items.length ? (count / p.items.length) * 100 : 0}%` }} />
        </div>
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {count} / {p.items.length}
        </span>
      </div>
      {Object.entries(groups).map(([group, items]) => (
        <div key={group} className="space-y-1">
          {group && <div className="px-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{group}</div>}
          <div className="divide-y rounded-xl border">
            {items.map((i) => {
              const key = `${scope}:${i.id}`
              const on = !!done[key]
              return (
                <label key={i.id} className="flex cursor-pointer items-start gap-2.5 px-3 py-2 hover:bg-accent/40">
                  <input type="checkbox" className="sr-only" checked={on} onChange={() => toggle(key)} />
                  {on ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 ws-ink" /> : <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
                  <span className="min-w-0">
                    <span className={cn("block text-[13px]", on && "text-muted-foreground line-through decoration-muted-foreground/50")}>{i.title}</span>
                    {i.detail && <span className="block text-[11.5px] text-muted-foreground">{i.detail}</span>}
                  </span>
                </label>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

function TimelineView({ p }: { p: TimelinePanel }) {
  return (
    <div className="space-y-2">
      <PanelTitle>{p.title}</PanelTitle>
      <ol className="relative space-y-0 rounded-xl border p-3">
        {p.events.map((e, i) => {
          const Icon = TONE_ICON[e.tone ?? "neutral"]
          return (
            <li key={i} className="grid grid-cols-[4.5rem_1rem_1fr] gap-2 py-1.5">
              <span className="pt-px text-right font-mono text-[11px] text-muted-foreground tabular-nums">{e.at}</span>
              <Icon className={cn("mt-0.5 size-3.5", TONE_TEXT[e.tone ?? "neutral"])} />
              <span className="min-w-0">
                <span className="block text-[13px]">{e.title}</span>
                {e.detail && <span className="block truncate font-mono text-[11px] text-muted-foreground">{e.detail}</span>}
              </span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

export function PanelView({ panel, scope }: { panel: Panel; scope: string }) {
  switch (panel.kind) {
    case "table":
      return <TableView p={panel} />
    case "metrics":
      return <MetricsView p={panel} />
    case "board":
      return <BoardView p={panel} />
    case "checklist":
      return <ChecklistView p={panel} scope={scope} />
    case "timeline":
      return <TimelineView p={panel} />
  }
}
