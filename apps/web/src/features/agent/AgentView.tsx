import { useEffect, useMemo, useRef, useState } from "react"
import { Ban, Check, CheckCheck, ChevronRight, Circle, CircleCheck, CircleDot, FilePlus, FileSearch, FileText, FolderTree, ListTodo, Loader2, Pencil, Search, Square, SquareTerminal, TriangleAlert, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import { Markdown } from "@/shell/Markdown"
import { openFile } from "@/state/runners"
import { diffStats, hunks, lineDiff } from "./diff"
import { decideCommand, decideEdit, killCommand } from "./runner"
import { useAgent, type AgentItem, type CommandRun, type EditProposal } from "./store"

type ToolItem = Extract<AgentItem, { kind: "tool" }>

const ICONS: Record<string, typeof FileText> = { list_files: FolderTree, read_file: FileText, search: Search, edit_file: Pencil, create_file: FilePlus, run_command: SquareTerminal, todo_write: ListTodo }

/** The Agent conversation: text, tool calls, diffs awaiting review and commands awaiting approval. */
export function AgentMessages() {
  const items = useAgent((s) => s.items)
  const todos = useAgent((s) => s.todos)
  const running = useAgent((s) => s.running)
  const waiting = useAgent((s) => s.waiting)
  const last = items[items.length - 1]
  const bottom = useRef<HTMLDivElement>(null)
  const size = last ? (last.kind === "assistant" ? last.text.length + last.reasoning.length : last.kind === "tool" ? (last.command?.output.length ?? 0) + (last.edit ? 1 : 0) : 0) : 0
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "nearest" })
  }, [items.length, size, todos.length])

  return (
    <div className="space-y-3">
      {items.map((i) => {
        if (i.kind === "user")
          return (
            <div key={i.id} className="kivo-in ml-8 rounded-lg bg-muted px-3 py-2 whitespace-pre-wrap">
              {i.mentions.length > 0 && <div className="mb-0.5 truncate font-mono text-[10px] text-muted-foreground">@ {i.mentions.join(", ")}</div>}
              {i.text}
            </div>
          )
        if (i.kind === "assistant")
          return (
            <div key={i.id} className="kivo-in space-y-1.5">
              {i.reasoning && <Thinking text={i.reasoning} streaming={i.streaming && !i.text} />}
              {i.text && <Markdown>{i.text}</Markdown>}
              {i.streaming && i.text && <span className="kivo-pulse inline-block h-3 w-1.5 bg-foreground/60" />}
            </div>
          )
        if (i.kind === "notice")
          return (
            <div key={i.id} className={cn("flex items-start gap-1.5 text-xs", i.tone === "error" ? "text-destructive" : "text-muted-foreground")}>
              {i.tone === "error" && <TriangleAlert className="mt-px size-3.5 shrink-0" />}
              <span>{i.text}</span>
            </div>
          )
        if (i.edit) return <EditCard key={i.id} item={i} edit={i.edit} />
        if (i.command) return <CommandCard key={i.id} item={i} cmd={i.command} />
        return <ToolCard key={i.id} item={i} />
      })}
      {todos.length > 0 && <TodoCard />}
      {running && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" /> {waiting ?? "Working…"}
        </div>
      )}
      <div ref={bottom} />
    </div>
  )
}

function Thinking({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible open={open || streaming} onOpenChange={setOpen} className="text-xs">
      <CollapsibleTrigger className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground">
        <ChevronRight className={cn("size-3 transition-transform", (open || streaming) && "rotate-90")} />
        {streaming ? "Thinking…" : "Reasoning"}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 max-h-32 overflow-auto border-l pl-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground">{text}</CollapsibleContent>
    </Collapsible>
  )
}

function StatusIcon({ status }: { status: ToolItem["status"] }) {
  if (status === "running") return <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
  if (status === "error") return <X className="size-3 shrink-0 text-destructive" />
  return <Check className="size-3 shrink-0 text-muted-foreground" />
}

