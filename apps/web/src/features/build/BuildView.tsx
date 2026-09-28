import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { AlertTriangle, ArrowRight, Bell, Check, ChevronDown, CircleDashed, Clock, CreditCard, FileCode2, FlaskConical, Info, KeyRound, Lightbulb, Loader2, MessageSquare, Network, PencilLine, Play, Quote, RotateCw, Sparkles, SquareTerminal, Wrench, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { specToYaml } from "@kivo/core/intent"
import { BUILDABLE_LANGUAGES, CACHES, DATABASES, frameworkName, frameworksFor, languageName, LANGUAGES, toolchainFor } from "@kivo/core/stacks"
import type { ServiceSpec, ServiceStatus, TechCategory } from "@kivo/core/types"
import { cn } from "@/lib/utils"
import { build as runBuild, openFile, understand } from "@/state/runners"
import { useKivo } from "@/state/store"
import { WorkspaceView } from "@/features/workspace/WorkspaceView"
import { ApiClient } from "./ApiClient"
import { BuildTimeline } from "./BuildTimeline"
import { Journey, useTechnical } from "./journey"
import { SectionLabel, StatusDot } from "@/shell/bits"
import { Capturable, CaptureScope, useUi } from "@/shell/capture"
import { focusWhenReady } from "@/shell/Preferences"
import { inBrowser, keyInApp } from "@/lib/transport"

export function BuildView() {
  const { draft, activeServiceId, understanding, discipline } = useKivo()
  // Other disciplines have their own home and sections; the intent → build flow is Software's.
  if (discipline !== "software") return <WorkspaceView />
  if (understanding) return <Understanding />
  if (draft) return <IntentReview key={`${draft.id}:${draft.intent}`} spec={draft} />
  if (activeServiceId) return <ServiceWorkspace id={activeServiceId} />
  return <BuildHome />
}

// ─── Home: analysis + intent ─────────────────────────────────────────────────

const EXAMPLES = [
  {
    icon: KeyRound,
    label: "Sign-up & login",
    text: "Create an authentication service where users can register with email and password, verify their email, log in, refresh their session, and reset their password.",
  },
  { icon: CreditCard, label: "Online payments", text: "Add Stripe payments." },
  { icon: Bell, label: "Notifications", text: "Create a notification system." },
]

const STATUS_LABEL: Partial<Record<ServiceStatus, string>> = { draft: "Draft", planned: "Planned", building: "Building", generated: "Code written", ready: "Ready", running: "Running", failed: "Needs attention" }

function BuildHome() {
  const { analysis, services, openService, build, setMode, select } = useKivo()
  const technical = useTechnical()
  const focusAsk = useUi((s) => s.focusAsk)
  const openRight = useUi((s) => s.openRight)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const groups = analysis.detections.reduce<Record<string, typeof analysis.detections>>((acc, d) => {
    ;(acc[d.category] ??= []).push(d)
    return acc
  }, {})
  const order: TechCategory[] = ["Mobile", "Frontend", "Backend", "Database", "Cache", "Data", "Infrastructure", "AI / ML", "Embedded", "Game", "Security", "Testing", "Tooling"]
  const lastBuilt = build ? services.find((s) => s.id === build.specId) : undefined
  const paths = [
    { icon: Network, title: "Explore the architecture", body: "How the pieces connect", go: () => setMode("learn") },
    { icon: FileCode2, title: "Open the code", body: "Edit with inline AI", go: () => setMode("code") },
    {
      icon: MessageSquare,
      title: "Ask about this project",
      body: "Answers grounded in your code",
      go: () => {
        select({ kind: "concept", id: "project", label: analysis.summary, detail: `The ${analysis.summary} project` }, "ai")
        openRight()
        focusAsk()
      },
    },
  ]

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-3xl space-y-10 px-6 py-12 sm:px-8">
        <div className="space-y-6">
          <div className="space-y-2">
            <h1 className="text-[28px] leading-tight font-semibold tracking-tight">What do you want to build?</h1>
            <p className="text-[15px] text-muted-foreground">Describe it the way you'd explain it to a colleague. Kivo shows you its plan first, and nothing is built until you say so.</p>
          </div>
          <IntentComposer />
        </div>

        {build && lastBuilt && (
          <button onClick={() => openService(lastBuilt.id)} className="group flex w-full items-center gap-3 rounded-xl border p-4 text-left transition-colors hover:bg-accent/40">
            {build.finished ? (
              <StatusDot status={lastBuilt.status} className="size-2" />
            ) : (
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            )}
            <div className="min-w-0 flex-1">
              <div className="text-[11px] text-muted-foreground">{build.finished ? "Last build" : "Building now"}</div>
              <div className="truncate text-sm font-medium">{lastBuilt.name}</div>
            </div>
            <span className="text-xs text-muted-foreground">
              {build.finished ? (!build.real ? "Preview ready" : build.ok ? "Ready" : "Needs attention") : `Step ${Math.min(build.index + 1, build.steps.length)} of ${build.steps.length}`}
            </span>
            <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
          </button>
        )}

        <section className="space-y-3">
          <SectionLabel action={<span className="normal-case">{services.length} total</span>}>Your services</SectionLabel>
          <div className="grid gap-2 sm:grid-cols-2">
            {services.map((s) => (
              <button key={s.id} onClick={() => openService(s.id)} className="group rounded-xl border p-4 text-left transition-colors hover:bg-accent/40">
                <div className="flex items-center gap-2">
                  <StatusDot status={s.status} />
                  <span className="text-sm font-medium">{s.name}</span>
                  <span className="ml-auto text-[11px] text-muted-foreground">{STATUS_LABEL[s.status] ?? s.status}</span>
                </div>
                <p className="mt-1 line-clamp-2 text-[13px] text-muted-foreground">{s.purpose}</p>
                <div className="mt-3 text-[11px] text-muted-foreground">
                  {technical ? (
                    <span className="font-mono">
                      {languageName(s.implementation.language)} · {frameworkName(s.implementation.language, s.implementation.framework)} · {s.api.endpoints.length} endpoints
                    </span>
                  ) : (
                    <>
                      {s.api.endpoints.length} {s.api.endpoints.length === 1 ? "action" : "actions"} · {frameworkName(s.implementation.language, s.implementation.framework)}
                    </>
                  )}
                </div>
              </button>
            ))}
          </div>
        </section>

        <section className="space-y-3">
          <SectionLabel>Other things you can do</SectionLabel>
          <div className="grid gap-2 sm:grid-cols-3">
            {paths.map((p) => (
              <button key={p.title} onClick={p.go} className="group rounded-xl border p-3.5 text-left transition-colors hover:bg-accent/40">
                <p.icon className="size-4 text-muted-foreground transition-colors group-hover:text-foreground" />
                <div className="mt-3 text-[13px] font-medium">{p.title}</div>
                <div className="text-xs text-muted-foreground">{p.body}</div>
              </button>
            ))}
          </div>
        </section>

        <section className="rounded-xl border">
          <button onClick={() => setDetailsOpen((v) => !v)} aria-expanded={detailsOpen} className="flex w-full items-center gap-3 px-4 py-3 text-left">
            <div className="flex h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-muted">
              {analysis.languages.map((l, i) => (
                <div key={l.name} style={{ width: `${l.share}%`, opacity: 1 - i * 0.25 }} className="bg-foreground" />
              ))}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium">What Kivo found in this project</div>
              <div className="truncate text-xs text-muted-foreground">
                {analysis.summary} · {analysis.detections.length} technologies · {analysis.languages.map((l) => `${l.name} ${l.share}%`).join(" · ")}
              </div>
            </div>
            <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", detailsOpen && "rotate-180")} />
          </button>
          {detailsOpen && (
            <div className="kivo-in border-t">
              <div className="grid grid-cols-2 gap-px overflow-hidden rounded-b-xl bg-border sm:grid-cols-3">
                {order
                  .filter((c) => groups[c])
                  .map((cat) => (
                    <div key={cat} className="space-y-1.5 bg-background p-4">
                      <div className="text-[11px] text-muted-foreground">{cat}</div>
                      {groups[cat].map((d) => (
                        <Capturable
                          key={d.tech}
                          refObj={{ kind: "concept", id: d.tech, label: d.tech, conceptId: conceptIdFor(d.tech), detail: `Detected from ${d.evidence}` }}
                          className="-mx-1 flex items-center justify-between px-1 text-[13px] hover:bg-accent"
                        >
                          <span>{d.tech}</span>
                          <span className="truncate pl-2 font-mono text-[10px] text-muted-foreground">{d.evidence.split("/").pop()}</span>
                        </Capturable>
                      ))}
                    </div>
                  ))}
              </div>
              <p className="border-t px-4 py-2.5 text-[11px] text-muted-foreground">Detected deterministically from manifests and config files — no AI involved. Click any technology to learn about it.</p>
            </div>
          )}
        </section>
      </div>
    </ScrollArea>
  )
}

