import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { ArrowRight, ArrowUp, Check, ChevronDown, PencilLine, CircleDashed, FileCode2, FlaskConical, Loader2, MessageSquare, Network, Play, Sparkles, SquareTerminal, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { specToYaml } from "@/core/intent"
import { CACHES, DATABASES, frameworkName, frameworksFor, languageName, LANGUAGES } from "@/core/stacks"
import type { ServiceSpec, TechCategory } from "@/core/types"
import { cn } from "@/lib/utils"
import { build as runBuild, openFile, understand } from "@/state/runners"
import { useKivo } from "@/state/store"
import { ApiClient } from "./ApiClient"
import { BuildTimeline } from "./BuildTimeline"
import { SectionLabel, StatusDot } from "@/shell/bits"
import { Capturable, CaptureScope, useUi } from "@/shell/capture"
import { focusWhenReady } from "@/shell/Preferences"

export function BuildView() {
  const { draft, activeServiceId, understanding } = useKivo()
  if (understanding) return <Understanding />
  if (draft) return <IntentReview spec={draft} />
  if (activeServiceId) return <ServiceWorkspace id={activeServiceId} />
  return <BuildHome />
}

// ─── Home: analysis + intent ─────────────────────────────────────────────────

const EXAMPLES = [
  "Create an authentication service where users can register with email and password, verify their email, log in, refresh their session, and reset their password.",
  "Add Stripe payments.",
  "Create a notification system.",
]

function BuildHome() {
  const { analysis, services, openService, build, setMode, select } = useKivo()
  const focusAsk = useUi((s) => s.focusAsk)
  const openRight = useUi((s) => s.openRight)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const groups = analysis.detections.reduce<Record<string, typeof analysis.detections>>((acc, d) => {
    ;(acc[d.category] ??= []).push(d)
    return acc
  }, {})
  const order: TechCategory[] = ["Mobile", "Frontend", "Backend", "Database", "Cache", "Infrastructure", "AI / ML", "Testing", "Tooling"]
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
        <div className="space-y-5">
          <div className="space-y-1.5">
            <h1 className="text-2xl font-semibold tracking-tight">What do you want to build?</h1>
            <p className="text-sm text-muted-foreground">Describe it in plain words. You'll review exactly what Kivo understood before anything is generated.</p>
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
              {build.finished ? (build.ok ? "Ready" : build.real ? "Needs attention" : "Simulated") : `Step ${Math.min(build.index + 1, build.steps.length)} of ${build.steps.length}`}
            </span>
            <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
          </button>
        )}

        <section className="space-y-3">
          <SectionLabel>Or start somewhere else</SectionLabel>
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

        <section className="space-y-3">
          <SectionLabel action={<span className="normal-case">{services.length} total</span>}>Your services</SectionLabel>
          <div className="grid gap-2 sm:grid-cols-2">
            {services.map((s) => (
              <button key={s.id} onClick={() => openService(s.id)} className="group rounded-xl border p-4 text-left transition-colors hover:bg-accent/40">
                <div className="flex items-center gap-2">
                  <StatusDot status={s.status} />
                  <span className="text-sm font-medium">{s.name}</span>
                  <span className="ml-auto text-[11px] text-muted-foreground capitalize">{s.status}</span>
                </div>
                <p className="mt-1 line-clamp-2 text-[13px] text-muted-foreground">{s.purpose}</p>
                <div className="mt-3 font-mono text-[11px] text-muted-foreground">
                  {languageName(s.implementation.language)} · {frameworkName(s.implementation.language, s.implementation.framework)} · {s.api.endpoints.length} endpoints
                </div>
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
  return (
    <div className="space-y-3">
      <div className="rounded-xl border bg-background shadow-xs focus-within:ring-1 focus-within:ring-ring">
        <Textarea
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
          placeholder="Create an authentication service where users can register, log in and reset their password…"
          className="min-h-24 resize-none border-0 bg-transparent! px-4 pt-4 text-[15px] shadow-none focus-visible:ring-0"
        />
        <div className="flex items-center justify-between px-3 pb-3">
          <span className="text-[11px] text-muted-foreground">
            Kivo will show you what it understood before building{ai?.ai ? ` · ${ai.model}` : " · offline templates"}.
          </span>
          <Button size="icon-sm" onClick={go} disabled={!text.trim()} aria-label="Understand">
            <ArrowUp />
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {EXAMPLES.map((e) => (
          <button key={e} onClick={() => setText(e)} className="max-w-full truncate rounded-full border px-3 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
            {e.length > 70 ? `${e.slice(0, 68)}…` : e}
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
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" })
  }, [u.reasoning.length])
  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-3xl space-y-6 px-8 py-10">
        <div className="space-y-3">
          <div className="text-xs text-muted-foreground">You said</div>
          <p className="border-l-2 pl-3 text-[15px]">{u.text}</p>
        </div>
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            {u.error ? <X className="size-4 text-destructive" /> : <Loader2 className="size-4 animate-spin" />}
            {u.error ? "Couldn't understand that" : "Understanding your request…"}
            <span className="font-mono text-[11px] font-normal text-muted-foreground">Intent Agent · {ai?.model}</span>
          </div>
          {u.waiting && <div className="text-xs text-warning">{u.waiting}</div>}
          {u.error ? (
            <div className="space-y-3">
              <p className="text-[13px] text-destructive">{u.error}</p>
              <Button size="sm" variant="outline" onClick={() => understand(u.text)}>
                Try again
              </Button>
            </div>
          ) : (
            <div className="rounded-xl border bg-muted/30 p-4">
              <div className="mb-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Agent reasoning · live</div>
              <p className="font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
                {u.reasoning || "…"}
                <span className="kivo-pulse ml-0.5 inline-block h-3 w-1.5 translate-y-0.5 bg-foreground/60" />
              </p>
              <div ref={end} />
            </div>
          )}
        </div>
      </div>
    </ScrollArea>
  )
}

// ─── Intent review: "I understand this as" ───────────────────────────────────

function IntentReview({ spec }: { spec: ServiceSpec }) {
  const { updateDraft, discardDraft, stack, setStack, ai } = useKivo()
  const frameworks = frameworksFor(stack.language)

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-3xl space-y-8 px-8 py-10">
        <div className="space-y-3">
          <div className="text-xs text-muted-foreground">You said</div>
          <p className="border-l-2 pl-3 text-[15px]">{spec.intent}</p>
        </div>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold tracking-tight">I understand this as:</h2>
          <div className="rounded-xl border p-4 font-mono text-[13px]">
            <Capturable refObj={{ kind: "service", id: spec.id, label: spec.name }} className="-mx-1 inline-block px-1 font-sans font-medium">
              {spec.name}
            </Capturable>
            <ul className="mt-1">
              {spec.requirements.map((r, i) => (
                <li key={r.id} className="group flex items-center gap-2">
                  <span className="text-muted-foreground">{i === spec.requirements.length - 1 ? "└──" : "├──"}</span>
                  <span className="whitespace-nowrap">{r.title}</span>
                  <span className="truncate font-sans text-xs text-muted-foreground">{r.description}</span>
                  {spec.requirements.length > 1 && (
                    <button
                      aria-label={`Remove ${r.title}`}
                      className="ml-auto opacity-0 group-hover:opacity-100"
                      onClick={() => updateDraft({ requirements: spec.requirements.filter((x) => x.id !== r.id), api: { ...spec.api, endpoints: spec.api.endpoints.filter((e) => e.requirement !== r.id) } })}
                    >
                      <X className="size-3.5 text-muted-foreground" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </section>

        {spec.questions && spec.questions.length > 0 && (
          <section className="space-y-2 rounded-xl border border-dashed p-4">
            <div className="text-[13px] font-medium">Open questions</div>
            <p className="text-xs text-muted-foreground">The Intent Agent made sensible defaults for these. Refine your description if a default is wrong.</p>
            <ul className="list-disc space-y-1 pl-5 text-[13px]">
              {spec.questions.map((q, i) => (
                <li key={i}>{typeof q === "string" ? q : JSON.stringify(q)}</li>
              ))}
            </ul>
          </section>
        )}

        <section className="space-y-3">
          <SectionLabel>Proposed stack</SectionLabel>
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <StackSelect label="Language" value={stack.language} onChange={(v) => setStack({ language: v })} options={LANGUAGES.map((l) => ({ value: l.id, label: l.name, mvp: l.mvp }))} />
            <StackSelect label="Framework" value={stack.framework} onChange={(v) => setStack({ framework: v })} options={frameworks.map((f) => ({ value: f.id, label: f.name, hint: f.note, mvp: f.mvp }))} />
            <StackSelect label="Database" value={stack.database ?? "PostgreSQL"} onChange={(v) => setStack({ database: v })} options={DATABASES.map((d) => ({ value: d, label: d }))} />
            <StackSelect label="Session / cache" value={stack.cache ?? "Redis"} onChange={(v) => setStack({ cache: v })} options={CACHES.map((d) => ({ value: d, label: d }))} />
          </div>
          <p className="text-xs text-muted-foreground">Defaults inferred from the repository (FastAPI backend, PostgreSQL + Redis in docker-compose). Frameworks update with the language.</p>
        </section>

        <section className="space-y-3">
          <SectionLabel>Design decisions</SectionLabel>
          <div className="divide-y rounded-xl border">
            {spec.decisions.map((d) => (
              <div key={d.topic} className="grid grid-cols-[140px_1fr] gap-4 p-3 text-[13px]">
                <span className="text-muted-foreground">{d.topic}</span>
                <div>
                  <div className="font-medium">{d.choice}</div>
                  <div className="text-muted-foreground">{d.reason}</div>
                  {d.alternatives.length > 0 && <div className="mt-1 text-xs text-muted-foreground">Alternatives: {d.alternatives.join(", ")}</div>}
                </div>
              </div>
            ))}
          </div>
        </section>

        <Tabs defaultValue="api">
          <TabsList variant="line">
            <TabsTrigger value="api">API</TabsTrigger>
            <TabsTrigger value="data">Data</TabsTrigger>
            <TabsTrigger value="ir">Service IR</TabsTrigger>
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

        <div className="sticky bottom-0 -mx-8 flex flex-wrap items-center gap-2 border-t bg-background/95 px-8 py-4 backdrop-blur">
          <Button onClick={runBuild} className="gap-1.5">
            <Sparkles /> Build {spec.name}
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              useUi.getState().setPrefill(spec.intent)
              discardDraft()
              focusWhenReady("intent-input")
            }}
          >
            <PencilLine /> Refine description
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              discardDraft()
              toast("Draft discarded", { action: { label: "Undo", onClick: () => useKivo.getState().setDraft(spec) } })
            }}
          >
            Discard
          </Button>
          <span className="ml-auto text-xs text-muted-foreground">
            {spec.requirements.length} requirements · {spec.api.endpoints.length} endpoints · {ai?.ai ? "real build: codegen → pip → pytest → boot" : "offline simulation"}
          </span>
        </div>
      </div>
    </ScrollArea>
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
        <span className="text-[13px] text-muted-foreground">One test per requirement, run by pytest.</span>
        <Button size="sm" variant="outline" onClick={() => runInTerminal(`cd services/${spec.id} && pytest -q; cd - >/dev/null`)}>
          <FlaskConical /> Run in terminal
        </Button>
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