function ToolCard({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false)
  const Icon = ICONS[item.name] ?? FileSearch
  const canOpen = !!item.detail
  return (
    <Collapsible open={open && canOpen} onOpenChange={setOpen} className="rounded-md border text-xs">
      <CollapsibleTrigger className={cn("flex w-full min-w-0 items-center gap-1.5 px-2 py-1.5 text-left", canOpen ? "hover:bg-accent/50" : "cursor-default")}>
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-medium">{item.name}</span>
        <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">{item.summary}</span>
        <span className={cn("ml-auto shrink-0 pl-2 text-[11px]", item.status === "error" ? "text-destructive" : "text-muted-foreground")}>{item.result}</span>
        <StatusIcon status={item.status} />
      </CollapsibleTrigger>
      {canOpen && <CollapsibleContent className="max-h-48 overflow-auto border-t px-2 py-1.5 font-mono text-[11px] whitespace-pre text-muted-foreground">{item.detail}</CollapsibleContent>}
    </Collapsible>
  )
}

function EditCard({ item, edit }: { item: ToolItem; edit: EditProposal }) {
  const lines = useMemo(() => lineDiff(edit.original, edit.proposed), [edit.original, edit.proposed])
  const view = useMemo(() => hunks(lines, 3), [lines])
  const stats = diffStats(lines)
  const [open, setOpen] = useState(true)
  const pending = edit.status === "pending"
  return (
    <div className={cn("overflow-hidden rounded-md border text-xs", pending && "border-foreground/30")}>
      <div className="flex min-w-0 items-center gap-1.5 px-2 py-1.5">
        <button className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => setOpen(!open)}>
          <ChevronRight className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
          {edit.isNew ? <FilePlus className="size-3.5 shrink-0 text-muted-foreground" /> : <Pencil className="size-3.5 shrink-0 text-muted-foreground" />}
          <span className="min-w-0 truncate font-mono text-[11px]" title={edit.path}>
            {edit.path}
          </span>
          <span className="shrink-0 font-mono text-[11px] text-success">+{stats.added}</span>
          <span className="shrink-0 font-mono text-[11px] text-destructive">−{stats.removed}</span>
        </button>
        {edit.status === "applied" && (
          <Button variant="ghost" size="xs" className="h-5 px-1.5 text-[11px]" onClick={() => openFile(edit.path)}>
            Open
          </Button>
        )}
        <EditBadge edit={edit} />
      </div>
      {open && (
        <div className="max-h-72 overflow-auto border-t bg-muted/20 font-mono text-[11px] leading-[1.55]">
          {view.map((l, k) =>
            l.type === "gap" ? (
              <div key={k} className="px-2 text-muted-foreground/70 select-none">
                ⋯ {l.count} unchanged line{l.count === 1 ? "" : "s"}
              </div>
            ) : (
              <div key={k} className={cn("px-2 whitespace-pre", l.type === "add" && "bg-success/12 text-foreground", l.type === "del" && "bg-destructive/10 text-foreground/80", l.type === "ctx" && "text-muted-foreground")}>
                <span className="mr-2 inline-block w-2 select-none">{l.type === "add" ? "+" : l.type === "del" ? "−" : " "}</span>
                {l.text || " "}
              </div>
            ),
          )}
        </div>
      )}
      {pending && (
        <div className="flex items-center gap-1.5 border-t px-2 py-1.5">
          <Button size="xs" disabled={edit.busy} onClick={() => decideEdit(item.id, true)}>
            <Check /> Accept
          </Button>
          <Button size="xs" variant="outline" disabled={edit.busy} onClick={() => decideEdit(item.id, false)}>
            <X /> Reject
          </Button>
          <Button size="xs" variant="ghost" disabled={edit.busy} className="ml-auto text-muted-foreground" onClick={() => decideEdit(item.id, true, true)} title="Accept this and every later edit in this run">
            <CheckCheck /> Accept all
          </Button>
        </div>
      )}
      {edit.message && edit.status === "error" && <div className="border-t px-2 py-1.5 text-destructive">{edit.message}</div>}
    </div>
  )
}

