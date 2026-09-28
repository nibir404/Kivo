import { useState } from "react"
import { ArrowLeft, ArrowRight, FileCode2, MessageSquare, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { openFile } from "@/state/runners"
import { useKivo } from "@/state/store"
import { askInWorkspace, useSections, useWsContext } from "./hooks"
import type { SectionData, SectionDef, WorkspaceDef } from "./model"
import { PanelView } from "./panels"
import { workspace } from "./registry"

/** A non-software workspace: its overview, or one of its sections. */
export function WorkspaceView() {
  const discipline = useKivo((s) => s.discipline)
  const sectionId = useKivo((s) => s.workspaceSection)
  const def = workspace(discipline)
  const ctx = useWsContext()
  const sections = useSections(def, ctx)
  const open = sections.find((s) => s.section.id === sectionId)
  return (
    <ScrollArea className="h-full">
      <div key={`${def.id}:${sectionId ?? ""}`} className="kivo-fade mx-auto max-w-4xl space-y-8 px-6 py-8 sm:px-8">
        {open ? <SectionPage def={def} section={open.section} data={open.data} /> : <Overview def={def} sections={sections} />}
      </div>
    </ScrollArea>
  )
}

export function SourceBadge({ data, className }: { data: SectionData; className?: string }) {
  const label = data.source === "project" ? "From this project" : data.source === "example" ? "Example data" : "Checklist"
  const title =
    data.source === "project" ? "Derived from this repository's files, services and system graph." : data.source === "example" ? "Nothing matching was found in this project yet — this is illustrative, not real." : "Good practice for this discipline — tick items off as you verify them."
  return (
    <span title={title} className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-px text-[10.5px] whitespace-nowrap", data.source === "project" ? "ws-tint border-transparent" : "text-muted-foreground", data.source === "example" && "border-dashed", className)}>
      <span className={cn("size-1.5 rounded-full", data.source === "project" ? "bg-(--ws)" : data.source === "example" ? "border border-muted-foreground" : "bg-muted-foreground")} />
      {label}
    </span>
  )
}

function WorkspaceIcon({ def, size = "md" }: { def: WorkspaceDef; size?: "md" | "lg" }) {
  return (
    <span className={cn("ws-tint flex shrink-0 items-center justify-center rounded-xl", size === "lg" ? "size-11" : "size-8")}>
      <def.icon className={size === "lg" ? "size-5" : "size-4"} />
    </span>
  )
}

function Overview({ def, sections }: { def: WorkspaceDef; sections: { section: SectionDef; data: SectionData }[] }) {
  const ctx = useWsContext()
  const open = useKivo((s) => s.openWorkspaceSection)
  const stats = def.stats(ctx)
  const detected = ctx.analysis.detections.filter((d) => def.relevant(d.tech, d.category))
  const real = sections.filter((s) => s.data.source === "project").length

  return (
    <>
      <header className="space-y-5">
        <div className="flex items-center gap-3">
          <WorkspaceIcon def={def} size="lg" />
          <div>
            <div className="text-[13px] font-medium">{def.label}</div>
            <div className="text-[12px] text-muted-foreground">{def.tagline}</div>
          </div>
        </div>
        <div className="space-y-1.5">
          <h1 className="text-2xl font-semibold tracking-tight">{def.hero.title}</h1>
          <p className="max-w-2xl text-[14px] text-muted-foreground">{def.hero.body}</p>
        </div>
        <Composer def={def} />
      </header>

      {stats.length > 0 && (
        <section className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {stats.map((s) => (
            <div key={s.label} className="rounded-xl border p-3">
              <div className="text-[11px] text-muted-foreground">{s.label}</div>
              <div className={cn("mt-0.5 truncate text-lg font-semibold tabular-nums", s.tone === "bad" && "text-destructive", s.tone === "warn" && "text-warning")}>{s.value}</div>
            </div>
          ))}
        </section>
      )}

      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Sections</h2>
          <span className="text-[11px] text-muted-foreground">
            {real} of {sections.length} read from <span className="font-mono">{ctx.project}</span>
          </span>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {sections.map(({ section, data }) => (
            <button key={section.id} onClick={() => open(section.id)} className="group flex flex-col gap-2 rounded-xl border p-3.5 text-left transition-colors hover:border-foreground/20 hover:bg-accent/40">
              <div className="flex items-center gap-2">
                <section.icon className="size-4 text-muted-foreground group-hover:ws-ink" />
                <span className="text-[13.5px] font-medium">{section.label}</span>
                {data.count !== undefined && data.source !== "example" && <span className="rounded-md bg-muted px-1.5 text-[11px] text-muted-foreground tabular-nums">{data.count}</span>}
                <SourceBadge data={data} className="ml-auto" />
              </div>
              <p className="text-[12.5px] leading-relaxed text-muted-foreground">{section.blurb}</p>
            </button>
          ))}
        </div>
      </section>

      <section className="space-y-2 rounded-xl border p-4">
        {detected.length ? (
          <>
            <h2 className="text-[13px] font-medium">Detected in {ctx.project}</h2>
            <div className="flex flex-wrap gap-1.5">
              {detected.map((d) => (
                <span key={d.tech} className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[12px]">
                  {d.tech}
                  <span className="font-mono text-[10.5px] text-muted-foreground">{d.evidence}</span>
                </span>
              ))}
            </div>
          </>
        ) : (
          <>
            <h2 className="text-[13px] font-medium">Nothing for this workspace detected in {ctx.project} yet</h2>
            <p className="text-[12.5px] text-muted-foreground">Sections marked "Example data" fill in with real content as soon as Kivo finds any of:</p>
          </>
        )}
        {!detected.length && (
          <ul className="grid gap-x-6 gap-y-0.5 pt-1 text-[12px] text-muted-foreground sm:grid-cols-2">
            {def.looksFor.map((l) => (
              <li key={l} className="flex gap-1.5">
                <span className="text-muted-foreground/60">·</span>
                {l}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  )
}

function Composer({ def }: { def: WorkspaceDef }) {
  const [text, setText] = useState("")
  const ai = useKivo((s) => s.ai)
  const go = () => {
    if (!text.trim()) return
    askInWorkspace(def, text.trim())
    setText("")
  }
  return (
    <div className="space-y-3">
      <div className="rounded-2xl border bg-background shadow-xs transition-shadow focus-within:border-foreground/30 focus-within:shadow-md">
        <label htmlFor="workspace-input" className="sr-only">
          {def.hero.title}
        </label>
        <Textarea
          id="workspace-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
              e.preventDefault()
              go()
            }
          }}
          placeholder={def.placeholder}
          className="min-h-24 resize-none border-0 bg-transparent! px-4 pt-4 text-[15px] leading-relaxed shadow-none focus-visible:ring-0"
        />
        <div className="flex items-center gap-3 px-3 pb-3">
          <span className="hidden text-[11px] text-muted-foreground sm:inline">
            <Kbd>↵</Kbd> to ask · <Kbd>⇧↵</Kbd> new line
          </span>
          {!ai?.ai && <span className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground">Offline answers</span>}
          <Button size="sm" onClick={go} disabled={!text.trim()} className="ml-auto gap-1.5">
            Ask Kivo <ArrowRight />
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-xs text-muted-foreground">Try:</span>
        {def.examples.map((e) => (
          <button
            key={e.label}
            title={e.text}
            onClick={() => {
              setText(e.text)
              document.getElementById("workspace-input")?.focus()
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

function SectionPage({ def, section, data }: { def: WorkspaceDef; section: SectionDef; data: SectionData }) {
  const open = useKivo((s) => s.openWorkspaceSection)
  const files = useKivo((s) => s.files)
  const [showEvidence, setShowEvidence] = useState(false)
  const evidence = (data.evidence ?? []).filter((f, i, all) => all.indexOf(f) === i)

  return (
    <>
      <header className="space-y-4">
        <button onClick={() => open(null)} className="flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" /> {def.label}
        </button>
        <div className="flex flex-wrap items-start gap-3">
          <span className="ws-tint flex size-9 items-center justify-center rounded-lg">
            <section.icon className="size-4" />
          </span>
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight">{section.label}</h1>
              <SourceBadge data={data} />
            </div>
            <p className="text-[13px] text-muted-foreground">{section.blurb}</p>
          </div>
          <div className="flex gap-1.5">
            {data.source === "example" && section.setup && (
              <Button size="sm" onClick={() => askInWorkspace(def, section.setup!, { def: section, data })}>
                <Sparkles /> Set this up with Kivo
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => askInWorkspace(def, `Explain this ${section.label.toLowerCase()} view for my project and tell me the most important thing to do next.`, { def: section, data })}>
              <MessageSquare /> Ask about this
            </Button>
          </div>
        </div>
        {data.note && <p className={cn("rounded-lg px-3 py-2 text-[12.5px]", data.source === "example" ? "border border-dashed text-muted-foreground" : "bg-muted/60 text-muted-foreground")}>{data.note}</p>}
        {evidence.length > 0 && (
          <div className="text-[12px] text-muted-foreground">
            <button onClick={() => setShowEvidence((v) => !v)} className="hover:text-foreground">
              {showEvidence ? "Hide" : "Show"} evidence · {evidence.length} file{evidence.length > 1 ? "s" : ""}
            </button>
            {showEvidence && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {evidence.map((f) =>
                  files.includes(f) ? (
                    <button key={f} onClick={() => openFile(f)} className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[11px] hover:bg-accent hover:text-foreground">
                      <FileCode2 className="size-3" /> {f}
                    </button>
                  ) : (
                    <span key={f} className="rounded-md border px-1.5 py-0.5 font-mono text-[11px]">
                      {f}
                    </span>
                  ),
                )}
              </div>
            )}
          </div>
        )}
      </header>

      <div className="space-y-6">
        {data.panels.map((p, i) => (
          <PanelView key={i} panel={p} scope={`${def.id}:${section.id}`} />
        ))}
      </div>
    </>
  )
}