function conceptIdFor(tech: string) {
  return (
    {
      PostgreSQL: "postgresql",
      Redis: "redis",
      FastAPI: "fastapi",
      Docker: "docker",
      "React Native": "react-native",
      Expo: "react-native",
    } as Record<string, string>
  )[tech]
}

function IntentComposer() {
  const ai = useKivo((s) => s.ai)
  const [text, setText] = useState(() => useUi.getState().prefill ?? "")
  // Consume the pre-fill once it has been shown.
  useEffect(() => {
    if (useUi.getState().prefill) useUi.getState().setPrefill(null)
  }, [])
  const go = () => text.trim() && understand(text)
  const input = useRef<HTMLTextAreaElement>(null)
  return (
    <div className="space-y-3">
      <div data-tour="intent" className="rounded-2xl border bg-background shadow-xs transition-shadow focus-within:border-foreground/30 focus-within:shadow-md">
        <label htmlFor="intent-input" className="sr-only">
          Describe what you want to build
        </label>
        <Textarea
          ref={input}
          id="intent-input"
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
              e.preventDefault()
              go()
            }
          }}
          placeholder="e.g. A way for people to sign up, log in and reset their password"
          className="min-h-28 resize-none border-0 bg-transparent! px-4 pt-4 text-[15px] leading-relaxed shadow-none focus-visible:ring-0"
        />
        <div className="flex items-center gap-3 px-3 pb-3">
          <span className="hidden text-[11px] text-muted-foreground sm:inline">
            <Kbd>↵</Kbd> to continue · <Kbd>⇧↵</Kbd> new line
          </span>
          {!ai?.ai && (
            <span title={keyInApp() ? "No AI yet, so builds are simulated. Add your Groq key in Preferences to generate real code." : "No AI provider is connected, so builds are simulated. Add a key in .env to generate real code."} className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground">
              Preview mode
            </span>
          )}
          <Button size="sm" onClick={go} disabled={!text.trim()} className="ml-auto gap-1.5">
            Continue <ArrowRight />
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-xs text-muted-foreground">Try an example:</span>
        {EXAMPLES.map((e) => (
          <button
            key={e.label}
            title={e.text}
            onClick={() => {
              setText(e.text)
              input.current?.focus()
            }}
            className="flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <e.icon className="size-3.5" />
            {e.label}
          </button>
        ))}
      </div>
    </div>
  )
}

