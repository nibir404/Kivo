import { useEffect, useMemo, useRef, useState } from "react"
import { AlertTriangle, ArrowLeft, Check, ChevronRight, CircleDashed, Code2, Eye, FileCode2, FlaskConical, Hourglass, Info, Loader2, MessageSquare, Play, RotateCw, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { PlanStep, ServiceSpec } from "@kivo/core/types"
import { toolchainFor } from "@kivo/core/stacks"
import { cn } from "@/lib/utils"
import { askAboutFailure, openFile, rebuild } from "@/state/runners"
import { useKivo, type BuildRun, type StepRun } from "@/state/store"
import { useUi } from "@/shell/capture"
import { Journey, PHASES, plain, stepTitle, useTechnical, type Phase } from "./journey"

/**
 * The build, as one calm story. A single headline says what is happening right now in plain
 * words; steps are grouped into four phases anyone can follow (Plan → Write → Test → Launch).
 * Finished steps collapse to one line; the running step shows the code being written or the tool
 * output. Technical names, files and logs are one click away — open by default for experts.
 */
export function BuildTimeline({ spec, onTab }: { spec: ServiceSpec; onTab: (tab: string) => void }) {
  const build = useKivo((s) => s.build)!
  const technical = useTechnical()
  const now = useNow(!build.finished)
  const runs = useMemo(() => normalizeRuns(build), [build])
  const done = build.steps.filter((st) => ["done", "failed", "skipped"].includes(runs[st.id].status)).length
  const elapsed = ((build.finished ? lastEnd(runs) ?? now : now) - build.startedAt) / 1000
  const active = build.steps.find((st) => runs[st.id].status === "active")
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const phases = PHASES.map((phase) => ({ phase, steps: build.steps.filter((st) => plain(st).phase === phase) })).filter((p) => p.steps.length)

  return (
    <div className="mx-auto w-full max-w-3xl space-y-8 px-4 py-8 sm:px-8">
      <Journey stage={build.finished && build.ok ? "Use" : "Build"} />

      {build.finished ? (
        <ResultCard spec={spec} build={build} runs={runs} elapsed={elapsed} onTab={onTab} />
      ) : (
        <LiveHero build={build} runs={runs} active={active} done={done} elapsed={elapsed} technical={technical} />
      )}

      {!build.real && !build.finished && (
        <div className="flex items-start gap-2.5 rounded-xl bg-muted/40 px-4 py-3 text-[13px] text-muted-foreground">
          <Info className="mt-0.5 size-4 shrink-0" />
          <span>
            <span className="font-medium text-foreground">Preview mode.</span> Kivo is walking you through the plan without writing real code. Add an AI key in <span className="font-mono text-[12px]">.env</span> to build it for real.
          </span>
        </div>
      )}

      <section className="space-y-4">
        <div className="flex items-baseline justify-between px-1">
          <h2 className="text-[15px] font-medium">{build.finished ? "What Kivo did" : "Every step, as it happens"}</h2>
          <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
            {done}/{build.steps.length} steps · {formatDuration(elapsed)}
          </span>
        </div>
        <div className="space-y-6">
          {phases.map(({ phase, steps }) => (
            <div key={phase}>
              <PhaseHeader phase={phase} state={phaseState(steps, runs)} />
              <ol className="mt-2">
                {steps.map((step, i) => {
                  const run = runs[step.id]
                  const expanded = open[step.id] ?? (step.id === active?.id || run.status === "failed")
                  return <StepRow key={step.id} step={step} run={run} last={i === steps.length - 1} expanded={expanded} now={now} technical={technical} onToggle={() => setOpen((o) => ({ ...o, [step.id]: !expanded }))} />
                })}
              </ol>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

// ─── Live headline ────────────────────────────────────────────────────────────

function LiveHero({ build, runs, active, done, elapsed, technical }: { build: BuildRun; runs: Record<string, StepRun>; active?: PlanStep; done: number; elapsed: number; technical: boolean }) {
  const run = active ? runs[active.id] : undefined
  const detail = active && run && build.real ? liveStatus(active, run) : undefined
  const pct = (done / build.steps.length) * 100
  return (
    <div className="kivo-in space-y-5 rounded-2xl border p-5 sm:p-6">
      <div className="flex items-start gap-4">
        <div className="relative flex size-10 shrink-0 items-center justify-center rounded-full border">
          <Loader2 className="size-4 animate-spin" />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="text-[12px] text-muted-foreground">
            Building · step {Math.min(done + 1, build.steps.length)} of {build.steps.length}
          </div>
          <div className="text-[19px] leading-snug font-semibold tracking-tight">{active ? `${technical ? active.title : plain(active).doing}…` : "Getting ready…"}</div>
          {detail && (
            <div className={cn("flex items-center gap-1.5 text-[13px]", run?.waiting ? "text-warning" : "text-muted-foreground")}>
              {run?.waiting && <Hourglass className="size-3.5 shrink-0" />}
              <span className="truncate">{detail}</span>
            </div>
          )}
        </div>
      </div>
      <div className="space-y-2">
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-foreground transition-all duration-700 ease-out" style={{ width: `${Math.max(pct, 3)}%` }} />
        </div>
        <div className="flex justify-between text-[11px] text-muted-foreground">
          <span>{Math.round(pct)}% done</span>
          <span className="tabular-nums">{formatDuration(elapsed)} so far</span>
        </div>
      </div>
      {build.real && <p className="text-[12px] text-muted-foreground">You can switch to other screens — Kivo keeps building and will let you know when it's done.</p>}
    </div>
  )
}

// ─── Phases & steps ────────────────────────────────────────────────────────────

type PhaseState = "todo" | "active" | "done" | "failed"

function phaseState(steps: PlanStep[], runs: Record<string, StepRun>): PhaseState {
  const st = steps.map((s) => runs[s.id].status)
  if (st.includes("failed")) return "failed"
  if (st.includes("active")) return "active"
  if (st.every((s) => s === "done" || s === "skipped")) return st.every((s) => s === "skipped") ? "todo" : "done"
  return st.some((s) => s === "done") ? "active" : "todo"
}

const PHASE_BLURB: Record<Phase, string> = {
  Plan: "Turning your request into a precise plan",
  Write: "Writing the code, piece by piece",
  Test: "Automatically checking that everything works",
  Launch: "Switching it on",
}

function PhaseHeader({ phase, state }: { phase: Phase; state: PhaseState }) {
  return (
    <div className="flex items-center gap-2 px-1">
      <span className={cn("text-[11px] font-medium tracking-wide uppercase", state === "todo" ? "text-muted-foreground/60" : state === "failed" ? "text-destructive" : "text-muted-foreground")}>{phase}</span>
      <span className="truncate text-[12px] text-muted-foreground/70">— {PHASE_BLURB[phase]}</span>
      {state === "done" && <Check className="ml-auto size-3.5 shrink-0 text-success" />}
    </div>
  )
}

function StepRow({ step, run, last, expanded, now, technical, onToggle }: { step: PlanStep; run: StepRun; last: boolean; expanded: boolean; now: number; technical: boolean; onToggle: () => void }) {
  const select = useKivo((s) => s.select)
  const openRight = useUi((s) => s.openRight)
  const duration = run.startedAt ? ((run.endedAt ?? (run.status === "active" ? now : run.startedAt)) - run.startedAt) / 1000 : undefined
  const hasLive = !!(run.output || run.logs.length || run.reasoning)
  const status = liveStatus(step, run)
  const muted = run.status === "todo" || run.status === "skipped"

  return (
    <li className="relative pl-8">
      {!last && <span className={cn("absolute top-[30px] -bottom-[6px] left-[9.5px] w-px", run.status === "done" ? "bg-success/30" : "bg-border")} />}
      <span className="absolute top-2 left-0 flex size-5 items-center justify-center rounded-full bg-background">
        <StepIcon status={run.status} />
      </span>

      <div className={cn(!last && "pb-2")}>
        <button onClick={onToggle} aria-expanded={expanded} className="group -mx-2 flex w-[calc(100%+1rem)] items-baseline gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent/40">
          <span className={cn("text-[14px]", muted ? "text-muted-foreground" : "text-foreground", run.status === "active" && "font-medium", run.status === "failed" && "text-destructive")}>{stepTitle(step, technical)}</span>
          {technical && <span className="hidden font-mono text-[11px] text-muted-foreground/70 sm:inline">{step.engine}</span>}
          <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[11px] text-muted-foreground tabular-nums">
            {!expanded && run.files.length > 0 && (
              <span className="font-sans">
                {run.files.length} {run.files.length === 1 ? "file" : "files"}
              </span>
            )}
            {duration !== undefined && formatDuration(duration)}
            <ChevronRight className={cn("size-3 opacity-0 transition-all group-hover:opacity-100", expanded && "rotate-90 opacity-100")} />
          </span>
        </button>

        {status && (run.status === "active" || run.status === "failed" || technical || run.waiting) && (
          <div className={cn("flex items-center gap-1.5 text-[12px]", run.waiting ? "text-warning" : "text-muted-foreground", run.status === "failed" && "text-destructive")}>
            {run.waiting && <Hourglass className="size-3" />}
            <span className="truncate">{status}</span>
          </div>
        )}

        {expanded && (
          <div className="kivo-in space-y-3 pt-1.5 pb-3">
            <p className="text-[13px] text-muted-foreground">{technical ? step.what : plain(step).doing + "."}</p>

            {run.files.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {run.files.map((f) => (
                  <button key={f} onClick={() => openFile(f)} className="flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground">
                    <FileCode2 className="size-3" />
                    {f.replace(/^services\/[^/]+\//, "")}
                  </button>
                ))}
              </div>
            )}

            {hasLive && <LivePanel step={step} run={run} />}

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              <span className="font-mono">
                {step.executor === "ai" ? "AI" : "Automatic"} · {step.engine}
                {step.tech && ` · ${step.tech}`}
              </span>
              <button
                className="underline-offset-2 hover:text-foreground hover:underline"
                onClick={() => {
                  select({ kind: "step", id: step.id, label: step.title, conceptId: step.concept, detail: step.why })
                  openRight()
                }}
              >
                Why this matters →
              </button>
            </div>
          </div>
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
    if (run.reasoning && !run.output) return "Thinking it through…"
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

// ─── Result ───────────────────────────────────────────────────────────────────

function ResultCard({ spec, build, runs, elapsed, onTab }: { spec: ServiceSpec; build: BuildRun; runs: Record<string, StepRun>; elapsed: number; onTab: (tab: string) => void }) {
  const runInTerminal = useUi((s) => s.runInTerminal)
  const openService = useKivo((s) => s.openService)
  const technical = useTechnical()
  const tests = spec.tests
  const passed = tests.filter((t) => t.status === "pass").length
  const failing = tests.filter((t) => t.status === "fail")
  const failedStep = build.steps.find((st) => runs[st.id]?.status === "failed")
  const main = spec.files.find((f) => f.endsWith("/router.py")) ?? spec.files.find((f) => f.endsWith(".py")) ?? spec.files[0]
  const testCmd = toolchainFor(spec.implementation.language).testCommand?.(spec.id)
  /** Test names are test_<requirement_id>; show the feature people asked for, not the function name. */
  const featureFor = (test: string) => spec.requirements.find((r) => test.includes(r.id))?.title ?? test

  // "written": the code was generated but never installed, tested or started (a build in the browser).
  const tone = !build.real ? "preview" : build.ok ? (build.url ? "ok" : "written") : "fail"
  const title = tone === "preview" ? `${spec.name} is ready to explore` : tone === "ok" ? `${spec.name} is live` : tone === "written" ? `${spec.name}: code written` : `${spec.name} needs a little help`
  const body =
    tone === "preview"
      ? "This was a preview: Kivo walked through the full plan without writing real code. Connect an AI provider in .env to build it for real."
      : tone === "ok"
        ? `${tests.length ? `All ${tests.length} features passed their checks` : "Every check passed"}, and it's running on your computer. Built in ${formatDuration(elapsed)}.`
        : tone === "written"
          ? `Kivo wrote ${spec.files.length} files into services/${spec.id}/ in ${formatDuration(elapsed)}. Nothing has been installed, tested or started yet: in the browser Kivo can't run code. Open this project with Kivo on your computer (npm run dev) to test and run it.`
        : failing.length
          ? `${passed} of ${tests.length} features passed their checks.${build.url ? " It's running anyway, so you can look around." : ""}`
          : failedStep
            ? `Kivo got stuck while ${plain(failedStep).title.charAt(0).toLowerCase() + plain(failedStep).title.slice(1)}.`
            : "The build stopped before it finished."

  return (
    <div className={cn("kivo-in rounded-2xl border p-5 sm:p-6", tone === "ok" && "border-success/30 bg-success/[0.03]", tone === "fail" && "border-destructive/30")}>
      <div className="flex items-start gap-4">
        <div
          className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-full",
            tone === "ok" && "bg-success/15 text-success",
            tone === "fail" && "bg-destructive/10 text-destructive",
            (tone === "preview" || tone === "written") && "bg-muted text-foreground",
          )}
        >
          {tone === "fail" ? <AlertTriangle className="size-5" /> : tone === "preview" ? <Eye className="size-5" /> : tone === "written" ? <FileCode2 className="size-5" /> : <Check className="size-5" strokeWidth={2.5} />}
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="text-[19px] leading-snug font-semibold tracking-tight">{title}</div>
          <p className="text-[14px] text-muted-foreground">{body}</p>

          {tone === "fail" && failing.length > 0 && (
            <ul className="space-y-1 pt-1">
              {failing.map((t) => (
                <li key={t.name} className="flex items-center gap-2 text-[13px]">
                  <X className="size-3.5 shrink-0 text-destructive" />
                  {featureFor(t.name)}
                  {technical && <span className="font-mono text-[11px] text-muted-foreground">{t.name}</span>}
                </li>
              ))}
            </ul>
          )}
          {tone === "fail" && !failing.length && failedStep && (runs[failedStep.id]?.note || build.error) && <p className="font-mono text-[12px] text-muted-foreground">{runs[failedStep.id]?.note || build.error}</p>}

          {build.real && (build.url || build.commit) && (
            <div className="flex flex-wrap gap-x-3 gap-y-1 pt-1 font-mono text-[11px] text-muted-foreground">
              {build.url && <span>{build.url.replace("http://", "")}</span>}
              {build.commit && <span>saved as {build.commit}</span>}
            </div>
          )}
        </div>
      </div>

      <div className="mt-5 flex flex-wrap gap-2 sm:pl-14">
        {tone === "preview" && (
          <>
            <Button size="sm" onClick={() => onTab("overview")}>
              <Eye /> See what was planned
            </Button>
            <Button size="sm" variant="outline" onClick={() => openService(null)}>
              <ArrowLeft /> Build something else
            </Button>
          </>
        )}
        {tone === "written" && (
          <>
            {main && (
              <Button size="sm" onClick={() => openFile(main)}>
                <Code2 /> See the code
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => rebuild(spec.id)}>
              <RotateCw /> Rebuild
            </Button>
          </>
        )}
        {tone === "ok" && (
          <>
            {build.url && (
              <Button size="sm" onClick={() => onTab("api")}>
                <Play /> Try it out
              </Button>
            )}
            {main && (
              <Button size="sm" variant="outline" onClick={() => openFile(main)}>
                <Code2 /> See the code
              </Button>
            )}
            {testCmd && (
              <Button size="sm" variant="outline" onClick={() => runInTerminal(testCmd)}>
                <FlaskConical /> Run checks again
              </Button>
            )}
          </>
        )}
        {tone === "fail" && (
          <>
            <Button size="sm" onClick={() => askAboutFailure(spec.id)}>
              <MessageSquare /> Ask AI what went wrong
            </Button>
            <Button size="sm" variant="outline" onClick={() => rebuild(spec.id)}>
              <RotateCw /> Try again
            </Button>
            {build.url && (
              <Button size="sm" variant="outline" onClick={() => onTab("api")}>
                <Play /> Look around
              </Button>
            )}
            {main && (
              <Button size="sm" variant="ghost" onClick={() => openFile(main)}>
                <Code2 /> Open code
              </Button>
            )}
          </>
        )}
        {tone === "ok" && (
          <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => rebuild(spec.id)}>
            <RotateCw /> Rebuild
          </Button>
        )}
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
