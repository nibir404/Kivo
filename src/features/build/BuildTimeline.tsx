import { useEffect, useMemo, useRef, useState } from "react"
import { AlertTriangle, Check, ChevronRight, CircleDashed, Code2, FileCode2, FlaskConical, Hourglass, Loader2, MessageSquare, Play, RotateCw, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { PlanStep, ServiceSpec } from "@/core/types"
import { cn } from "@/lib/utils"
import { askAboutFailure, openFile, rebuild } from "@/state/runners"
import { useKivo, type BuildRun, type StepRun } from "@/state/store"
import { useUi } from "@/shell/capture"

/**
 * The build, as one calm timeline. Finished steps collapse to a single line; the running step
 * expands to show what is actually happening (code being written, or tool output). Explanations
 * of what/why live in the Context Panel — one click on "Why?" away — not in the way.
 */
export function BuildTimeline({ spec, onTab }: { spec: ServiceSpec; onTab: (tab: string) => void }) {
  const build = useKivo((s) => s.build)!
  const now = useNow(!build.finished)
  const runs = useMemo(() => normalizeRuns(build), [build])
  const done = build.steps.filter((st) => ["done", "failed", "skipped"].includes(runs[st.id].status)).length
  const elapsed = ((build.finished ? lastEnd(runs) ?? now : now) - build.startedAt) / 1000
  const activeId = build.steps.find((st) => runs[st.id].status === "active")?.id
  const [open, setOpen] = useState<Record<string, boolean>>({})

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6 sm:px-8">
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <BuildStatus build={build} />
          <span className="font-mono text-[12px] text-muted-foreground tabular-nums">
            {done}/{build.steps.length} steps · {formatDuration(elapsed)}
          </span>
          {!build.real && <span className="ml-auto text-[11px] text-muted-foreground">offline simulation</span>}
        </div>
        <div className="h-0.5 overflow-hidden rounded-full bg-muted">
          <div className={cn("h-full transition-all duration-500", build.finished && !build.ok ? "bg-destructive" : "bg-foreground")} style={{ width: `${(done / build.steps.length) * 100}%` }} />
        </div>
      </div>

      {build.finished && build.real && <ResultCard spec={spec} build={build} onTab={onTab} />}

      <ol className="relative">
        {build.steps.map((step, i) => {
          const run = runs[step.id]
          const expanded = open[step.id] ?? (step.id === activeId || run.status === "failed")
          return (
            <StepRow
              key={step.id}
              step={step}
              run={run}
              last={i === build.steps.length - 1}
              expanded={expanded}
              now={now}
              onToggle={() => setOpen((o) => ({ ...o, [step.id]: !expanded }))}
            />
          )
        })}
      </ol>
    </div>
  )
}

function BuildStatus({ build }: { build: BuildRun }) {
  if (!build.finished)
    return (
      <span className="flex items-center gap-2 text-sm font-medium">
        <span className="kivo-pulse size-2 rounded-full bg-info" /> Building
      </span>
    )
  if (build.ok)
    return (
      <span className="flex items-center gap-2 text-sm font-medium">
        <span className="size-2 rounded-full bg-success" /> Ready
      </span>
    )
  return (
    <span className="flex items-center gap-2 text-sm font-medium">
      <span className="size-2 rounded-full bg-destructive" /> Needs attention
    </span>
  )
}

function StepRow({ step, run, last, expanded, now, onToggle }: { step: PlanStep; run: StepRun; last: boolean; expanded: boolean; now: number; onToggle: () => void }) {
  const select = useKivo((s) => s.select)
  const openRight = useUi((s) => s.openRight)
  const duration = run.startedAt ? ((run.endedAt ?? (run.status === "active" ? now : run.startedAt)) - run.startedAt) / 1000 : undefined
  const hasLive = !!(run.output || run.logs.length || run.reasoning)
  const status = liveStatus(step, run)

  return (
    <li className="relative pl-8">
      {!last && <span className={cn("absolute top-6 bottom-0 left-[9px] w-px", run.status === "done" ? "bg-foreground/20" : "bg-border")} />}
      <span className="absolute top-1 left-0 flex size-5 items-center justify-center rounded-full bg-background">
        <StepIcon status={run.status} />
      </span>

      <div className={cn("pb-5", last && "pb-0")}>
        <button onClick={onToggle} className="group flex w-full items-baseline gap-2 text-left">
          <span className={cn("text-[14px]", run.status === "todo" || run.status === "skipped" ? "text-muted-foreground" : "text-foreground", run.status === "failed" && "text-destructive")}>{step.title}</span>
          <span className="hidden font-mono text-[11px] text-muted-foreground/70 sm:inline">{step.engine}</span>
          <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[11px] text-muted-foreground tabular-nums">
            {duration !== undefined && formatDuration(duration)}
            {(hasLive || run.note) && <ChevronRight className={cn("size-3 transition-transform", expanded && "rotate-90")} />}
          </span>
        </button>

        {status && (
          <div className={cn("mt-0.5 flex items-center gap-1.5 text-[12px]", run.waiting ? "text-warning" : "text-muted-foreground", run.status === "failed" && "text-destructive")}>
            {run.waiting && <Hourglass className="size-3" />}
            <span className="truncate">{status}</span>
          </div>
        )}

        {run.files.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {run.files.map((f) => (
              <button key={f} onClick={() => openFile(f)} className="flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground">
                <FileCode2 className="size-3" />
                {f.replace(/^services\/[^/]+\//, "")}
              </button>
            ))}
          </div>
        )}

        {expanded && hasLive && <LivePanel step={step} run={run} />}

        {expanded && (
          <button
            className="mt-2 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            onClick={() => {
              select({ kind: "step", id: step.id, label: step.title, conceptId: step.concept, detail: step.why })
              openRight()
            }}
          >
            Why this step? →
          </button>
        )}
      </div>
    </li>
  )
}

