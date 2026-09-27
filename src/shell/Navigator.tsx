import { useState } from "react"
import { ChevronRight, FileCode2, Folder, Plus, ShieldCheck } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { Discipline } from "@/core/types"
import { cn } from "@/lib/utils"
import { openFile } from "@/state/runners"
import { useKivo } from "@/state/store"
import { KindIcon, StatusDot } from "./bits"
import { Capturable } from "./capture"

export const DISCIPLINES: { id: Discipline; label: string; sections: string[] }[] = [
  { id: "software", label: "Software", sections: [] },
  { id: "ml", label: "AI / ML", sections: ["Datasets", "Experiments", "Models", "Training", "GPU", "Metrics", "Evaluation", "Pipelines"] },
  { id: "rl", label: "Reinforcement Learning", sections: ["Environment", "Agent", "Policy", "State", "Action", "Reward", "Episodes", "Training", "Evaluation"] },
  { id: "security", label: "Cybersecurity", sections: ["Targets", "Assets", "Attack Surface", "Threat Model", "Vulnerabilities", "Security Tests", "Findings", "Remediation", "Sandbox"] },
  { id: "devops", label: "DevOps / SRE", sections: ["Services", "Containers", "Kubernetes", "Deployments", "Logs", "Metrics", "Traces", "Incidents"] },
]