function EditBadge({ edit }: { edit: EditProposal }) {
  const label = { pending: "Review", applied: edit.isNew ? "Created" : "Applied", rejected: "Rejected", error: "Failed", expired: "Not applied" }[edit.status]
  return (
    <Badge variant={edit.status === "applied" ? "secondary" : "outline"} className={cn("h-4 shrink-0 px-1.5 text-[10px]", edit.status === "error" && "text-destructive")}>
      {label}
    </Badge>
  )
}

function CommandCard({ item, cmd }: { item: ToolItem; cmd: CommandRun }) {
  const pre = useRef<HTMLPreElement>(null)
  useEffect(() => {
    if (pre.current) pre.current.scrollTop = pre.current.scrollHeight
  }, [cmd.output])
  const label = { pending: "Needs approval", running: "Running", done: `Exit ${cmd.code}`, denied: "Denied", killed: "Stopped", timeout: "Timed out", expired: "Not run" }[cmd.status]
  return (
    <div className={cn("overflow-hidden rounded-md border text-xs", cmd.status === "pending" && "border-warning/60")}>
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <SquareTerminal className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="font-medium">run_command</span>
        <span className="truncate font-mono text-[11px] text-muted-foreground">in {cmd.cwd === "." ? "project root" : cmd.cwd}</span>
        {cmd.auto && <span className="text-[11px] text-muted-foreground">· always allowed</span>}
        <Badge variant="outline" className={cn("ml-auto h-4 shrink-0 px-1.5 text-[10px]", (cmd.status === "done" && cmd.code !== 0) || cmd.status === "timeout" ? "text-destructive" : "")}>
          {cmd.status === "running" && <Loader2 className="size-2.5 animate-spin" />}
          {label}
        </Badge>
      </div>
      <pre className="border-t bg-muted/40 px-2 py-1.5 font-mono text-[11.5px] break-all whitespace-pre-wrap">$ {cmd.command}</pre>
      {cmd.status === "pending" && (
        <div className="flex flex-wrap items-center gap-1.5 border-t px-2 py-1.5">
          <Button size="xs" disabled={cmd.busy} onClick={() => decideCommand(item.id, true)}>
            <Check /> Approve
          </Button>
          <Button size="xs" variant="outline" disabled={cmd.busy} onClick={() => decideCommand(item.id, false)}>
            <Ban /> Deny
          </Button>
          <Button size="xs" variant="ghost" disabled={cmd.busy} className="ml-auto text-muted-foreground" onClick={() => decideCommand(item.id, true, true)} title="Run it, and run this exact command without asking for the rest of this session">
            Always allow
          </Button>
        </div>
      )}
      {(cmd.output || cmd.status === "running") && (
        <div className="relative border-t">
          <pre ref={pre} className="max-h-48 overflow-auto px-2 py-1.5 font-mono text-[11px] whitespace-pre-wrap text-muted-foreground">
            {cmd.output.slice(-6000) || "…"}
          </pre>
          {cmd.status === "running" && (
            <Button size="xs" variant="outline" className="absolute top-1 right-1 h-5 px-1.5 text-[11px]" onClick={() => killCommand(item.id)}>
              <Square className="size-2.5 fill-current" /> Kill
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

function TodoCard() {
  const todos = useAgent((s) => s.todos)
  const done = todos.filter((t) => t.status === "completed").length
  return (
    <div className="rounded-md border px-2 py-1.5 text-xs">
      <div className="mb-1 flex items-center gap-1.5 font-medium">
        <ListTodo className="size-3.5 text-muted-foreground" /> Tasks
        <span className="ml-auto font-normal text-muted-foreground">
          {done}/{todos.length}
        </span>
      </div>
      <ul className="space-y-0.5">
        {todos.map((t, i) => (
          <li key={i} className={cn("flex items-start gap-1.5", t.status === "completed" && "text-muted-foreground line-through")}>
            {t.status === "completed" ? <CircleCheck className="mt-px size-3.5 shrink-0" /> : t.status === "in_progress" ? <CircleDot className="mt-px size-3.5 shrink-0 text-info" /> : <Circle className="mt-px size-3.5 shrink-0 text-muted-foreground" />}
            <span>{t.content}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
