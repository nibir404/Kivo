import { Activity, ArrowDown, History, Pause, Play } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import type { Trace } from "@/core/types"
import { cn } from "@/lib/utils"
import { useKivo } from "@/state/store"
import { EmptyState, KindIcon, SectionLabel, Stat, StatusDot } from "@/shell/bits"
import { Capturable, CaptureScope } from "@/shell/capture"
import { median } from "@/features/build/BuildView"

export function ObserveView() {
  const { traces, selectedTraceId, selectTrace, runtimeLive, toggleRuntime, nodes } = useKivo()
  const trace = traces.find((t) => t.id === selectedTraceId) ?? traces[0]

  const recent = traces.slice(0, 40)
  const lat = recent.map((t) => t.totalMs).sort((a, b) => a - b)
  const p95 = lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.95))] : 0
  const errRate = recent.length ? Math.round((recent.filter((t) => t.status >= 400).length / recent.length) * 100) : 0
  const slow = recent.filter((t) => t.spans.some((s) => s.status === "slow")).length

  if (!traces.length) return <ObserveEmpty />

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center border-b">
        <div className="grid flex-1 grid-cols-5 divide-x">
          <Stat label="Throughput" value={(recent.length ? Math.min(recent.length, 7) / 10 : 0).toFixed(1)} unit="req/s" />
          <Stat label="p50" value={median(lat)} unit="ms" />
          <Stat label="p95" value={p95} unit="ms" tone={p95 > 100 ? "warn" : undefined} />
          <Stat label="Errors" value={errRate} unit="%" tone={errRate > 10 ? "bad" : undefined} />
          <Stat label="Slow queries" value={slow} tone={slow ? "warn" : undefined} />
        </div>
        <div className="flex items-center gap-2 px-4">
          <Badge variant="outline" className="font-normal text-muted-foreground">
            Demo traffic
          </Badge>
          <Button variant="outline" size="sm" onClick={toggleRuntime}>
            {runtimeLive ? <Pause /> : <Play />}
            {runtimeLive ? "Pause" : "Resume"}
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-4 overflow-x-auto border-b px-4 py-2">
        {nodes.map((n) => (
          <Capturable key={n.id} refObj={{ kind: "node", id: n.id, label: n.label, conceptId: n.concept }} className="flex shrink-0 items-center gap-1.5 px-1.5 py-0.5 text-xs hover:bg-accent">
            <StatusDot status={n.status} />
            <KindIcon kind={n.kind} className="size-3" />
            {n.label}
          </Capturable>
        ))}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(260px,340px)_1fr]">
        <div className="flex min-h-0 flex-col border-r">
          <div className="flex items-center justify-between px-3 pt-3">
            <SectionLabel>Live requests</SectionLabel>
            {runtimeLive && <span className="kivo-pulse mb-1.5 size-1.5 rounded-full bg-success" />}
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-px px-2 pb-2">
              {traces.map((t) => (
                <button
                  key={t.id}
                  onClick={() => selectTrace(t.id)}
                  data-active={trace?.id === t.id || undefined}
                  className="kivo-in flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-mono text-[12px] hover:bg-accent data-active:bg-accent"
                >
                  <StatusDot status={t.status >= 400 ? "error" : t.spans.some((s) => s.status === "slow") ? "slow" : "ok"} />
                  <span className="w-10 text-muted-foreground">{t.method}</span>
                  <span className="flex-1 truncate">{t.route}</span>
                  <span className={cn("text-muted-foreground", t.status >= 400 && "text-destructive")}>{t.status}</span>
                  <span className="w-14 text-right text-muted-foreground tabular-nums">{t.totalMs}ms</span>
                </button>
              ))}
            </div>
          </ScrollArea>
        </div>
        {trace ? <TraceDetail trace={trace} /> : <EmptyState icon={Play} title="No traffic yet">Press Run to start the project and stream requests.</EmptyState>}
      </div>
    </div>
  )
}

