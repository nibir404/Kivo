import { useEffect, useMemo, useState } from "react"
import { Background, Controls, Handle, Position, ReactFlow, useReactFlow, useStore, type Edge, type Node, type NodeProps } from "@xyflow/react"
import { ChevronRight, Sparkles, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { CONCEPTS } from "@kivo/core/concepts"
import { learningInsights } from "@kivo/core/context"
import { codeFor } from "@kivo/core/plan"
import type { SystemNode } from "@kivo/core/types"
import { cn } from "@/lib/utils"
import { useKivo } from "@/state/store"
import { KindIcon, SectionLabel, StatusDot } from "@/shell/bits"
import { Capturable, useCaptureActions, useUi } from "@/shell/capture"

const COLUMN: Record<SystemNode["group"], number> = { Frontend: 0, Infrastructure: 1, Backend: 2, "AI / ML": 2, Data: 3, External: 3 }

type ArchNodeData = { node: SystemNode; hot: boolean; selected: boolean }

function ArchNode({ data }: NodeProps<Node<ArchNodeData>>) {
  const n = data.node
  return (
    <div
      className={cn(
        "w-48 rounded-lg border bg-background px-3 py-2 shadow-xs transition-all",
        data.hot && "border-foreground/50 shadow-sm",
        data.selected && "ring-2 ring-foreground/70",
      )}
    >
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-2">
        <KindIcon kind={n.kind} />
        <span className="flex-1 truncate text-[13px] font-medium">{n.label}</span>
        <StatusDot status={n.status} className={cn(data.hot && "kivo-pulse")} />
      </div>
      <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">{n.tech}</div>
      <Handle type="source" position={Position.Right} />
    </div>
  )
}

const nodeTypes = { arch: ArchNode }

export function LearnView() {
  return (
    <ResizablePanelGroup orientation="vertical">
      <ResizablePanel defaultSize="58" minSize="30">
        <ArchitectureGraph />
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel minSize="20">
        <ScrollArea className="h-full">
          <div className="grid gap-8 p-6 xl:grid-cols-[1fr_320px]">
            <DrillDown />
            <Insights />
          </div>
        </ScrollArea>
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}

function ArchitectureGraph() {
  const { nodes, edges, traces, selection, select, runtimeLive } = useKivo()
  const setAnchor = useUi((s) => s.setAnchor)
  const latest = traces[0]
  const hot = new Set(latest?.spans.map((s) => s.nodeId) ?? [])
  const hotPath = new Set<string>()
  if (latest) {
    const seq = ["mobile", ...latest.spans.map((s) => s.nodeId)]
    for (let i = 1; i < seq.length; i++) hotPath.add(`${seq[i - 1]}>${seq[i]}`).add(`${seq[i]}>${seq[i - 1]}`)
  }

  const rfNodes: Node<ArchNodeData>[] = useMemo(() => {
    const perCol: Record<number, number> = {}
    return nodes.map((n) => {
      const col = n.id === "docker" ? 1 : COLUMN[n.group]
      const row = (perCol[col] = (perCol[col] ?? -1) + 1)
      const y = n.id === "docker" ? 300 : row * 110 + (col === 0 || col === 1 ? 110 : 0)
      return {
        id: n.id,
        type: "arch",
        position: { x: col * 270, y },
        data: { node: n, hot: hot.has(n.id), selected: selection?.id === n.id },
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, latest?.id, selection?.id])

  const rfEdges: Edge[] = edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    label: e.label,
    animated: hotPath.has(`${e.source}>${e.target}`),
    labelStyle: { fontSize: 10, fontFamily: "var(--font-mono)" },
    style: e.kind === "event" ? { strokeDasharray: "4 3" } : undefined,
  }))

  return (
    <div className="relative h-full">
      <div className="absolute top-3 left-4 z-10 flex items-center gap-2">
        <span className="text-sm font-medium">Architecture</span>
        <span className="text-xs text-muted-foreground">Click any node to explain it{runtimeLive ? " · edges animate with demo traffic" : ""}.</span>
      </div>
      <div className="absolute top-3 right-4 z-10 hidden gap-3 text-[11px] text-muted-foreground 2xl:flex">
        <span className="flex items-center gap-1.5">
          <span className="h-px w-4 bg-muted-foreground" /> request / storage
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-px w-4 border-t border-dashed border-muted-foreground" /> event
        </span>
      </div>
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.25 }}
        proOptions={{ hideAttribution: true }}
        nodesConnectable={false}
        onNodeClick={(e, n) => {
          const sn = (n.data as ArchNodeData).node
          const ref = { kind: "node" as const, id: sn.id, label: sn.label, conceptId: sn.concept }
          select(ref)
          setAnchor({ x: e.clientX, y: (e.target as HTMLElement).closest(".react-flow__node")!.getBoundingClientRect().top }, ref)
        }}
      >
        <Background gap={24} size={1} color="var(--border)" />
        <Controls showInteractive={false} position="bottom-right" />
        <AutoFit count={rfNodes.length} />
      </ReactFlow>
    </div>
  )
}

/** Keep the whole graph in view when the panel is resized or services are added. */
function AutoFit({ count }: { count: number }) {
  const { fitView } = useReactFlow()
  const width = useStore((s) => s.width)
  const height = useStore((s) => s.height)
  useEffect(() => {
    if (!width || !height) return
    const t = setTimeout(() => fitView({ padding: 0.25, duration: 200 }), 60)
    return () => clearTimeout(t)
  }, [width, height, count, fitView])
  return null
}

const STAGES = ["Intent", "Service", "Architecture", "Implementation", "Runtime"] as const