function StepIcon({ status }: { status: StepRun["status"] }) {
  if (status === "done") return <Check className="size-3.5 text-success" />
  if (status === "active") return <Loader2 className="size-3.5 animate-spin" />
  if (status === "failed") return <X className="size-3.5 text-destructive" />
  if (status === "skipped") return <span className="size-1.5 rounded-full bg-muted-foreground/40" />
  return <CircleDashed className="size-3.5 text-muted-foreground/50" />
}

/** One human line about what the step is doing right now (or what it did). */
function liveStatus(step: PlanStep, run: StepRun): string | undefined {
  if (run.waiting) return run.waiting
  if (run.status === "active") {
    const files = [...run.output.matchAll(/^=== FILE: (.+?) ===/gm)].map((m) => m[1])
    if (files.length) return `Writing ${files[files.length - 1]}…`
    if (run.reasoning && !run.output) return "Thinking…"
    const lastLog = [...run.logs].reverse().find((l) => l.trim() && !/^\s/.test(l))
    if (lastLog) return lastLog.replace(/^\$ /, "Running ").slice(0, 140)
    return step.executor === "ai" ? "Starting…" : "Running…"
  }
  return run.note
}

/** What's actually happening: code as it's written (AI steps) or tool output (deterministic steps). */
function LivePanel({ step, run }: { step: PlanStep; run: StepRun }) {
  const files = useMemo(() => splitFiles(run.output), [run.output])
  const logs = run.logs.filter((l) => !/^(⏳|↻)/.test(l))
  const views = [...files.map((f) => ({ key: `file:${f.path}`, label: f.path.split("/").pop()!, text: f.content })), ...(logs.length ? [{ key: "logs", label: "Output", text: logs.join("\n") }] : []), ...(run.reasoning ? [{ key: "reasoning", label: "Reasoning", text: run.reasoning }] : [])]
  const [picked, setPicked] = useState<string | null>(null)
  // Follow the newest view while the step runs, unless the user picked one.
  const newestFile = views.filter((v) => v.key.startsWith("file:")).at(-1)
  const current = views.find((v) => v.key === picked) ?? (step.executor === "ai" ? newestFile : undefined) ?? views[0]
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (run.status === "active" && box.current) box.current.scrollTop = box.current.scrollHeight
  }, [current?.text.length, run.status])
  if (!current) return null

  return (
    <div className="mt-3 overflow-hidden rounded-lg border bg-muted/20">
      <div className="flex items-center gap-0.5 overflow-x-auto border-b px-1.5 py-1 [scrollbar-width:none]">
        {views.map((v) => (
          <button
            key={v.key}
            onClick={() => setPicked(v.key)}
            data-active={v.key === current.key || undefined}
            className="shrink-0 rounded px-2 py-0.5 font-mono text-[11px] text-muted-foreground hover:text-foreground data-active:bg-background data-active:text-foreground data-active:shadow-xs"
          >
            {v.label}
          </button>
        ))}
        {run.status === "active" && <span className="kivo-pulse mr-1 ml-auto size-1.5 shrink-0 rounded-full bg-info" />}
      </div>
      <div ref={box} className="max-h-72 overflow-auto py-2 font-mono text-[11.5px] leading-[1.6]">
        {current.key.startsWith("file:") ? (
          current.text.split("\n").map((l, i) => (
            <div key={i} className="flex">
              <span className="w-10 shrink-0 pr-3 text-right text-muted-foreground/40 select-none">{i + 1}</span>
              <span className="pr-3 whitespace-pre text-foreground/85">{l || " "}</span>
            </div>
          ))
        ) : (
          <pre className={cn("px-3 whitespace-pre-wrap", current.key === "reasoning" ? "text-muted-foreground" : "text-foreground/80")}>
            {current.text.split("\n").map((l, i) => (
              <div key={i} className={cn(/^\$ /.test(l) && "text-foreground", /✓|passed/.test(l) && "text-success", /✗|FAILED|Error/.test(l) && "text-destructive", /^(!|⚙|✎|✦)/.test(l) && "text-warning")}>
                {l}
              </div>
            ))}
          </pre>
        )}
      </div>
    </div>
  )
}