function TraceDetail({ trace }: { trace: Trace }) {
  const { level, nodes, setExperienceDraftOpen, select, selection } = useKivo()
  // Request flow: the distinct path of nodes this request touched, in order.
  const path: string[] = []
  for (const s of trace.spans) if (path[path.length - 1] !== s.nodeId) path.push(s.nodeId)
  const flow = ["mobile", ...path.filter((p, i) => !(i === path.length - 1 && p === "mobile"))]
  const total = trace.totalMs || 1
  const worst = [...trace.spans].sort((a, b) => b.durationMs - a.durationMs)[0]
  const slowSpan = trace.spans.find((s) => s.status === "slow")

  return (
    <ScrollArea className="h-full">
      <div className="grid gap-8 p-6 xl:grid-cols-[220px_1fr]">
        <div>
          <SectionLabel>Request flow</SectionLabel>
          <div className="flex flex-col items-start">
            {flow.map((id, i) => {
              const n = nodes.find((x) => x.id === id)
              return (
                <div key={i} className="flex flex-col items-start">
                  {i === 1 && (
                    <>
                      <div className="rounded-md border border-dashed px-2 py-1 font-mono text-[11px]">
                        {trace.method} {trace.route}
                      </div>
                      <ArrowDown className="my-1 ml-3 size-3 text-muted-foreground" />
                    </>
                  )}
                  <Capturable refObj={{ kind: "node", id, label: n?.label ?? id, conceptId: n?.concept }} className="flex items-center gap-2 rounded-md border px-2 py-1 text-[12px] hover:bg-accent">
                    {n && <KindIcon kind={n.kind} className="size-3" />}
                    {n?.label ?? id}
                  </Capturable>
                  <ArrowDown className="my-1 ml-3 size-3 text-muted-foreground" />
                </div>
              )
            })}
            <div className={cn("rounded-md px-2 py-1 font-mono text-[11px]", trace.status >= 400 ? "bg-destructive/10 text-destructive" : "bg-muted")}>
              {trace.status} · {trace.totalMs}ms
            </div>
          </div>
        </div>

        <div className="min-w-0 space-y-6">
          <div>
            <SectionLabel action={<span className="font-mono text-[11px] normal-case">{trace.id}</span>}>Events</SectionLabel>
            <CaptureScope source="log" className="divide-y rounded-xl border">
              {trace.spans.map((s) => {
                const active = selection?.kind === "span" && selection.id === s.id
                return (
                  <Capturable
                    key={s.id}
                    refObj={{ kind: "span", id: s.id, label: s.name, conceptId: s.concept, detail: s.narration[level] }}
                    className={cn("grid grid-cols-[16px_minmax(150px,200px)_1fr_64px] items-center gap-3 rounded-none px-3 py-2 hover:bg-accent/50", active && "bg-accent")}
                  >
                    <StatusDot status={s.status} />
                    <span className="truncate text-[13px]">{s.name}</span>
                    <div className="relative h-1.5 rounded-full bg-muted">
                      <div
                        className={cn("absolute h-full rounded-full", s.status === "error" ? "bg-destructive" : s.status === "slow" ? "bg-warning" : "bg-foreground/70")}
                        style={{ left: `${(s.offsetMs / total) * 100}%`, width: `${Math.max(1.5, (s.durationMs / total) * 100)}%` }}
                      />
                    </div>
                    <span className="text-right font-mono text-[12px] text-muted-foreground tabular-nums">{s.durationMs}ms</span>
                  </Capturable>
                )
              })}
            </CaptureScope>
          </div>

          <div>
            <SectionLabel>What's happening</SectionLabel>
            <CaptureScope source="explanation" className="space-y-1.5 text-[13px]">
              {trace.spans.map((s) => (
                <div key={s.id} className="flex gap-2">
                  <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", s.status === "ok" ? "bg-foreground/40" : s.status === "slow" ? "bg-warning" : "bg-destructive")} />
                  <span className={cn(level !== "beginner" && "font-mono text-[12px]")}>{s.narration[level]}</span>
                </div>
              ))}
            </CaptureScope>
          </div>

          <div className="rounded-xl border p-4 text-[13px]">
            <div className="flex items-center gap-2">
              <Badge variant="outline">Insight</Badge>
              <span className="text-muted-foreground">from runtime evidence</span>
            </div>
            <p className="mt-2">
              {slowSpan
                ? `“${slowSpan.name}” took ${slowSpan.durationMs}ms — about ${Math.round(slowSpan.durationMs / 4)}× its usual time. That pattern usually means a missing index or a query running once per item (N+1).`
                : `“${worst.name}” is the slowest step (${Math.round((worst.durationMs / total) * 100)}% of the request).${worst.concept === "password-hashing" ? " That's intentional: password hashing is designed to be slow so stolen hashes are hard to crack." : ""}`}
            </p>
            <div className="mt-3 flex gap-2">
              <Button variant="outline" size="xs" onClick={() => select({ kind: "span", id: (slowSpan ?? worst).id, label: (slowSpan ?? worst).name, conceptId: (slowSpan ?? worst).concept, detail: (slowSpan ?? worst).narration[level] }, "explain")}>
                Explain
              </Button>
              {slowSpan && (
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => {
                    select({ kind: "span", id: slowSpan.id, label: slowSpan.name, conceptId: slowSpan.concept, detail: `${slowSpan.name} took ${slowSpan.durationMs}ms on ${trace.method} ${trace.route}` })
                    setExperienceDraftOpen(true)
                  }}
                >
                  <History /> Capture as experience
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </ScrollArea>
  )
}

/** Nothing to observe yet — explain what this mode is for and let the user choose how to begin. */
function ObserveEmpty() {
  const { toggleRuntime, services, openService } = useKivo()
  const built = services.find((s) => s.status === "running" && !s.intent.startsWith("(detected"))
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="kivo-in max-w-md space-y-5 text-center">
        <div className="mx-auto w-fit rounded-xl border p-2.5">
          <Activity className="size-5 text-muted-foreground" />
        </div>
        <div className="space-y-1.5">
          <h2 className="text-lg font-semibold tracking-tight">Watch requests move through your system</h2>
          <p className="text-[13px] text-muted-foreground">Observe follows each request hop by hop — gateway, service, cache, database — and explains what happened at your level.</p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          <Button onClick={toggleRuntime}>
            <Play /> Start demo traffic
          </Button>
          {built && (
            <Button variant="outline" onClick={() => openService(built.id)}>
              Call {built.name}'s API
            </Button>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground">Demo traffic is simulated and clearly labelled. Turn it off any time from the status bar.</p>
      </div>
    </div>
  )
}
