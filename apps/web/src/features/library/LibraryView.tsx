import { useMemo, useState } from "react"
import { Background, Controls, ReactFlow, type Edge, type Node } from "@xyflow/react"
import { ArrowRight, Download, Lock, Plus, Search, Trash2, Users } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { CONCEPTS } from "@kivo/core/concepts"
import type { Experience, LibraryItem } from "@kivo/core/types"
import { cn } from "@/lib/utils"
import { useKivo } from "@/state/store"
import { EmptyState, SectionLabel } from "@/shell/bits"
import { Capturable } from "@/shell/capture"

export function LibraryView() {
  const { library, experiences } = useKivo()
  return (
    <Tabs defaultValue="knowledge" className="flex h-full flex-col gap-0">
      <div className="flex items-center gap-4 border-b px-6">
        <TabsList variant="line" className="h-11">
          <TabsTrigger value="knowledge">
            Knowledge <span className="font-mono text-[11px] text-muted-foreground">{library.length}</span>
          </TabsTrigger>
          <TabsTrigger value="experiences">
            Experiences <span className="font-mono text-[11px] text-muted-foreground">{experiences.length}</span>
          </TabsTrigger>
          <TabsTrigger value="graph">Knowledge graph</TabsTrigger>
          <TabsTrigger value="privacy">Memory & privacy</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="knowledge" className="min-h-0 flex-1">
        <Knowledge />
      </TabsContent>
      <TabsContent value="experiences" className="min-h-0 flex-1">
        <Experiences />
      </TabsContent>
      <TabsContent value="graph" className="min-h-0 flex-1">
        <PersonalGraph />
      </TabsContent>
      <TabsContent value="privacy" className="min-h-0 flex-1">
        <Privacy />
      </TabsContent>
    </Tabs>
  )
}

function Visibility({ item, onChange }: { item: { visibility: "private" | "shared" }; onChange: (v: "private" | "shared") => void }) {
  return (
    <button
      onClick={() => onChange(item.visibility === "private" ? "shared" : "private")}
      className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      {item.visibility === "private" ? <Lock className="size-3" /> : <Users className="size-3" />}
      {item.visibility}
    </button>
  )
}

function Knowledge() {
  const { library, updateLibraryItem, deleteLibraryItem } = useKivo()
  const [q, setQ] = useState("")
  const items = library.filter((l) => `${l.title} ${l.myUnderstanding} ${l.systemExplanation} ${l.tags.join(" ")}`.toLowerCase().includes(q.toLowerCase()))

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-3xl space-y-4 p-6">
        <div className="relative">
          <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your knowledge…" className="pl-8" />
        </div>
        {items.length === 0 && <EmptyState icon={Search} title="Nothing here yet">Select anything in Kivo and press S to save it, or N to write it in your own words.</EmptyState>}
        {items.map((l) => (
          <KnowledgeCard key={l.id} item={l} onChange={(p) => updateLibraryItem(l.id, p)} onDelete={() => deleteLibraryItem(l.id)} />
        ))}
      </div>
    </ScrollArea>
  )
}