function ResultCard({ spec, build, onTab }: { spec: ServiceSpec; build: BuildRun; onTab: (tab: string) => void }) {
  const runInTerminal = useUi((s) => s.runInTerminal)
  const tests = spec.tests
  const passed = tests.filter((t) => t.status === "pass").length
  const failedStep = build.steps.find((st) => build.runs[st.id]?.status === "failed")
  const main = spec.files.find((f) => f.endsWith("/router.py")) ?? spec.files.find((f) => f.endsWith(".py")) ?? spec.files[0]
  const testCmd = `cd services/${spec.id} && pytest -q`

  return (
    <div className={cn("rounded-xl border p-4", !build.ok && "border-destructive/30")}>
      <div className="flex items-start gap-3">
        <div className={cn("mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full", build.ok ? "bg-success/15 text-success" : "bg-destructive/10 text-destructive")}>
          {build.ok ? <Check className="size-4" /> : <AlertTriangle className="size-4" />}
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="text-[15px] font-medium">{build.ok ? `${spec.name} is live` : failedStep ? `${failedStep.title} didn't pass` : "Build stopped"}</div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[12px] text-muted-foreground">
            {build.url && <span>{build.url.replace("http://", "")}</span>}
            {tests.length > 0 && (
              <span className={cn(passed < tests.length && "text-destructive")}>
                {passed}/{tests.length} tests
              </span>
            )}
            {build.commit && <span>commit {build.commit}</span>}
          </div>
          {!build.ok && (
            <div className="pt-1 text-[13px] text-muted-foreground">
              {tests.some((t) => t.status === "fail") ? (
                <>
                  Failing: <span className="font-mono text-[12px] text-foreground">{tests.filter((t) => t.status === "fail").map((t) => t.name).join(", ")}</span>
                  {build.url && <> · the service is running for inspection.</>}
                </>
              ) : (
                (failedStep && build.runs[failedStep.id]?.note) || build.error
              )}
            </div>
          )}
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {build.url && (
          <Button size="sm" variant={build.ok ? "default" : "outline"} onClick={() => onTab("api")}>
            <Play /> Try the API
          </Button>
        )}
        {!build.ok && (
          <Button size="sm" onClick={() => askAboutFailure(spec.id)}>
            <MessageSquare /> Ask AI why
          </Button>
        )}
        {main && (
          <Button size="sm" variant="outline" onClick={() => openFile(main)}>
            <Code2 /> Open code
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={() => runInTerminal(testCmd)}>
          <FlaskConical /> Run tests
        </Button>
        <Button size="sm" variant="ghost" onClick={() => rebuild(spec.id)}>
          <RotateCw /> Rebuild
        </Button>
      </div>
    </div>
  )
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function normalizeRuns(build: BuildRun): Record<string, StepRun> {
  if (build.real) return build.runs
  // Offline simulation: derive statuses from the index.
  return Object.fromEntries(
    build.steps.map((st, i) => [
      st.id,
      {
        status: i < build.index || build.finished ? "done" : i === build.index ? "active" : "todo",
        output: "",
        reasoning: "",
        logs: [],
        files: i < build.index || build.finished ? st.artifacts : [],
        note: i < build.index || build.finished ? "Simulated — connect the daemon for real builds." : undefined,
      } as StepRun,
    ]),
  )
}

function splitFiles(output: string) {
  const heads = [...output.matchAll(/^=== FILE: (.+?) ===\s*$/gm)]
  return heads.map((h, i) => {
    const start = h.index! + h[0].length + 1
    const end = i + 1 < heads.length ? heads[i + 1].index! : output.length
    return { path: h[1].trim(), content: output.slice(start, end).replace(/\n?=== END FILE ===[\s\S]*$/, "").replace(/\n+$/, "") }
  })
}

function lastEnd(runs: Record<string, StepRun>) {
  const ends = Object.values(runs).map((r) => r.endedAt ?? 0)
  return ends.length ? Math.max(...ends) || undefined : undefined
}

export function formatDuration(seconds: number) {
  const s = Math.max(0, Math.round(seconds))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`
}

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [active])
  return active ? now : Date.now()
}