function DrillDown() {
  const { services, edges, nodes, traces, level } = useKivo()
  const generated = services.filter((s) => s.intent !== "(detected from repository)")
  const pool = generated.length ? generated : services
  const [id, setId] = useState(pool[pool.length - 1]?.id)
  const [stage, setStage] = useState<(typeof STAGES)[number]>("Intent")
  const spec = services.find((s) => s.id === id) ?? pool[0]
  if (!spec) return null
  const prefix = spec.api.endpoints[0]?.path.split("/")[1]
  const trace = traces.find((t) => t.route.split("/")[1] === prefix)
  const connected = edges.filter((e) => e.source === spec.id || e.target === spec.id).map((e) => (e.source === spec.id ? e.target : e.source))
  const code = codeFor(spec)

  return (
    <div className="min-w-0 space-y-3">
      <div className="flex items-center justify-between">
        <SectionLabel className="pb-0">Drill down</SectionLabel>
        <Select value={spec.id} onValueChange={setId}>
          <SelectTrigger size="sm" className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {services.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center gap-1 overflow-x-auto">
        {STAGES.map((s, i) => (
          <div key={s} className="flex items-center gap-1">
            <button
              onClick={() => setStage(s)}
              data-active={stage === s || undefined}
              className="rounded-md px-2.5 py-1 text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground data-active:bg-accent data-active:text-foreground"
            >
              {s}
            </button>
            {i < STAGES.length - 1 && <ChevronRight className="size-3 text-muted-foreground/50" />}
          </div>
        ))}
      </div>
      <div className="kivo-in rounded-xl border p-4 text-[13px] leading-relaxed" key={stage + spec.id}>
        {stage === "Intent" && <p className="border-l-2 pl-3">{spec.intent}</p>}
        {stage === "Service" && (
          <div className="space-y-2">
            <p>{spec.purpose}</p>
            <div className="flex flex-wrap gap-1">
              {spec.requirements.map((r) => (
                <Badge key={r.id} variant="secondary">
                  {r.title}
                </Badge>
              ))}
              {spec.api.endpoints.map((e) => (
                <Badge key={e.path + e.method} variant="outline" className="font-mono text-[10px]">
                  {e.method} {e.path}
                </Badge>
              ))}
            </div>
          </div>
        )}
        {stage === "Architecture" && (
          <div className="flex flex-wrap items-center gap-2">
            <Badge>{spec.name}</Badge>
            <span className="text-muted-foreground">connects to</span>
            {connected.map((c) => {
              const n = nodes.find((x) => x.id === c)
              return (
                <Capturable key={c} as="span" refObj={{ kind: "node", id: c, label: n?.label ?? c, conceptId: n?.concept }} className="rounded-md border px-2 py-0.5 hover:bg-accent">
                  {n?.label ?? c}
                </Capturable>
              )
            })}
          </div>
        )}
        {stage === "Implementation" && (
          <div className="space-y-2">
            <div className="font-mono text-[11px] text-muted-foreground">{code.path}</div>
            <pre className="overflow-x-auto rounded-md bg-muted/40 p-3 font-mono text-[12px] leading-5">{code.code.split("\n").slice(0, 12).join("\n")}</pre>
          </div>
        )}
        {stage === "Runtime" &&
          (trace ? (
            <div className="space-y-1">
              <div className="font-mono text-[12px]">
                {trace.method} {trace.route} → {trace.status} in {trace.totalMs}ms
              </div>
              {trace.spans.map((s) => (
                <div key={s.id} className="flex gap-2 text-muted-foreground">
                  <span className="w-12 text-right font-mono text-[11px] tabular-nums">{s.durationMs}ms</span>
                  <span>{s.narration[level]}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground">No live traffic for this service yet.</p>
          ))}
      </div>
    </div>
  )
}

function Insights() {
  const { library, experiences } = useKivo()
  const actions = useCaptureActions()
  const [hidden, setHidden] = useState<string[]>([])
  const insights = learningInsights(library, experiences).filter((i) => !hidden.includes(i.conceptId))
  const inProject = Object.values(CONCEPTS).filter((c) => c.usedIn.length && c.id !== "stripe")

  return (
    <div className="space-y-6">
      {insights.length > 0 && (
        <div className="space-y-2">
          <SectionLabel>Learning insights · optional</SectionLabel>
          {insights.slice(0, 2).map((i) => (
            <div key={i.conceptId} className="rounded-xl border p-3 text-[13px]">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-1.5 font-medium">
                  <Sparkles className="size-3.5 text-muted-foreground" />
                  You've worked with {i.name} {i.count} times
                </div>
                <Button variant="ghost" size="icon-xs" aria-label="Dismiss" onClick={() => setHidden([...hidden, i.conceptId])}>
                  <X />
                </Button>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs">
                {i.explored.map((e) => (
                  <span key={e}>✓ {e}</span>
                ))}
                {i.unexplored.map((e) => (
                  <button key={e} className="text-left text-muted-foreground hover:text-foreground" onClick={() => actions.ask({ kind: "concept", id: i.conceptId, label: `${i.name}: ${e}`, conceptId: i.conceptId })}>
                    ○ {e}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="space-y-2">
        <SectionLabel>Concepts in this project</SectionLabel>
        <div className="flex flex-wrap gap-1.5">
          {inProject.map((c) => (
            <Capturable key={c.id} as="span" refObj={{ kind: "concept", id: c.id, label: c.name, conceptId: c.id }} className="rounded-full border px-2.5 py-0.5 text-xs hover:bg-accent">
              {c.name}
            </Capturable>
          ))}
        </div>
      </div>
    </div>
  )
}