export function Navigator() {
  const { discipline, setDiscipline, analysis } = useKivo()
  const def = DISCIPLINES.find((d) => d.id === discipline)!

  return (
    <div className="flex h-full flex-col bg-sidebar">
      <div className="border-b p-2">
        <Select value={discipline} onValueChange={(v) => setDiscipline(v as Discipline)}>
          <SelectTrigger size="sm" className="w-full text-[13px]">
            <span className="text-muted-foreground">Workspace</span>
            <SelectValue>{def.label}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {DISCIPLINES.map((d) => (
              <SelectItem key={d.id} value={d.id}>
                {d.label}
                {analysis.recommended.includes(d.id) && (
                  <Badge variant="secondary" className="ml-1 h-4 px-1.5 text-[10px]">
                    detected
                  </Badge>
                )}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-2">
          {discipline === "software" ? <SoftwareSections /> : <DisciplineSections sections={def.sections} discipline={discipline} />}
        </div>
      </ScrollArea>
    </div>
  )
}

function Group({ title, children, action, defaultOpen = true }: { title: string; children: React.ReactNode; action?: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="flex items-center justify-between">
        <CollapsibleTrigger className="flex items-center gap-1 px-1 py-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase hover:text-foreground">
          <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
          {title}
        </CollapsibleTrigger>
        {action}
      </div>
      <CollapsibleContent className="mt-0.5 space-y-px">{children}</CollapsibleContent>
    </Collapsible>
  )
}

function Row({ children, active, onClick }: { children: React.ReactNode; active?: boolean; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      data-active={active || undefined}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] text-foreground/80 hover:bg-accent hover:text-foreground data-active:bg-accent data-active:text-foreground"
    >
      {children}
    </button>
  )
}

function SoftwareSections() {
  const { services, nodes, activeServiceId, openService, draft, discardDraft, build, mode, files } = useKivo()
  const infra = nodes.filter((n) => n.kind !== "service")

  if (mode === "code") {
    return (
      <Group title={`Explorer · ${files.length} files`}>
        <FileTree />
      </Group>
    )
  }

  return (
    <>
      <Group
        title="Services"
        action={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="New service"
            onClick={() => {
              discardDraft()
              openService(null)
              setTimeout(() => document.getElementById("intent-input")?.focus(), 0)
            }}
          >
            <Plus />
          </Button>
        }
      >
        {services.map((s) => (
          <Row key={s.id} active={activeServiceId === s.id} onClick={() => openService(s.id)}>
            <StatusDot status={s.status} />
            <span className="flex-1 truncate">{s.name}</span>
            {build?.specId === s.id && !build.finished && <span className="font-mono text-[10px] text-muted-foreground">{build.index + 1}/{build.steps.length}</span>}
          </Row>
        ))}
        {draft && (
          <Row active onClick={() => openService(null)}>
            <StatusDot status="draft" />
            <span className="flex-1 truncate italic">{draft.name}</span>
            <span className="text-[10px] text-muted-foreground">draft</span>
          </Row>
        )}
      </Group>

      <Group title="System">
        {infra.map((n) => (
          <Capturable key={n.id} refObj={{ kind: "node", id: n.id, label: n.label, conceptId: n.concept }} className="flex items-center gap-2 px-2 py-1 text-[13px] text-foreground/80 hover:bg-accent">
            <KindIcon kind={n.kind} />
            <span className="flex-1 truncate">{n.label}</span>
            <span className="truncate text-[11px] text-muted-foreground">{n.tech}</span>
          </Capturable>
        ))}
      </Group>

      <Group title="Files" defaultOpen={false}>
        <FileTree />
      </Group>
    </>
  )
}

interface TreeNode {
  name: string
  path: string
  children?: Map<string, TreeNode>
}

function buildTree(paths: string[]) {
  const root: TreeNode = { name: "", path: "", children: new Map() }
  for (const p of paths) {
    let node = root
    p.split("/").forEach((seg, i, all) => {
      const path = all.slice(0, i + 1).join("/")
      if (!node.children!.has(seg)) node.children!.set(seg, { name: seg, path, children: i < all.length - 1 ? new Map() : undefined })
      node = node.children!.get(seg)!
    })
  }
  return root
}

function FileTree() {
  const files = useKivo((s) => s.files)
  const tree = buildTree(files)
  return (
    <div className="font-mono text-[12px]">
      {[...tree.children!.values()].sort(sortNodes).map((n) => (
        <TreeItem key={n.path} node={n} depth={0} />
      ))}
    </div>
  )
}

const sortNodes = (a: TreeNode, b: TreeNode) => Number(!!b.children) - Number(!!a.children) || a.name.localeCompare(b.name)

function TreeItem({ node, depth }: { node: TreeNode; depth: number }) {
  const activeFile = useKivo((s) => s.activeFile)
  const mode = useKivo((s) => s.mode)
  const building = useKivo((s) => (s.build && !s.build.finished ? s.build.specId : null))
  const [open, setOpen] = useState(depth === 0 && (node.name === "services" || node.name === "backend"))
  const pad = { paddingLeft: 8 + depth * 12 }

  if (node.children) {
    const isOpen = open || (building !== null && node.path.startsWith("services"))
    return (
      <div>
        <button className="flex w-full items-center gap-1 rounded-md py-0.5 pr-2 text-left text-foreground/80 hover:bg-accent" style={pad} onClick={() => setOpen(!isOpen)}>
          <ChevronRight className={cn("size-3 shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-90")} />
          <Folder className="size-3 shrink-0 text-muted-foreground" />
          <span className="truncate">{node.name}</span>
        </button>
        {isOpen && [...node.children.values()].sort(sortNodes).map((c) => <TreeItem key={c.path} node={c} depth={depth + 1} />)}
      </div>
    )
  }
  return (
    <button
      data-active={(mode === "code" && activeFile === node.path) || undefined}
      className="flex w-full items-center gap-1.5 rounded-md py-0.5 pr-2 text-left text-foreground/75 hover:bg-accent hover:text-foreground data-active:bg-accent data-active:text-foreground"
      style={{ paddingLeft: 8 + depth * 12 + 16 }}
      onClick={() => openFile(node.path)}
      title={node.path}
    >
      <FileCode2 className="size-3 shrink-0 text-muted-foreground" />
      <span className="truncate">{node.name}</span>
    </button>
  )
}

function DisciplineSections({ sections, discipline }: { sections: string[]; discipline: Discipline }) {
  return (
    <>
      {discipline === "security" && (
        <div className="flex gap-2 rounded-md border p-2 text-[11px] text-muted-foreground">
          <ShieldCheck className="size-3.5 shrink-0" />
          Security operations run only against assets you declare in scope, inside the Kivo sandbox.
        </div>
      )}
      <Group title="Workspace">
        {sections.map((s) => (
          <Row key={s}>
            <span className="size-1.5 rounded-full border border-muted-foreground/40" />
            <span className="flex-1 truncate">{s}</span>
          </Row>
        ))}
      </Group>
      <p className="px-2 text-[11px] leading-relaxed text-muted-foreground">
        Same engine, different lens. Nothing matching this workspace was detected in <span className="font-mono">tandem</span>. It fills in from the
        Project Graph once relevant code (e.g. PyTorch, Gymnasium, Kubernetes manifests) is present.
      </p>
    </>
  )
}