function KnowledgeCard({ item: l, onChange, onDelete }: { item: LibraryItem; onChange: (p: Partial<LibraryItem>) => void; onDelete: () => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(l.myUnderstanding)
  return (
    <div className="group rounded-xl border">
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        <Capturable as="span" refObj={{ kind: "concept", id: l.conceptId ?? l.id, label: l.title, conceptId: l.conceptId, detail: l.systemExplanation }} className="-mx-1 px-1 text-[14px] font-medium">
          {l.title}
        </Capturable>
        <Badge variant="outline" className="text-[10px]">
          {l.kind}
        </Badge>
        <span className="ml-auto truncate text-[11px] text-muted-foreground">
          {l.source.project} · {l.source.label} · {new Date(l.createdAt).toLocaleDateString()}
        </span>
      </div>
      <div className="grid gap-4 p-4 text-[13px] sm:grid-cols-2">
        <div className="space-y-1">
          <div className="text-[11px] font-medium text-muted-foreground">System explanation</div>
          <p className="text-muted-foreground">{l.systemExplanation || "—"}</p>
        </div>
        <div className="space-y-1">
          <div className="text-[11px] font-medium text-muted-foreground">My understanding</div>
          {editing ? (
            <div className="space-y-2">
              <Textarea autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} className="min-h-16 text-[13px]" />
              <div className="flex gap-1">
                <Button
                  size="xs"
                  onClick={() => {
                    onChange({ myUnderstanding: draft })
                    setEditing(false)
                  }}
                >
                  Save
                </Button>
                <Button size="xs" variant="ghost" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <button className="w-full text-left italic hover:text-foreground" onClick={() => setEditing(true)}>
              {l.myUnderstanding ? `“${l.myUnderstanding}”` : <span className="text-muted-foreground not-italic">Add your own interpretation…</span>}
            </button>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 border-t px-3 py-1.5">
        {l.tags.map((t) => (
          <span key={t} className="font-mono text-[10px] text-muted-foreground">
            #{t}
          </span>
        ))}
        <div className="ml-auto flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            AI context <Switch size="sm" checked={l.useAsContext} onCheckedChange={(v) => onChange({ useAsContext: v })} />
          </label>
          <Visibility item={l} onChange={(visibility) => onChange({ visibility })} />
          <Button variant="ghost" size="icon-xs" aria-label="Delete" onClick={onDelete}>
            <Trash2 />
          </Button>
        </div>
      </div>
    </div>
  )
}

function Experiences() {
  const { experiences, setExperienceDraftOpen, updateExperience, deleteExperience, selection } = useKivo()
  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-3xl space-y-4 p-6">
        <div className="flex items-center justify-between">
          <p className="text-[13px] text-muted-foreground">Real engineering experiences — problem, investigation, decision, outcome, lesson.</p>
          <Button size="sm" onClick={() => setExperienceDraftOpen(true)}>
            <Plus /> Capture experience
          </Button>
        </div>
        {experiences.map((e) => (
          <ExperienceCard key={e.id} e={e} highlight={selection?.kind === "experience" && selection.id === e.id} onChange={(p) => updateExperience(e.id, p)} onDelete={() => deleteExperience(e.id)} />
        ))}
      </div>
    </ScrollArea>
  )
}

function ExperienceCard({ e, highlight, onChange, onDelete }: { e: Experience; highlight: boolean; onChange: (p: Partial<Experience>) => void; onDelete: () => void }) {
  const rows: [string, string][] = [
    ["Problem", e.problem],
    ["Context", e.context],
    ["Investigation", e.investigation],
    ["Decision", e.decision],
    ["Implementation", e.implementation],
    ["Outcome", e.outcome],
  ]
  return (
    <div className={cn("rounded-xl border", highlight && "ring-1 ring-foreground/40")}>
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        <span className="font-mono text-[12px] text-muted-foreground">Experience #{e.number}</span>
        <span className="text-[14px] font-medium">{e.title}</span>
        <span className="ml-auto text-[11px] text-muted-foreground">{e.project}</span>
      </div>
      <dl className="grid grid-cols-[110px_1fr] gap-x-4 gap-y-2 p-4 text-[13px]">
        {rows.map(([k, v]) =>
          v ? (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd>{v}</dd>
            </div>
          ) : null,
        )}
        {e.metric && (
          <div className="contents">
            <dt className="text-muted-foreground">Result</dt>
            <dd className="font-mono">
              {e.metric.label} {e.metric.before} <ArrowRight className="inline size-3" /> {e.metric.after}
            </dd>
          </div>
        )}
        <div className="contents">
          <dt className="text-muted-foreground">My takeaway</dt>
          <dd className="italic">“{e.lesson}”</dd>
        </div>
      </dl>
      <div className="flex items-center gap-2 border-t px-3 py-1.5">
        {e.concepts.map((c) => (
          <Capturable key={c} as="span" refObj={{ kind: "concept", id: c, label: CONCEPTS[c]?.name ?? c, conceptId: c }} className="rounded-full border px-2 py-0.5 text-[11px] hover:bg-accent">
            {CONCEPTS[c]?.name ?? c}
          </Capturable>
        ))}
        <div className="ml-auto flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            AI context <Switch size="sm" checked={e.useAsContext} onCheckedChange={(v) => onChange({ useAsContext: v })} />
          </label>
          <Visibility item={e} onChange={(visibility) => onChange({ visibility })} />
          <Button variant="ghost" size="icon-xs" aria-label="Delete" onClick={onDelete}>
            <Trash2 />
          </Button>
        </div>
      </div>
    </div>
  )
}

function PersonalGraph() {
  const { library, experiences, select } = useKivo()

  const { nodes, edges } = useMemo(() => {
    const conceptIds = new Set<string>()
    library.forEach((l) => l.conceptId && conceptIds.add(l.conceptId))
    experiences.forEach((e) => e.concepts.forEach((c) => conceptIds.add(c)))
    const concepts = [...conceptIds].filter((c) => CONCEPTS[c])
    const projects = [...new Set([...library.map((l) => l.source.project), ...experiences.map((e) => e.project)])]

    const nodes: Node[] = []
    const edges: Edge[] = []
    const style = (kind: string) =>
      cn(
        "rounded-lg! border! px-2.5! py-1.5! text-[12px]! w-auto! shadow-none!",
        kind === "concept" && "bg-background! text-foreground! font-medium border-foreground/40!",
        kind === "project" && "bg-muted! text-foreground! font-mono",
        kind === "experience" && "bg-background! text-foreground! border-dashed!",
        kind === "note" && "bg-background! text-muted-foreground!",
      )
    const circle = (i: number, n: number, r: number, cx = 0, cy = 0) => ({ x: cx + r * Math.cos((2 * Math.PI * i) / n), y: cy + r * Math.sin((2 * Math.PI * i) / n) })

    concepts.forEach((c, i) => nodes.push({ id: `c:${c}`, position: circle(i, concepts.length, 170), data: { label: CONCEPTS[c].name }, className: style("concept") }))
    projects.forEach((p, i) => nodes.push({ id: `p:${p}`, position: circle(i, projects.length, 420, 0, 0), data: { label: p }, className: style("project") }))
    experiences.forEach((e, i) => {
      nodes.push({ id: `e:${e.id}`, position: circle(i + 0.5, experiences.length, 320), data: { label: `#${e.number} ${e.title}` }, className: style("experience") })
      e.concepts.forEach((c) => CONCEPTS[c] && edges.push({ id: `e:${e.id}-${c}`, source: `e:${e.id}`, target: `c:${c}` }))
      edges.push({ id: `e:${e.id}-p`, source: `e:${e.id}`, target: `p:${e.project}`, style: { strokeDasharray: "3 3" } })
    })
    library.forEach((l, i) => {
      nodes.push({ id: `l:${l.id}`, position: circle(i + 0.25, library.length, 250, 0, 0), data: { label: l.title }, className: style("note") })
      if (l.conceptId && CONCEPTS[l.conceptId]) edges.push({ id: `l:${l.id}-c`, source: `l:${l.id}`, target: `c:${l.conceptId}` })
      edges.push({ id: `l:${l.id}-p`, source: `l:${l.id}`, target: `p:${l.source.project}`, style: { strokeDasharray: "3 3" } })
    })
    concepts.forEach((c) =>
      CONCEPTS[c].related.forEach((r) => {
        if (conceptIds.has(r) && c < r) edges.push({ id: `cc:${c}-${r}`, source: `c:${c}`, target: `c:${r}`, style: { strokeWidth: 2 } })
      }),
    )
    return { nodes, edges }
  }, [library, experiences])

  return (
    <div className="relative h-full">
      <div className="absolute top-3 left-4 z-10 flex gap-4 text-[11px] text-muted-foreground">
        <span className="font-medium text-foreground">Personal Knowledge Graph</span>
        <span>concepts · notes · experiences · projects</span>
      </div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        proOptions={{ hideAttribution: true }}
        nodesConnectable={false}
        onNodeClick={(_, n) => {
          const [kind, id] = n.id.split(/:(.*)/s)
          if (kind === "c") select({ kind: "concept", id, label: CONCEPTS[id].name, conceptId: id }, "knowledge")
        }}
      >
        <Background gap={24} size={1} color="var(--border)" />
        <Controls showInteractive={false} position="bottom-right" />
      </ReactFlow>
    </div>
  )
}

function Privacy() {
  const k = useKivo()
  const [confirm, setConfirm] = useState(false)
  const excluded = k.library.filter((l) => !l.useAsContext).length + k.experiences.filter((e) => !e.useAsContext).length
  const shared = k.library.filter((l) => l.visibility === "shared").length + k.experiences.filter((e) => e.visibility === "shared").length

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-2xl space-y-6 p-6 text-[13px]">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold tracking-tight">Memory & privacy</h2>
          <p className="text-muted-foreground">
            Kivo never retrains a model on your data. Your notes and experiences are retrieved as context at question time — only when you allow it, and you can see exactly what was used under every answer.
          </p>
        </div>
        <div className="divide-y rounded-xl border">
          <Setting title="Use personal context in AI answers" desc="Retrieve relevant notes and experiences when answering questions." checked={k.personalContext} onChange={k.setPersonalContext} />
          <Setting title="Remember runtime discoveries" desc="Suggest capturing experiences from slow queries, errors and fixes." checked={k.rememberRuntime} onChange={k.setRememberRuntime} />
        </div>
        <div className="grid grid-cols-3 divide-x rounded-xl border">
          <Count label="Remembered items" value={k.library.length + k.experiences.length} />
          <Count label="Excluded from AI" value={excluded} />
          <Count label="Shared with team" value={shared} />
        </div>
        <div>
          <SectionLabel>Per-item control</SectionLabel>
          <p className="px-1 text-muted-foreground">Each note and experience has its own AI-context switch and private/shared visibility in the Knowledge and Experiences tabs.</p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const blob = new Blob([JSON.stringify({ library: k.library, experiences: k.experiences }, null, 2)], { type: "application/json" })
              const a = document.createElement("a")
              a.href = URL.createObjectURL(blob)
              a.download = "kivo-memory.json"
              a.click()
            }}
          >
            <Download /> Export memory
          </Button>
          <Button variant="outline" size="sm" className="text-destructive" onClick={() => setConfirm(true)}>
            <Trash2 /> Delete all personal memory
          </Button>
        </div>
      </div>
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete all personal memory?</DialogTitle>
            <DialogDescription>
              This removes {k.library.length} notes and {k.experiences.length} experiences from this device. Project code is not affected.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                k.library.forEach((l) => k.deleteLibraryItem(l.id))
                k.experiences.forEach((e) => k.deleteExperience(e.id))
                setConfirm(false)
                toast("Personal memory deleted")
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ScrollArea>
  )
}

function Setting({ title, desc, checked, onChange }: { title: string; desc: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-4 p-4">
      <div className="flex-1">
        <div className="font-medium">{title}</div>
        <div className="text-muted-foreground">{desc}</div>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  )
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div className="p-4">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="font-mono text-lg">{value}</div>
    </div>
  )
}
