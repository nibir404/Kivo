import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { ArrowRight, BookOpen, Bot, ChevronRight, Cpu, Eraser, History, Lightbulb, MessageSquare, MousePointerClick, Sparkles, Wand2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { CONCEPTS } from "@/core/concepts"
import { assembleContext, learningInsights } from "@/core/context"
import type { Concept, KivoRef, Level, RuntimeSpan } from "@/core/types"
import { cn } from "@/lib/utils"
import { ask, explainInline } from "@/state/runners"
import { useKivo } from "@/state/store"
import { AgentMessages } from "@/features/agent/AgentView"
import { Composer } from "@/features/agent/Composer"
import { askWithMentions, clearAgent, runAgent, stopAgent } from "@/features/agent/runner"
import { useAgent, type Mention } from "@/features/agent/store"
import { LEVELS } from "./TopBar"
import { EmptyState, KindIcon, SectionLabel } from "./bits"
import { CaptureBar, CaptureScope, useUi } from "./capture"
import { Markdown } from "./Markdown"

const LAYERS: { key: keyof Concept["layers"]; q: string }[] = [
  { key: "happened", q: "What happened?" },
  { key: "how", q: "How does it work?" },
  { key: "why", q: "Why was it designed this way?" },
  { key: "impl", q: "What are the implementation details?" },
  { key: "tradeoffs", q: "What are the architectural tradeoffs?" },
]

/** How many disclosure layers are open by default at each expertise level. */
const OPEN_BY_LEVEL: Record<Level, number> = { beginner: 1, intermediate: 2, advanced: 4, expert: 5 }

export function ContextPanel() {
  const { contextTab, setContextTab, selection, level, setLevel } = useKivo()
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-2">
        <Tabs value={contextTab} onValueChange={(v) => setContextTab(v as typeof contextTab)}>
          <TabsList variant="line" className="h-8">
            <TabsTrigger value="explain" className="text-[13px]">
              Explanation
            </TabsTrigger>
            <TabsTrigger value="knowledge" className="text-[13px]">
              Knowledge
            </TabsTrigger>
            <TabsTrigger value="ai" className="text-[13px]">
              AI
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <Select value={level} onValueChange={(v) => setLevel(v as Level)}>
          <SelectTrigger size="sm" aria-label="Explanation depth" className="ml-auto h-7 gap-1 border-0 px-2 text-xs text-muted-foreground shadow-none hover:text-foreground">
            <SelectValue>{LEVELS.find((l) => l.id === level)?.label}</SelectValue>
          </SelectTrigger>
          <SelectContent align="end">
            {LEVELS.map((l) => (
              <SelectItem key={l.id} value={l.id}>
                {l.label}
                <span className="text-xs text-muted-foreground">{l.hint}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {selection && contextTab !== "ai" && (
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <RefIcon refObj={selection} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium">{selection.label}</div>
            <div className="text-[11px] text-muted-foreground capitalize">{selection.kind === "span" ? "runtime event" : selection.kind}</div>
          </div>
          <CaptureBar refObj={selection} compact />
        </div>
      )}
      <div className="min-h-0 flex-1">
        {contextTab === "explain" && <ExplainTab />}
        {contextTab === "knowledge" && <KnowledgeTab />}
        {contextTab === "ai" && <AiTab />}
      </div>
    </div>
  )
}

function RefIcon({ refObj }: { refObj: KivoRef }) {
  const node = useKivo((s) => s.nodes.find((n) => n.id === refObj.id))
  if (node) return <KindIcon kind={node.kind} className="size-4" />
  const Icon = refObj.kind === "span" ? Cpu : refObj.kind === "step" ? Wand2 : refObj.kind === "experience" ? History : refObj.kind === "concept" ? Lightbulb : BookOpen
  return <Icon className="size-4 text-muted-foreground" />
}

// ─── Explanation ──────────────────────────────────────────────────────────────

function ExplainTab() {
  const { selection, traces, build, services, draft, nodes, edges, level } = useKivo()
  const explainFocus = useUi((s) => s.explainFocus)
  const whyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (explainFocus === "why") whyRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
  }, [explainFocus, selection])

  if (!selection) {
    return (
      <EmptyState icon={MousePointerClick} title="Select anything to understand it">
        Click a service, node, runtime event or build step — or highlight text in code and logs. Press <b>E</b> to explain, <b>W</b> for why.
      </EmptyState>
    )
  }

  const c = selection.conceptId ? CONCEPTS[selection.conceptId] : undefined
  const span: RuntimeSpan | undefined = selection.kind === "span" ? traces.flatMap((t) => t.spans).find((s) => s.id === selection.id) : undefined
  const step = selection.kind === "step" ? build?.steps.find((s) => s.id === selection.id) : undefined
  const service = selection.kind === "service" ? (services.find((s) => s.id === selection.id) ?? (draft?.id === selection.id ? draft : undefined)) : undefined
  const node = nodes.find((n) => n.id === selection.id && (selection.kind === "node" || selection.kind === "service"))

  return (
    <ScrollArea className="h-full">
      <CaptureScope source="explanation" className="space-y-5 p-4 text-[13px] leading-relaxed">
        {span && <SpanExplain span={span} level={level} />}

        {step && (
          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <Badge variant={step.executor === "ai" ? "secondary" : "outline"}>{step.executor === "ai" ? "AI reasoning" : "Deterministic"}</Badge>
              <span className="text-xs text-muted-foreground">{step.engine}</span>
            </div>
            <Field label="What is happening">{step.what}</Field>
            <div ref={whyRef}>
              <Field label="Why it is necessary">{step.why}</Field>
            </div>
            <Field label="Technology">{step.tech}</Field>
            {step.alternatives.length > 0 && <Field label="Alternatives">{step.alternatives.join(" · ")}</Field>}
            <Field label="Consequences">{step.consequences}</Field>
          </section>
        )}

        {service && (
          <section className="space-y-3">
            <Field label="Purpose">{service.purpose}</Field>
            {service.requirements.length > 0 && (
              <Field label="Requirements">
                <ul className="space-y-0.5">
                  {service.requirements.map((r) => (
                    <li key={r.id}>
                      {r.title} <span className="text-muted-foreground">— {r.description}</span>
                    </li>
                  ))}
                </ul>
              </Field>
            )}
            <div ref={whyRef}>
              {service.decisions.map((d) => (
                <Field key={d.topic} label={`Why ${d.choice}?`}>
                  {d.reason}
                </Field>
              ))}
            </div>
          </section>
        )}

        {node && !service && (
          <section className="space-y-3">
            <Field label="What it is">
              {node.purpose} <span className="text-muted-foreground">({node.tech})</span>
            </Field>
            <Field label="Depends on">
              <Chips ids={edges.filter((e) => e.source === node.id).map((e) => e.target)} />
            </Field>
            <Field label="Depended on by">
              <Chips ids={edges.filter((e) => e.target === node.id).map((e) => e.source)} />
            </Field>
          </section>
        )}

        {(selection.kind === "text" || selection.kind === "code" || selection.kind === "log") && selection.detail && (
          <>
            <Field label="Selected">
              <pre className="max-h-40 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-[12px] whitespace-pre-wrap">{selection.detail}</pre>
            </Field>
            <AiExplain refObj={selection} />
          </>
        )}

        {c ? (
          <ConceptExplain concept={c} whyRef={step || service || node ? undefined : whyRef} />
        ) : (
          !span &&
          !step &&
          !service &&
          !node && <p className="text-muted-foreground">No linked concept yet. Ask AI to explain this selection in the context of the project.</p>
        )}
      </CaptureScope>
    </ScrollArea>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-[11px] font-medium text-muted-foreground">{label}</div>
      <div>{children}</div>
    </div>
  )
}

function Chips({ ids }: { ids: string[] }) {
  const { nodes, select } = useKivo()
  if (!ids.length) return <span className="text-muted-foreground">—</span>
  return (
    <div className="flex flex-wrap gap-1">
      {ids.map((id) => {
        const n = nodes.find((x) => x.id === id)
        return (
          <Badge key={id} variant="outline" className="cursor-pointer" onClick={() => n && select({ kind: "node", id: n.id, label: n.label, conceptId: n.concept })}>
            {n?.label ?? id}
          </Badge>
        )
      })}
    </div>
  )
}

function SpanExplain({ span, level }: { span: RuntimeSpan; level: Level }) {
  const { setContextTab, select } = useKivo()
  const [showAll, setShowAll] = useState(false)
  const questions = ["What happened?", "Why did it happen?", "Why is this necessary?", "What would happen without it?", "What technology is responsible?", "How does this relate to the rest of the system?"]
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
        <span className={cn(span.status === "error" && "text-destructive", span.status === "slow" && "text-warning")}>{span.status.toUpperCase()}</span>
        <span>·</span>
        <span>{span.durationMs}ms</span>
        <span>·</span>
        <span>+{span.offsetMs}ms</span>
      </div>
      <p className="text-[14px]">{span.narration[level]}</p>
      <button className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => setShowAll(!showAll)}>
        <ChevronRight className={cn("size-3 transition-transform", showAll && "rotate-90")} /> See all explanation levels
      </button>
      {showAll && (
        <div className="space-y-2 border-l pl-3">
          {LEVELS.map((l) => (
            <div key={l.id}>
              <div className={cn("text-[11px] font-medium", l.id === level ? "text-foreground" : "text-muted-foreground")}>{l.label}</div>
              <div className={cn(l.id !== "beginner" && "font-mono text-[12px]")}>{span.narration[l.id]}</div>
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-1 pt-1">
        {questions.map((q) => (
          <Button
            key={q}
            variant="outline"
            size="xs"
            className="font-normal"
            onClick={() => {
              const ref: KivoRef = { kind: "span", id: span.id, label: span.name, conceptId: span.concept, detail: span.narration[level] }
              select(ref, "ai")
              setContextTab("ai")
              ask(q, ref)
            }}
          >
            {q}
          </Button>
        ))}
      </div>
    </section>
  )
}

function ConceptExplain({ concept: c, whyRef }: { concept: Concept; whyRef?: React.RefObject<HTMLDivElement | null> }) {
  const { level, noteDepth, setLevel, nodes, select } = useKivo()
  const openCount = OPEN_BY_LEVEL[level]
  const [open, setOpen] = useState<Record<string, boolean>>({})
  useEffect(() => setOpen({}), [c.id, level])

  return (
    <section className="space-y-4 border-t pt-4">
      <div className="flex items-center gap-2">
        <Lightbulb className="size-3.5 text-muted-foreground" />
        <span className="font-medium">{c.name}</span>
        <Badge variant="outline" className="text-[10px]">
          {c.category}
        </Badge>
      </div>
      <Field label="What is it?">{c.what}</Field>
      <div ref={whyRef}>
        <Field label="Why does THIS project use it?">{c.whyHere}</Field>
      </div>
      <Field label="Where is it used?">
        <div className="flex flex-wrap gap-1">
          {c.usedIn.map((u) => {
            const n = nodes.find((x) => x.label === u)
            return (
              <Badge
                key={u}
                variant="secondary"
                className={cn(n ? "cursor-pointer" : "opacity-60")}
                onClick={() => n && select({ kind: "node", id: n.id, label: n.label, conceptId: n.concept })}
              >
                {u}
              </Badge>
            )
          })}
        </div>
      </Field>

      <div className="space-y-1">
        <div className="text-[11px] font-medium text-muted-foreground">Go deeper</div>
        <div className="divide-y rounded-lg border">
          {LAYERS.map((layer, i) => {
            const isOpen = open[layer.key] ?? i < openCount
            return (
              <Collapsible
                key={layer.key}
                open={isOpen}
                onOpenChange={(v) => {
                  setOpen((o) => ({ ...o, [layer.key]: v }))
                  if (v && i >= openCount && noteDepth()) {
                    const next = LEVELS[LEVELS.findIndex((l) => l.id === level) + 1]
                    toast("You're drilling past your explanation level", {
                      description: `Switch to ${next.label} explanations by default?`,
                      action: { label: `Use ${next.label}`, onClick: () => setLevel(next.id) },
                    })
                  }
                }}
              >
                <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/50">
                  <span className="font-mono text-[10px] text-muted-foreground">{i + 1}</span>
                  <span className="flex-1 text-[13px]">{layer.q}</span>
                  <ChevronRight className={cn("size-3 text-muted-foreground transition-transform", isOpen && "rotate-90")} />
                </CollapsibleTrigger>
                <CollapsibleContent className={cn("px-3 pb-3 pl-7", i >= 3 && "font-mono text-[12px]")}>{c.layers[layer.key]}</CollapsibleContent>
              </Collapsible>
            )
          })}
        </div>
      </div>

      <Field label="Related concepts">
        <div className="flex flex-wrap gap-1">
          {c.related.map((r) => (
            <Badge
              key={r}
              variant="outline"
              className={cn(CONCEPTS[r] ? "cursor-pointer" : "opacity-60")}
              onClick={() => CONCEPTS[r] && select({ kind: "concept", id: r, label: CONCEPTS[r].name, conceptId: r })}
            >
              {CONCEPTS[r]?.name ?? r}
            </Badge>
          ))}
        </div>
      </Field>
    </section>
  )
}

// ─── Knowledge ────────────────────────────────────────────────────────────────

function KnowledgeTab() {
  const { selection, library, experiences, setMode, select } = useKivo()
  const cid = selection?.conceptId
  const items = cid ? library.filter((l) => l.conceptId === cid || l.tags.includes(cid)) : library.slice(0, 5)
  const exps = cid ? experiences.filter((e) => e.concepts.includes(cid)) : experiences.slice(0, 3)
  const insight = learningInsights(library, experiences).find((i) => i.conceptId === cid)

  return (
    <ScrollArea className="h-full">
      <div className="space-y-5 p-4 text-[13px]">
        {!cid && <p className="text-xs text-muted-foreground">Showing recent items. Select something linked to a concept to see what you already know about it.</p>}
        <div>
          <SectionLabel>Your notes</SectionLabel>
          {items.length === 0 && <p className="px-1 text-xs text-muted-foreground">Nothing saved yet. Press S on a selection to save it.</p>}
          <div className="space-y-2">
            {items.map((l) => (
              <div key={l.id} className="rounded-lg border p-3">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{l.title}</span>
                  <span className="text-[11px] text-muted-foreground">{l.source.project}</span>
                </div>
                <p className="mt-1 text-muted-foreground">{l.systemExplanation}</p>
                {l.myUnderstanding && <p className="mt-2 border-l-2 pl-2 italic">“{l.myUnderstanding}”</p>}
              </div>
            ))}
          </div>
        </div>
        <div>
          <SectionLabel>Your experiences</SectionLabel>
          {exps.length === 0 && <p className="px-1 text-xs text-muted-foreground">No related experiences.</p>}
          <div className="space-y-2">
            {exps.map((e) => (
              <button
                key={e.id}
                className="w-full rounded-lg border p-3 text-left hover:bg-accent/50"
                onClick={() => {
                  select({ kind: "experience", id: e.id, label: `Experience #${e.number}` })
                  setMode("library")
                }}
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium">
                    #{e.number} {e.title}
                  </span>
                  <span className="text-[11px] text-muted-foreground">{e.project}</span>
                </div>
                {e.metric && (
                  <div className="mt-1 font-mono text-xs">
                    {e.metric.label} {e.metric.before} <ArrowRight className="inline size-3" /> {e.metric.after}
                  </div>
                )}
                <p className="mt-1 italic">“{e.lesson}”</p>
              </button>
            ))}
          </div>
        </div>
        {insight && (
          <div className="rounded-lg border border-dashed p-3">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
              <Sparkles className="size-3" /> Learning insight · optional
            </div>
            <p className="mt-1">
              You've worked with {insight.name} {insight.count} times. Not yet explored: {insight.unexplored.slice(0, 3).join(", ")}.
            </p>
          </div>
        )}
      </div>
    </ScrollArea>
  )
}

// ─── AI ───────────────────────────────────────────────────────────────────────

function AiTab() {
  const { selection, chat, nodes, services, library, experiences, personalContext, setPersonalContext, ai } = useKivo()
  const askFocusTick = useUi((s) => s.askFocusTick)
  const mode = useAgent((s) => s.mode)
  const setMode = useAgent((s) => s.setMode)
  const agentRunning = useAgent((s) => s.running)
  const agentEmpty = useAgent((s) => s.items.length === 0)
  const autoApply = useAgent((s) => s.autoApply)
  const setAutoApply = useAgent((s) => s.setAutoApply)
  const tokens = useAgent((s) => s.tokens)
  const agentModel = useAgent((s) => s.model)
  const [text, setText] = useState("")
  const [mentions, setMentions] = useState<Mention[]>([])
  const input = useRef<HTMLTextAreaElement>(null)
  const bottom = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (askFocusTick) input.current?.focus()
  }, [askFocusTick])

  const lastLen = chat[chat.length - 1]?.text.length ?? 0
  useEffect(() => {
    if (mode === "ask") bottom.current?.scrollIntoView({ block: "nearest" })
  }, [chat.length, lastLen, mode])

  const preview = useMemo(
    () => assembleContext({ ref: selection, nodes, services, library, experiences, personalEnabled: personalContext }),
    [selection, nodes, services, library, experiences, personalContext],
  )

  const send = () => {
    const q = text.trim()
    if (!q) return
    if (mode === "agent") runAgent(q, mentions)
    else askWithMentions(q, mentions)
    setText("")
    setMentions([])
  }

  const empty = mode === "agent" ? agentEmpty : chat.length === 0
  const clear = () => (mode === "agent" ? clearAgent() : useKivo.setState({ chat: [] }))

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <div role="radiogroup" aria-label="AI mode" className="flex rounded-md bg-muted p-0.5 text-xs">
          {(["ask", "agent"] as const).map((m) => (
            <button
              key={m}
              role="radio"
              aria-checked={mode === m}
              onClick={() => setMode(m)}
              className={cn("flex items-center gap-1 rounded-[5px] px-2 py-0.5 text-muted-foreground", mode === m && "bg-background text-foreground shadow-xs")}
            >
              {m === "ask" ? <MessageSquare className="size-3" /> : <Bot className="size-3" />}
              {m === "ask" ? "Ask" : "Agent"}
            </button>
          ))}
        </div>
        {mode === "agent" && agentRunning && <span className="text-[11px] text-muted-foreground">running…</span>}
        <Button variant="ghost" size="icon-xs" className="ml-auto text-muted-foreground" disabled={empty} onClick={clear} aria-label="Clear conversation" title="Clear conversation">
          <Eraser />
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <CaptureScope source="ai" className="space-y-4 p-4 text-[13px] leading-relaxed">
          {mode === "agent" ? (
            <>
              {agentEmpty && (
                <div className="space-y-2 text-muted-foreground">
                  <p>Give the agent a task in this project — it can read and search files, propose edits and run commands.</p>
                  <p className="text-xs">
                    Every edit is shown as a diff for you to accept or reject, and every command waits for your approval. Type <span className="font-mono">@</span> to attach files.{" "}
                    {ai?.ai ? `Model: ${ai.model}.` : "Needs an AI provider."}
                  </p>
                </div>
              )}
              <AgentMessages />
            </>
          ) : (
            <>
              {chat.length === 0 && (
                <div className="space-y-2 text-muted-foreground">
                  <p>Ask about {selection ? <span className="text-foreground">{selection.label}</span> : "anything in this project"}.</p>
                  <p className="text-xs">
                    Answers are grounded in the Project Graph and — if enabled — your notes and past experiences. Type <span className="font-mono">@</span> to attach files.{" "}
                    {ai?.ai ? `Model: ${ai.model} via ${ai.providers?.find((p) => p.id === ai.active)?.label ?? "your AI provider"}.` : "Offline: answers come from the concept catalog."}
                  </p>
                </div>
              )}
              {chat.map((m) =>
                m.role === "user" ? (
                  <div key={m.id} className="kivo-in ml-8 rounded-lg bg-muted px-3 py-2">
                    {m.ref && <div className="mb-0.5 font-mono text-[10px] text-muted-foreground">re: {m.ref.label}</div>}
                    {m.text}
                  </div>
                ) : (
                  <div key={m.id} className="kivo-in space-y-2">
                    {m.reasoning && <Reasoning text={m.reasoning} streaming={!!m.streaming && !m.text} />}
                    <div>
                      <Markdown>{m.text}</Markdown>
                      {m.streaming && <span className="kivo-pulse inline-block h-3 w-1.5 bg-foreground/60" />}
                    </div>
                    {!m.streaming && m.context && m.context.length > 0 && <ContextUsed items={m.context} model={m.model} />}
                  </div>
                ),
              )}
              <div ref={bottom} />
            </>
          )}
        </CaptureScope>
      </ScrollArea>
      <div className="space-y-2 border-t p-3">
        {mode === "agent" ? (
          <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <span className="truncate">{tokens > 0 ? `${(agentModel ?? ai?.model ?? "").split("/").pop()} · ${tokens.toLocaleString()} tokens` : (ai?.model ?? "").split("/").pop()}</span>
            <label className="flex shrink-0 items-center gap-1.5" title="Apply the agent's edits without reviewing each diff. Commands always need approval.">
              Auto-apply edits
              <Switch size="sm" checked={autoApply} onCheckedChange={setAutoApply} disabled={agentRunning} />
            </label>
          </div>
        ) : (
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>
              Context: {preview.filter((p) => p.source === "project").length} project · {preview.filter((p) => p.source !== "project").length} personal
            </span>
            <label className="flex items-center gap-1.5">
              Personal context
              <Switch size="sm" checked={personalContext} onCheckedChange={setPersonalContext} />
            </label>
          </div>
        )}
        <Composer
          inputRef={input}
          value={text}
          onChange={setText}
          mentions={mentions}
          onMentions={setMentions}
          onSubmit={send}
          running={mode === "agent" && agentRunning}
          onStop={stopAgent}
          placeholder={mode === "agent" ? "Describe a task… (@ to attach files)" : selection ? `Ask about ${selection.label}…` : "Ask Kivo… (@ to attach files)"}
        />
      </div>
    </div>
  )
}

function Reasoning({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible open={open || streaming} onOpenChange={setOpen} className="text-xs">
      <CollapsibleTrigger className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground">
        <ChevronRight className={cn("size-3 transition-transform", (open || streaming) && "rotate-90")} />
        {streaming ? "Thinking…" : "Reasoning"}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 max-h-40 overflow-auto border-l pl-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground">{text}</CollapsibleContent>
    </Collapsible>
  )
}

/** Streams a short, level-aware explanation of a code/text selection. */
function AiExplain({ refObj }: { refObj: KivoRef }) {
  const aiOn = useKivo((s) => !!s.ai?.ai)
  const level = useKivo((s) => s.level)
  const [text, setText] = useState("")
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle")
  useEffect(() => {
    if (!aiOn) return
    const ac = new AbortController()
    setText("")
    setState("loading")
    explainInline(refObj, setText, ac.signal)
      .then(() => setState("done"))
      .catch((e) => !ac.signal.aborted && (setState("error"), setText(String(e.message))))
    return () => ac.abort()
  }, [refObj.id, level, aiOn]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!aiOn) return null
  return (
    <Field label={`Explanation · ${level}`}>
      <div className={cn(state === "error" && "text-destructive")}>
        <Markdown>{text}</Markdown>
        {state === "loading" && <span className="kivo-pulse inline-block h-3 w-1.5 bg-foreground/60" />}
      </div>
    </Field>
  )
}

function ContextUsed({ items, model }: { items: ReturnType<typeof assembleContext>; model?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-md border text-xs">
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 px-2 py-1.5 text-muted-foreground hover:text-foreground">
        <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
        Context used · {items.length} items{model ? ` · ${model.split("/").pop()}` : ""}
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-1.5 border-t p-2">
        {items.map((i, k) => (
          <div key={k} className="flex gap-2">
            <Badge variant={i.source === "experience" || i.source === "knowledge" ? "secondary" : "outline"} className="h-4 shrink-0 px-1.5 text-[10px]">
              {i.source}
            </Badge>
            <div className="min-w-0">
              <div className="truncate">{i.label}</div>
              <div className="truncate text-muted-foreground">{i.detail}</div>
            </div>
            <span className="ml-auto font-mono text-muted-foreground">{i.score.toFixed(2)}</span>
          </div>
        ))}
      </CollapsibleContent>
    </Collapsible>
  )
}