// ─── Understanding (live) ──────────────────────────────────────────────────

function Understanding() {
  const u = useKivo((s) => s.understanding)!
  const ai = useKivo((s) => s.ai)
  const technical = useTechnical()
  const [showThinking, setShowThinking] = useState(technical)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight
  }, [u.reasoning.length, showThinking])
  const editDescription = () => {
    useUi.getState().setPrefill(u.text)
    useKivo.setState({ understanding: null })
    focusWhenReady("intent-input")
  }

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-3xl space-y-8 px-6 py-10 sm:px-8">
        <Journey stage="Review" />
        <YouSaid text={u.text} />

        {u.error ? (
          <div className="kivo-in space-y-4 rounded-2xl border border-destructive/30 p-5">
            <div className="flex items-start gap-3">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive">
                <AlertTriangle className="size-4" />
              </div>
              <div className="space-y-1">
                <div className="text-[15px] font-medium">Kivo couldn't read that request</div>
                <p className="text-[13px] text-muted-foreground">This is usually temporary. Try again, or reword your description.</p>
                <p className="pt-1 font-mono text-[12px] text-muted-foreground">{u.error}</p>
              </div>
            </div>
            <div className="flex gap-2 pl-11">
              <Button size="sm" onClick={() => understand(u.text)}>
                <RotateCw /> Try again
              </Button>
              <Button size="sm" variant="outline" onClick={editDescription}>
                <PencilLine /> Edit description
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-4">
              <div className="relative flex size-10 shrink-0 items-center justify-center rounded-full border">
                <Sparkles className="kivo-pulse size-4" />
              </div>
              <div className="min-w-0">
                <div className="text-[17px] font-medium">Working out what you need…</div>
                <p className="text-[13px] text-muted-foreground">{u.waiting ?? "Picking out the features, the data to store and the key design choices. This usually takes a few seconds."}</p>
              </div>
            </div>
            <div className="space-y-2 pl-14">
              {["Features you asked for", "Information it needs to keep", "How it should be built"].map((t, i) => (
                <div key={t} className="flex items-center gap-2 text-[13px] text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" style={{ animationDelay: `${i * 150}ms` }} /> {t}
                </div>
              ))}
            </div>
            {ai?.ai && (
              <div className="pl-14">
                <button onClick={() => setShowThinking((v) => !v)} aria-expanded={showThinking} className="flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground">
                  <ChevronDown className={cn("size-3.5 transition-transform", !showThinking && "-rotate-90")} />
                  {showThinking ? "Hide" : "Show"} the AI's thinking
                </button>
                {showThinking && (
                  <div ref={box} className="kivo-in mt-2 max-h-72 overflow-auto rounded-xl border bg-muted/30 p-4">
                    <div className="mb-2 font-mono text-[11px] text-muted-foreground/70">Intent Agent · {ai.model}</div>
                    <p className="font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
                      {u.reasoning || "…"}
                      <span className="kivo-pulse ml-0.5 inline-block h-3 w-1.5 translate-y-0.5 bg-foreground/60" />
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </ScrollArea>
  )
}

// ─── Intent review: "I understand this as" ───────────────────────────────────

function IntentReview({ spec }: { spec: ServiceSpec }) {
  const { updateDraft, discardDraft, stack, setStack, ai, daemon, services } = useKivo()
  const technical = useTechnical()
  const frameworks = frameworksFor(stack.language)
  const real = daemon && !!ai?.ai
  const lang = spec.implementation.language
  const buildable = toolchainFor(lang).buildable
  const machine = ai?.toolchains?.[lang]
  // Real builds need a pipeline for the language AND the tools on this machine. Preview builds are simulated either way.
  const blocked = real && (!buildable || machine?.ok === false)
  const twin = spec.sameNameAs ? services.find((x) => x.id === spec.sameNameAs) : undefined
  // Remember the full proposal so features can be switched off and back on again.
  const [original] = useState(() => ({ requirements: spec.requirements, endpoints: spec.api.endpoints }))
  const included = new Set(spec.requirements.map((r) => r.id))
  const [detailsOpen, setDetailsOpen] = useState(technical)

  const toggle = (id: string) => {
    const next = new Set(included)
    if (next.has(id)) {
      if (next.size === 1) return
      next.delete(id)
    } else next.add(id)
    const excluded = new Set(original.requirements.map((r) => r.id).filter((x) => !next.has(x)))
    updateDraft({ requirements: original.requirements.filter((r) => next.has(r.id)), api: { ...spec.api, endpoints: original.endpoints.filter((e) => !excluded.has(e.requirement)) } })
  }
  const editDescription = () => {
    useUi.getState().setPrefill(spec.intent)
    discardDraft()
    focusWhenReady("intent-input")
  }
  const stackLine = [frameworkName(stack.language, stack.framework), stack.database ?? spec.storage.type, spec.cache ? stack.cache : undefined].filter(Boolean).join(" · ")

  return (
    <div className="flex h-full flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="kivo-in mx-auto max-w-3xl space-y-10 px-6 py-10 sm:px-8">
          <div className="space-y-6">
            <Journey stage="Review" />
            <div className="space-y-2">
              <div className="text-[13px] text-muted-foreground">Here's what Kivo will build</div>
              <Capturable refObj={{ kind: "service", id: spec.id, label: spec.name }} className="-mx-1 inline-block px-1 text-[28px] leading-tight font-semibold tracking-tight data-active:bg-transparent data-active:ring-0 hover:bg-accent/60">
                {spec.name}
              </Capturable>
              <p className="text-[15px] text-muted-foreground">{spec.purpose}</p>
            </div>
            <YouSaid text={spec.intent} onEdit={editDescription} />
          </div>

          <section className="space-y-3">
            <div className="flex items-baseline justify-between px-1">
              <h2 className="text-[15px] font-medium">What it will do</h2>
              <span className="text-xs text-muted-foreground">
                {included.size} of {original.requirements.length} features · untick anything you don't need
              </span>
            </div>
            <ul className="divide-y rounded-2xl border">
              {original.requirements.map((r) => {
                const on = included.has(r.id)
                const locked = on && included.size === 1
                return (
                  <li key={r.id}>
                    <label className={cn("flex cursor-pointer items-start gap-3 px-4 py-3.5 transition-colors hover:bg-accent/40", locked && "cursor-default")}>
                      <input type="checkbox" checked={on} disabled={locked} onChange={() => toggle(r.id)} className="peer sr-only" />
                      <span
                        aria-hidden
                        className={cn(
                          "mt-0.5 flex size-[18px] shrink-0 items-center justify-center rounded-[5px] border transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-ring",
                          on ? "border-foreground bg-foreground text-background" : "border-muted-foreground/40",
                        )}
                      >
                        {on && <Check className="size-3" strokeWidth={3} />}
                      </span>
                      <span className="min-w-0">
                        <span className={cn("block text-[14px] font-medium", !on && "text-muted-foreground line-through decoration-muted-foreground/40")}>{r.title}</span>
                        {r.description && <span className="block text-[13px] text-muted-foreground">{r.description}</span>}
                      </span>
                    </label>
                  </li>
                )
              })}
            </ul>
          </section>

          {!buildable && (
            <section className={cn("space-y-3 rounded-2xl border p-5", real ? "border-warning/40 bg-warning/[0.04]" : "bg-muted/40")}>
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
                <div className="space-y-1">
                  <h2 className="text-[14px] font-medium">Kivo can plan {languageName(lang)} services, but can't build them yet</h2>
                  <p className="text-[13px] text-muted-foreground">
                    Everything above is designed for {languageName(lang)} · {frameworkName(lang, spec.implementation.framework)}. Building means writing the code, installing it, running the tests and starting it — Kivo can
                    only do all of that for {BUILDABLE_LANGUAGES.map((l) => l.name).join(", ")} today, and it won't pretend otherwise.
                    {!real && " In preview mode you can still walk through a simulated build."}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2 pl-7">
                {BUILDABLE_LANGUAGES.map((l) => (
                  <Button key={l.id} size="sm" variant={real ? "default" : "outline"} onClick={() => setStack({ language: l.id })}>
                    Use {l.name} instead
                  </Button>
                ))}
              </div>
            </section>
          )}

          {buildable && real && machine?.ok === false && (
            <section className="flex items-start gap-3 rounded-2xl border border-destructive/30 p-5">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
              <div className="space-y-1">
                <h2 className="text-[14px] font-medium">This computer is missing a tool Kivo needs</h2>
                <p className="text-[13px] text-muted-foreground">{machine.message}</p>
              </div>
            </section>
          )}

          {twin && (
            <section className="flex items-start gap-3 rounded-2xl bg-muted/40 p-5">
              <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <p className="text-[13px] text-muted-foreground">
                You already have a <span className="font-medium text-foreground">{twin.name}</span> service ({languageName(twin.implementation.language)} · {frameworkName(twin.implementation.language, twin.implementation.framework)}). This one is built
                separately, in <span className="font-mono text-[12px]">services/{spec.id}</span>, so the existing service isn't touched.
              </p>
            </section>
          )}

          {spec.questions && spec.questions.length > 0 && (
            <section className="space-y-3 rounded-2xl bg-muted/40 p-5">
              <div className="flex items-center gap-2">
                <Lightbulb className="size-4 text-warning" />
                <h2 className="text-[14px] font-medium">A few things Kivo assumed</h2>
              </div>
              <ul className="space-y-1.5 pl-6 text-[13px]">
                {spec.questions.map((q, i) => (
                  <li key={i} className="list-disc marker:text-muted-foreground">
                    {typeof q === "string" ? q : JSON.stringify(q)}
                  </li>
                ))}
              </ul>
              <p className="pl-6 text-xs text-muted-foreground">
                If any of these are wrong,{" "}
                <button onClick={editDescription} className="underline underline-offset-2 hover:text-foreground">
                  edit your description
                </button>{" "}
                and mention it.
              </p>
            </section>
          )}

          <section className="rounded-2xl border">
            <button onClick={() => setDetailsOpen((v) => !v)} aria-expanded={detailsOpen} className="flex w-full items-center gap-3 px-4 py-3.5 text-left">
              <Wrench className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-medium">Technical details</div>
                <div className="truncate text-xs text-muted-foreground">
                  {stackLine} · {spec.api.endpoints.length} endpoints · {spec.decisions.length} design decisions
                </div>
              </div>
              <span className="hidden text-xs text-muted-foreground sm:inline">{detailsOpen ? "Hide" : "Review or change"}</span>
              <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", detailsOpen && "rotate-180")} />
            </button>
            {detailsOpen && (
              <div className="kivo-in space-y-8 border-t p-4 sm:p-5">
                <div className="space-y-3">
                  <SectionLabel>Stack</SectionLabel>
                  <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
                    <StackSelect label="Language" value={stack.language} onChange={(v) => setStack({ language: v })} options={LANGUAGES.map((l) => ({ value: l.id, label: l.name, mvp: l.mvp }))} />
                    <StackSelect label="Framework" value={stack.framework} onChange={(v) => setStack({ framework: v })} options={frameworks.map((f) => ({ value: f.id, label: f.name, hint: f.note, mvp: f.mvp }))} />
                    <StackSelect label="Database" value={stack.database ?? "PostgreSQL"} onChange={(v) => setStack({ database: v })} options={DATABASES.map((d) => ({ value: d, label: d }))} />
                    <StackSelect label="Session / cache" value={stack.cache ?? "Redis"} onChange={(v) => setStack({ cache: v })} options={CACHES.map((d) => ({ value: d, label: d }))} />
                  </div>
                  <p className="text-xs text-muted-foreground">Matched to what's already in this project, so the new service fits in.</p>
                </div>

                <div className="space-y-3">
                  <SectionLabel>Why it's built this way</SectionLabel>
                  <div className="divide-y rounded-xl border">
                    {spec.decisions.map((d) => (
                      <div key={d.topic} className="grid gap-1 p-3 text-[13px] sm:grid-cols-[140px_1fr] sm:gap-4">
                        <span className="text-muted-foreground">{d.topic}</span>
                        <div>
                          <div className="font-medium">{d.choice}</div>
                          <div className="text-muted-foreground">{d.reason}</div>
                          {d.alternatives.length > 0 && <div className="mt-1 text-xs text-muted-foreground">Also considered: {d.alternatives.join(", ")}</div>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <Tabs defaultValue="api">
                  <TabsList variant="line">
                    <TabsTrigger value="api">API</TabsTrigger>
                    <TabsTrigger value="data">Data</TabsTrigger>
                    <TabsTrigger value="ir">Spec (YAML)</TabsTrigger>
                  </TabsList>
                  <TabsContent value="api" className="pt-3">
                    <EndpointTable spec={spec} />
                  </TabsContent>
                  <TabsContent value="data" className="pt-3">
                    <Entities spec={spec} />
                  </TabsContent>
                  <TabsContent value="ir" className="pt-3">
                    <CaptureScope source="code">
                      <pre className="overflow-x-auto rounded-xl border bg-muted/30 p-4 font-mono text-[12px] leading-5">{specToYaml(spec)}</pre>
                    </CaptureScope>
                  </TabsContent>
                </Tabs>
              </div>
            )}
          </section>
        </div>
      </ScrollArea>

      <div className="border-t bg-background">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-2 px-6 py-3.5 sm:px-8">
          <Button onClick={runBuild} disabled={blocked} className="gap-1.5">
            <Sparkles /> Build {spec.name}
          </Button>
          <Button variant="outline" onClick={editDescription}>
            <PencilLine /> Edit description
          </Button>
          <Button
            variant="ghost"
            className="text-muted-foreground"
            onClick={() => {
              discardDraft()
              toast("Plan discarded", { action: { label: "Undo", onClick: () => useKivo.getState().setDraft(spec) } })
            }}
          >
            Discard
          </Button>
          <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
            <Clock className="size-3.5" />
            {blocked
              ? `Can't build ${languageName(lang)} here yet`
              : real
                ? inBrowser
                  ? "Writes the code in your browser · installing, testing and running it need Kivo on your computer"
                  : "Takes about 1–4 minutes · you can watch every step"
                : inBrowser
                  ? "Preview mode · add your Groq key in Preferences for a real build"
                  : "Preview mode · a simulated build, about 10 seconds"}
          </span>
        </div>
      </div>
    </div>
  )
}

function YouSaid({ text, onEdit }: { text: string; onEdit?: () => void }) {
  return (
    <div className="group flex items-start gap-3 rounded-xl bg-muted/40 px-4 py-3">
      <Quote className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="text-[11px] text-muted-foreground">You asked for</div>
        <p className="text-[14px] leading-relaxed">{text}</p>
      </div>
      {onEdit && (
        <button onClick={onEdit} className="shrink-0 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
          Edit
        </button>
      )}
    </div>
  )
}

function StackSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string; hint?: string; mvp?: boolean }[] }) {
  return (
    <div className="space-y-1">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger size="sm" className="w-full">
          <SelectValue>{options.find((o) => o.value === value)?.label ?? "—"}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
              {o.hint && <span className="text-xs text-muted-foreground">{o.hint}</span>}
              {o.mvp === false || o.mvp === undefined ? null : (
                <Badge variant="outline" className="h-4 px-1 text-[9px]">
                  MVP
                </Badge>
              )}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function EndpointTable({ spec }: { spec: ServiceSpec }) {
  return (
    <div className="rounded-xl border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-20">Method</TableHead>
            <TableHead>Path</TableHead>
            <TableHead>Purpose</TableHead>
            <TableHead className="w-14 text-right">Auth</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {spec.api.endpoints.map((e) => (
            <Capturable key={e.method + e.path} as="tr" refObj={{ kind: "endpoint", id: `${e.method} ${e.path}`, label: `${e.method} ${e.path}`, conceptId: "rest", detail: e.summary }} className="rounded-none border-b last:border-0 hover:bg-accent/50">
              <TableCell className="font-mono text-[11px] text-muted-foreground">{e.method}</TableCell>
              <TableCell className="font-mono text-[12px]">{e.path}</TableCell>
              <TableCell className="text-[13px] text-muted-foreground">{e.summary || "—"}</TableCell>
              <TableCell className="text-right">{e.auth && <Check className="ml-auto size-3.5" />}</TableCell>
            </Capturable>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function Entities({ spec }: { spec: ServiceSpec }) {
  if (!spec.entities.length) return <p className="text-[13px] text-muted-foreground">Detected from repository — schema is read from existing models.</p>
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {spec.entities.map((e) => (
        <Capturable key={e.name} refObj={{ kind: "entity", id: e.name, label: e.name, conceptId: "postgresql", detail: e.fields.map((f) => `${f.name}: ${f.type}`).join(", ") }} className="rounded-xl border hover:bg-accent/30">
          <div className="border-b px-3 py-2 text-[13px] font-medium">{e.name}</div>
          <div className="space-y-1 p-3 font-mono text-[12px]">
            {e.fields.map((f) => (
              <div key={f.name} className="flex gap-2">
                <span>{f.name}</span>
                <span className="text-muted-foreground">{f.type}</span>
                {f.note && <span className="ml-auto truncate font-sans text-[11px] text-muted-foreground">{f.note}</span>}
              </div>
            ))}
          </div>
        </Capturable>
      ))}
    </div>
  )
}

// ─── Service workspace ────────────────────────────────────────────────────────

type ServiceTab = "overview" | "build" | "api" | "code" | "tests" | "spec"

function ServiceWorkspace({ id }: { id: string }) {
  const { services, build } = useKivo()
  const spec = services.find((s) => s.id === id)
  const hasBuild = build?.specId === id
  const needsBuildView = hasBuild && (!build.finished || !build.ok)
  const [tab, setTab] = useState<ServiceTab>(needsBuildView ? "build" : "overview")

  // Jump to the build timeline whenever a new build of this service starts.
  const startedAt = hasBuild ? build.startedAt : 0
  useEffect(() => {
    if (startedAt) setTab("build")
  }, [startedAt])

  if (!spec) return null
  const generated = spec.intent !== "(detected from repository)"
  const tabs: { id: ServiceTab; label: string; show: boolean }[] = [
    { id: "overview", label: "Overview", show: true },
    { id: "build", label: "Build", show: hasBuild },
    { id: "api", label: "API", show: true },
    { id: "code", label: "Code", show: true },
    { id: "tests", label: "Tests", show: generated },
    { id: "spec", label: "Spec", show: true },
  ]

  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-4 pt-4 sm:px-8">
        <div className="flex items-center gap-3">
          <StatusDot status={spec.status} className="size-2" />
          <div className="min-w-0 flex-1">
            <Capturable refObj={{ kind: "service", id: spec.id, label: spec.name }} className="-mx-1 inline-block px-1 text-lg font-semibold tracking-tight data-active:bg-transparent data-active:ring-0 hover:bg-accent/60">
              {spec.name}
            </Capturable>
            <p className="truncate text-[13px] text-muted-foreground">{spec.purpose}</p>
          </div>
          <div className="hidden shrink-0 items-center gap-1.5 lg:flex">
            <Badge variant="outline" className="font-mono text-[11px]">
              {languageName(spec.implementation.language)} · {frameworkName(spec.implementation.language, spec.implementation.framework)}
            </Badge>
            {spec.storage.type && (
              <Badge variant="outline" className="font-mono text-[11px]">
                {spec.storage.type}
              </Badge>
            )}
          </div>
        </div>
        <nav className="-mb-px mt-3 flex gap-1 overflow-x-auto [scrollbar-width:none]">
          {tabs
            .filter((t) => t.show)
            .map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                data-active={tab === t.id || undefined}
                className="relative shrink-0 px-2.5 pb-2.5 text-[13px] text-muted-foreground hover:text-foreground data-active:text-foreground"
              >
                {t.label}
                {t.id === "build" && hasBuild && !build.finished && <span className="kivo-pulse ml-1.5 inline-block size-1.5 rounded-full bg-info align-middle" />}
                {t.id === "build" && hasBuild && build.finished && !build.ok && <span className="ml-1.5 inline-block size-1.5 rounded-full bg-destructive align-middle" />}
                {tab === t.id && <span className="absolute inset-x-2.5 bottom-0 h-px bg-foreground" />}
              </button>
            ))}
        </nav>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {tab === "build" && hasBuild ? (
          <BuildTimeline spec={spec} onTab={(t) => setTab(t as ServiceTab)} />
        ) : (
          <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-8">
            {tab === "overview" && <Overview spec={spec} onTab={setTab} />}
            {tab === "api" && <ApiTab spec={spec} />}
            {tab === "code" && <CodeTab spec={spec} />}
            {tab === "tests" && <TestsTab spec={spec} />}
            {tab === "spec" && (
              <div className="space-y-6">
                <Entities spec={spec} />
                <CaptureScope source="code">
                  <pre className="overflow-x-auto rounded-xl border bg-muted/30 p-4 font-mono text-[12px] leading-5">{specToYaml(spec)}</pre>
                </CaptureScope>
              </div>
            )}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}

function liveBuild(specId: string) {
  const b = useKivo.getState().build
  return b?.specId === specId && b.url ? b : null
}

function Overview({ spec, onTab }: { spec: ServiceSpec; onTab: (t: ServiceTab) => void }) {
  const { traces, services } = useKivo()
  useKivo((s) => s.build) // re-render on build changes
  const runInTerminal = useUi((s) => s.runInTerminal)
  const live = liveBuild(spec.id)
  const prefix = spec.api.endpoints[0]?.path.split("/")[1]
  const mine = traces.filter((t) => t.route.split("/")[1] === prefix)
  const passed = spec.tests.filter((t) => t.status === "pass").length

  return (
    <div className="space-y-8">
      {live && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border p-4">
          <StatusDot status={live.ok ? "running" : "slow"} className="size-2" />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium">{live.ok ? "Live" : "Running for inspection — tests failing"}</div>
            <div className="truncate font-mono text-[12px] text-muted-foreground">{live.url}</div>
          </div>
          <Button size="sm" onClick={() => onTab("api")}>
            <Play /> Try the API
          </Button>
          <Button size="sm" variant="outline" onClick={() => runInTerminal(`curl -s ${live.url}/health && echo`)}>
            <SquareTerminal /> curl
          </Button>
        </div>
      )}

      <div className="grid grid-cols-3 divide-x rounded-xl border">
        <Metric label="Endpoints" value={spec.api.endpoints.length} />
        <Metric label="Tests" value={spec.tests.length ? `${passed}/${spec.tests.length}` : "—"} />
        <Metric label="Requests" value={live ? "live" : mine.length} />
      </div>

      {spec.requirements.length > 0 && (
        <section className="space-y-2">
          <SectionLabel>Requirements</SectionLabel>
          <div className="divide-y rounded-xl border">
            {spec.requirements.map((r) => {
              const test = spec.tests.find((t) => t.name.includes(r.id))
              return (
                <div key={r.id} className="flex items-center gap-3 px-3 py-2.5 text-[13px]">
                  {test ? test.status === "pass" ? <Check className="size-3.5 shrink-0 text-success" /> : <X className="size-3.5 shrink-0 text-destructive" /> : <CircleDashed className="size-3.5 shrink-0 text-muted-foreground/60" />}
                  <span className="shrink-0">{r.title}</span>
                  <span className="truncate text-muted-foreground">{r.description}</span>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {spec.decisions.length > 0 && (
        <section className="space-y-2">
          <SectionLabel>Why it's built this way</SectionLabel>
          <div className="divide-y rounded-xl border text-[13px]">
            {spec.decisions.map((d) => (
              <div key={d.topic} className="grid gap-1 p-3 sm:grid-cols-[140px_1fr] sm:gap-4">
                <span className="text-muted-foreground">{d.topic}</span>
                <span>
                  <span className="font-medium">{d.choice}</span> <span className="text-muted-foreground">— {d.reason}</span>
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="space-y-2">
        <SectionLabel>Depends on</SectionLabel>
        <div className="flex flex-wrap gap-1.5">
          {[spec.storage.type, spec.cache?.type, ...spec.dependsOn.map((d) => services.find((s) => s.id === d)?.name ?? d)].filter(Boolean).map((d) => (
            <Badge key={d} variant="secondary">
              {d}
            </Badge>
          ))}
        </div>
      </section>
    </div>
  )
}

function ApiTab({ spec }: { spec: ServiceSpec }) {
  useKivo((s) => s.build)
  const live = liveBuild(spec.id)
  if (live) return <ApiClient service={spec.id} />
  return (
    <div className="space-y-4">
      <p className="text-[13px] text-muted-foreground">
        {spec.intent === "(detected from repository)" ? "This service runs outside Kivo's sandbox, so requests can't be sent from here yet." : "Build this service to send real requests to it from here."}
      </p>
      <EndpointTable spec={spec} />
    </div>
  )
}

function CodeTab({ spec }: { spec: ServiceSpec }) {
  if (!spec.files.length) return <p className="text-[13px] text-muted-foreground">No files yet. They appear here as the build writes them.</p>
  return (
    <div className="divide-y rounded-xl border">
      {spec.files.map((f) => (
        <button key={f} onClick={() => openFile(f)} className="flex w-full items-center gap-2 px-3 py-2.5 text-left font-mono text-[12px] hover:bg-accent/50">
          <FileCode2 className="size-3.5 text-muted-foreground" /> {f}
          <ArrowRight className="ml-auto size-3 text-muted-foreground" />
        </button>
      ))}
    </div>
  )
}

function TestsTab({ spec }: { spec: ServiceSpec }) {
  const runInTerminal = useUi((s) => s.runInTerminal)
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-[13px] text-muted-foreground">One test per requirement, run by {toolchainFor(spec.implementation.language).test}.</span>
        {toolchainFor(spec.implementation.language).testCommand && (
          <Button size="sm" variant="outline" onClick={() => runInTerminal(`${toolchainFor(spec.implementation.language).testCommand!(spec.id)}; cd - >/dev/null`)}>
            <FlaskConical /> Run in terminal
          </Button>
        )}
      </div>
      {spec.tests.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">No test results yet.</p>
      ) : (
        <div className="divide-y rounded-xl border font-mono text-[12px]">
          {spec.tests.map((t) => (
            <div key={t.name} className="flex items-center gap-2 px-3 py-2.5">
              {t.status === "pass" ? <Check className="size-3.5 text-success" /> : <X className="size-3.5 text-destructive" />} {t.name}
              <span className={cn("ml-auto", t.status === "pass" ? "text-muted-foreground" : "text-destructive")}>{t.status === "pass" ? "passed" : "failed"}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="p-4">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="font-mono text-lg tabular-nums">{value}</div>
    </div>
  )
}

export function median(xs: number[]) {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return Math.round(s[Math.floor(s.length / 2)] * 10) / 10
}
