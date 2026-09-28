import { useEffect, useMemo, useRef, useState } from "react"
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  CloudUpload,
  Ellipsis,
  FileText,
  FolderGit2,
  GitBranch,
  GitBranchPlus,
  GitCommitHorizontal,
  LoaderCircle,
  Minus,
  Plus,
  RefreshCw,
  Sparkles,
  Undo2,
  X,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Textarea } from "@/components/ui/textarea"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { subscribe } from "@/lib/api"
import { diffTabPath, scm, type Branch, type Commit, type CommitDetail, type DiffKind, type FileChange, type RemoteOp, type RepoStatus } from "@/lib/scm-api"
import { cn } from "@/lib/utils"
import { openFile } from "@/state/runners"
import { useKivo } from "@/state/store"
import { useConfirm } from "./confirm"
import { openDiff, reloadOpenBuffers, STATUS_COLOR, STATUS_LABEL, useScm } from "./state"
import { inBrowser } from "@/lib/transport"

const POLL_MS = 3000

const splitPath = (p: string) => {
  const i = p.lastIndexOf("/")
  return i < 0 ? { name: p, dir: "" } : { name: p.slice(i + 1), dir: p.slice(0, i) }
}

/** Keep status fresh: on mount, project switch, window focus, daemon file/scm events, and a light poll. */
function useLiveStatus() {
  const refresh = useScm((s) => s.refresh)
  const projectId = useKivo((s) => s.projectInfo?.id)
  const daemon = useKivo((s) => s.daemon)
  useEffect(() => {
    if (!daemon) return
    void refresh()
    const onFocus = () => void refresh()
    window.addEventListener("focus", onFocus)
    const unsubscribe = subscribe((e) => (e.t === "fs" || e.t === "scm") && void refresh())
    const timer = setInterval(() => document.visibilityState === "visible" && void refresh(), POLL_MS)
    return () => {
      window.removeEventListener("focus", onFocus)
      unsubscribe()
      clearInterval(timer)
    }
  }, [refresh, projectId, daemon])
}

/** Source Control view for the Code-mode sidebar. */
export function ScmPanel() {
  if (inBrowser)
    return (
      <Empty title="Source control needs Kivo on your computer">
        Kivo is running in your browser, which can't run git. Run it locally (<code className="font-mono">npm run dev</code>) to stage, commit, diff, branch and push.
      </Empty>
    )
  return <DaemonScmPanel />
}

function DaemonScmPanel() {
  useLiveStatus()
  const { status, error, refresh } = useScm()
  const daemon = useKivo((s) => s.daemon)

  if (!daemon) return <Empty title="Daemon offline">Source control needs the local Kivo daemon. It reconnects automatically.</Empty>
  if (!status) {
    if (error)
      return (
        <Empty title="Couldn't read git status" action={<Button size="xs" variant="outline" onClick={() => void refresh()}>Retry</Button>}>
          {error}
        </Empty>
      )
    return (
      <div className="flex items-center gap-2 p-3 text-[12px] text-muted-foreground">
        <LoaderCircle className="size-3.5 animate-spin" /> Reading git status…
      </div>
    )
  }
  if (!status.repo) return <NotARepo />
  return <RepoView status={status} />
}

function Empty({ title, children, action, icon: Icon }: { title: string; children: React.ReactNode; action?: React.ReactNode; icon?: React.ComponentType<{ className?: string }> }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
      {Icon && <Icon className="size-6 text-muted-foreground/60" />}
      <div className="text-[13px] font-medium">{title}</div>
      <div className="text-[12px] leading-relaxed text-muted-foreground">{children}</div>
      {action}
    </div>
  )
}

function NotARepo() {
  const { act, busy } = useScm()
  const name = useKivo((s) => s.projectInfo?.name)
  return (
    <Empty
      icon={FolderGit2}
      title="Not a git repository"
      action={
        <Button size="sm" className="mt-1" disabled={!!busy} onClick={() => void act("Couldn't initialize the repository", () => scm.init()).then(() => toast.success("Initialized an empty git repository"))}>
          {busy ? <LoaderCircle className="animate-spin" /> : <FolderGit2 />}
          Initialize Repository
        </Button>
      }
    >
      {name ? <span className="font-medium text-foreground">{name}</span> : "This folder"} isn't tracked by git yet. Initialize a repository to see changes, commit, and branch.
    </Empty>
  )
}

function RepoView({ status }: { status: RepoStatus }) {
  const { confirm, dialog } = useConfirm()
  const [progress, setProgress] = useState<string | null>(null)
  const changes = useMemo(() => [...status.unstaged, ...status.untracked].sort((a, b) => a.path.localeCompare(b.path)), [status])
  const total = status.staged.length + changes.length + status.conflicted.length

  return (
    <div className="flex h-full min-h-0 flex-col">
      {dialog}
      <div className="flex items-center gap-1 border-b px-2 py-1.5">
        <BranchPicker status={status} confirm={confirm} />
        <SyncButton status={status} onProgress={setProgress} />
        <MoreMenu status={status} onProgress={setProgress} />
      </div>
      {progress && <div className="truncate border-b px-3 py-1 font-mono text-[10.5px] text-muted-foreground" title={progress}>{progress}</div>}
      <CommitBox status={status} changes={changes.length} />
      <ScrollArea className="min-h-0 flex-1">
        <div className="pb-3">
          {status.conflicted.length > 0 && <Section kind="merge" title="Merge Changes" files={status.conflicted} confirm={confirm} />}
          {status.staged.length > 0 && <Section kind="staged" title="Staged Changes" files={status.staged} confirm={confirm} />}
          {changes.length > 0 && <Section kind="changes" title="Changes" files={changes} confirm={confirm} />}
          {total === 0 && (
            <div className="px-4 py-5 text-center text-[12px] leading-relaxed text-muted-foreground">
              No changes. {status.oid ? "Your working tree matches the last commit." : "Add files to the project to make the first commit."}
            </div>
          )}
          <History oid={status.oid} />
        </div>
      </ScrollArea>
    </div>
  )
}

// ─── Header: branch, sync, more ───────────────────────────────────────────

type Confirm = ReturnType<typeof useConfirm>["confirm"]

function BranchPicker({ status, confirm }: { status: RepoStatus; confirm: Confirm }) {
  const { act, busy } = useScm()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [list, setList] = useState<Branch[] | null>(null)
  const label = status.branch ?? `(detached ${status.oid?.slice(0, 7) ?? ""})`

  useEffect(() => {
    if (!open) return
    scm.branches().then(setList, (err: Error) => toast.error("Couldn't list branches", { description: err.message }))
  }, [open])

  const dirty = status.staged.length + status.unstaged.length + status.conflicted.length > 0

  const switchTo = async (b: Branch) => {
    setOpen(false)
    if (b.current) return
    if (
      dirty &&
      !(await confirm({
        title: `Switch to ${b.name}?`,
        description: "You have uncommitted changes. They'll come with you to the other branch — and if they'd be overwritten, git refuses to switch, so nothing is lost.",
        action: "Switch branch",
      }))
    )
      return
    const ok = await act(`Couldn't switch to ${b.name}`, () => scm.checkout(b.name))
    if (ok) {
      toast.success(`Switched to ${b.remote ? b.name.slice(b.name.indexOf("/") + 1) : b.name}`)
      void reloadOpenBuffers()
    }
  }

  const create = async () => {
    const name = query.trim()
    if (!name) return
    setOpen(false)
    const r = await act("Couldn't create the branch", () => scm.createBranch(name))
    if (r) toast.success(`Created and switched to ${r.name}`)
  }

  const local = list?.filter((b) => !b.remote) ?? []
  const remote = list?.filter((b) => b.remote && !local.some((l) => b.name.endsWith(`/${l.name}`) && l.upstream === b.name)) ?? []
  const exists = list?.some((b) => b.name === query.trim())

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) setQuery("")
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="ghost" size="xs" className="min-w-0 flex-1 justify-start gap-1.5 px-1.5 font-normal" disabled={!!busy} title="Switch or create a branch">
          <GitBranch className="text-muted-foreground" />
          <span className="truncate text-[12.5px]">{label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <Command>
          <CommandInput placeholder="Switch to or create a branch…" value={query} onValueChange={setQuery} />
          <CommandList className="max-h-72">
            <CommandEmpty>{list ? "No branches match." : "Loading…"}</CommandEmpty>
            {query.trim() && !exists && (
              <CommandGroup>
                <CommandItem forceMount value={`create ${query}`} onSelect={() => void create()}>
                  <GitBranchPlus />
                  <span className="truncate">
                    Create branch <span className="font-medium">{query.trim()}</span>
                  </span>
                </CommandItem>
              </CommandGroup>
            )}
            {local.length > 0 && (
              <CommandGroup heading="Branches">
                {local.map((b) => (
                  <BranchItem key={b.name} b={b} onSelect={() => void switchTo(b)} />
                ))}
              </CommandGroup>
            )}
            {remote.length > 0 && (
              <CommandGroup heading="Remote branches">
                {remote.map((b) => (
                  <BranchItem key={b.name} b={b} onSelect={() => void switchTo(b)} />
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function BranchItem({ b, onSelect }: { b: Branch; onSelect: () => void }) {
  return (
    <CommandItem value={b.name} onSelect={onSelect}>
      {b.current ? <Check /> : <GitBranch className="text-muted-foreground" />}
      <span className="min-w-0 flex-1 truncate">{b.name}</span>
      {b.date && <span className="shrink-0 text-[11px] text-muted-foreground">{b.date}</span>}
    </CommandItem>
  )
}

/** Run fetch/pull/push/sync, streaming git's progress into the header line. */
function useRemote(onProgress: (line: string | null) => void) {
  const act = useScm((s) => s.act)
  return async (op: RemoteOp, label: string) => {
    onProgress(`${label}…`)
    const ok = await act(`${label} failed`, async () => {
      await scm.remote(op, (line) => onProgress(line))
      return true
    })
    onProgress(null)
    if (ok) {
      toast.success(`${label} complete`)
      if (op !== "fetch" && op !== "push") void reloadOpenBuffers()
    }
  }
}

function SyncButton({ status, onProgress }: { status: RepoStatus; onProgress: (l: string | null) => void }) {
  const busy = useScm((s) => s.busy)
  const remote = useRemote(onProgress)
  if (status.detached || !status.branch) return null
  const syncing = busy?.startsWith("Sync") || busy?.startsWith("Publish")

  if (!status.upstream) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="xs" disabled={!!busy || !status.oid} onClick={() => void remote("sync", "Publish")}>
            {syncing ? <LoaderCircle className="animate-spin" /> : <CloudUpload />}
            Publish
          </Button>
        </TooltipTrigger>
        <TooltipContent>{status.oid ? `Push ${status.branch} and set its upstream` : "Make a commit first"}</TooltipContent>
      </Tooltip>
    )
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="xs" className="gap-1 px-1.5 tabular-nums" disabled={!!busy} onClick={() => void remote("sync", "Sync")}>
          <RefreshCw className={cn(syncing && "animate-spin")} />
          {status.behind > 0 && (
            <span className="flex items-center">
              {status.behind}
              <ArrowDown className="size-3" />
            </span>
          )}
          {status.ahead > 0 && (
            <span className="flex items-center">
              {status.ahead}
              <ArrowUp className="size-3" />
            </span>
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        Sync with {status.upstream}: pull {status.behind}, push {status.ahead}
      </TooltipContent>
    </Tooltip>
  )
}

function MoreMenu({ status, onProgress }: { status: RepoStatus; onProgress: (l: string | null) => void }) {
  const { busy, refresh } = useScm()
  const remote = useRemote(onProgress)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label="More source control actions" disabled={!!busy}>
          <Ellipsis />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem onSelect={() => void refresh()}>
          <RefreshCw /> Refresh
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void remote("fetch", "Fetch")}>Fetch</DropdownMenuItem>
        <DropdownMenuItem disabled={!status.upstream} onSelect={() => void remote("pull", "Pull")}>
          Pull
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!status.branch || !status.oid} onSelect={() => void remote("push", status.upstream ? "Push" : "Publish")}>
          {status.upstream ? "Push" : "Publish branch"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// ─── Commit box ────────────────────────────────────────────────────────────

function CommitBox({ status, changes }: { status: RepoStatus; changes: number }) {
  const { message, setMessage, act, busy } = useScm()
  const ai = useKivo((s) => s.ai?.ai ?? false)
  const [generating, setGenerating] = useState<AbortController | null>(null)
  const ref = useRef<HTMLTextAreaElement>(null)
  const staged = status.staged.length
  const canCommit = (staged > 0 || changes > 0) && status.conflicted.length === 0

  const commit = async () => {
    if (!canCommit || busy) return
    if (!message.trim()) {
      toast.error("Write a commit message first")
      ref.current?.focus()
      return
    }
    const r = await act("Commit failed", () => scm.commitChanges(message.trim(), staged === 0))
    if (r) {
      setMessage("")
      toast.success(`Committed ${r.hash.slice(0, 7)}`, { description: message.trim().split("\n")[0] })
    }
  }

  const generate = async () => {
    if (generating) return generating.abort()
    const ac = new AbortController()
    setGenerating(ac)
    const before = message
    try {
      const text = await scm.commitMessage((t) => setMessage(t), ac.signal)
      setMessage(text)
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setMessage(before)
        toast.error("Couldn't generate a commit message", { description: (err as Error).message })
      }
    } finally {
      setGenerating(null)
    }
  }

  const where = status.branch ? ` on "${status.branch}"` : ""
  return (
    <div className="space-y-1.5 border-b p-2">
      <div className="relative">
        <Textarea
          ref={ref}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              void commit()
            }
          }}
          placeholder={`Message (⌘⏎ to commit${where})`}
          className="max-h-40 min-h-14 resize-none pr-8 text-[12.5px] md:text-[12.5px]"
          disabled={!!generating}
          aria-label="Commit message"
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className="absolute top-1 right-1 text-muted-foreground"
              disabled={!ai || (!generating && staged + changes === 0)}
              onClick={() => void generate()}
              aria-label={generating ? "Stop generating" : "Generate commit message"}
            >
              {generating ? <X /> : <Sparkles />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{!ai ? "No AI provider available" : generating ? "Stop" : `Generate a message from the ${staged ? "staged" : "unstaged"} changes`}</TooltipContent>
        </Tooltip>
      </div>
      <Button size="sm" className="w-full" disabled={!canCommit || !!busy || !!generating} onClick={() => void commit()} title={staged ? undefined : "Nothing is staged — this stages every change and commits it"}>
        {busy === "Commit failed" ? <LoaderCircle className="animate-spin" /> : <Check />}
        {staged || !changes ? "Commit" : "Commit All"}
      </Button>
      {status.conflicted.length > 0 && <p className="text-[11px] text-destructive">Resolve the merge conflicts and stage them before committing.</p>}
    </div>
  )
}

// ─── Change sections ───────────────────────────────────────────────────────

type SectionKind = "staged" | "changes" | "merge"

function Section({ kind, title, files, confirm }: { kind: SectionKind; title: string; files: FileChange[]; confirm: Confirm }) {
  const [open, setOpen] = useState(true)
  const { act, busy } = useScm()
  const paths = files.map((f) => f.path)

  const discardAll = async () => {
    const untracked = files.filter((f) => f.status === "?").length
    const tracked = files.length - untracked
    const ok = await confirm({
      title: `Discard all ${files.length} change${files.length === 1 ? "" : "s"}?`,
      description: (
        <>
          {tracked > 0 && <p>{tracked} tracked file{tracked === 1 ? " is" : "s are"} restored to the staged/committed version — this can't be undone.</p>}
          {untracked > 0 && <p className="mt-1">{untracked} untracked file{untracked === 1 ? " moves" : "s move"} to the Trash.</p>}
        </>
      ),
      action: "Discard all",
      destructive: true,
    })
    if (ok && (await act("Couldn't discard changes", () => scm.discard(paths)))) void reloadOpenBuffers(paths)
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="group/section flex h-7 items-center gap-1 pr-1.5 pl-1 hover:bg-sidebar-accent/50">
        <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-1 text-left text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
          <span className="truncate">{title}</span>
        </CollapsibleTrigger>
        <div className="hidden items-center group-hover/section:flex">
          {kind === "changes" && (
            <IconAction label="Discard all changes" disabled={!!busy} onClick={() => void discardAll()}>
              <Undo2 />
            </IconAction>
          )}
          {kind === "staged" ? (
            <IconAction label="Unstage all" disabled={!!busy} onClick={() => void act("Couldn't unstage", () => scm.unstage("all"))}>
              <Minus />
            </IconAction>
          ) : (
            <IconAction label={kind === "merge" ? "Mark all resolved (stage)" : "Stage all changes"} disabled={!!busy} onClick={() => void act("Couldn't stage", () => scm.stage(kind === "merge" ? paths : "all"))}>
              <Plus />
            </IconAction>
          )}
        </div>
        <span className="min-w-5 rounded-full bg-muted px-1.5 text-center text-[10.5px] font-medium text-muted-foreground tabular-nums">{files.length}</span>
      </div>
      <CollapsibleContent>
        {files.map((f) => (
          <FileRow key={`${kind}:${f.path}`} kind={kind} file={f} confirm={confirm} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  )
}

function IconAction({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          className="size-5 text-muted-foreground hover:text-foreground"
          aria-label={label}
          disabled={disabled}
          onClick={(e) => {
            e.stopPropagation()
            onClick()
          }}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function FileRow({ kind, file, confirm }: { kind: SectionKind; file: FileChange; confirm: Confirm }) {
  const { act, busy } = useScm()
  const active = useKivo((s) => s.activeFile)
  const { name, dir } = splitPath(file.path)
  const diffKind: DiffKind = kind === "staged" ? "staged" : "working"
  const tab = diffTabPath(diffKind, file.path)
  const deleted = file.status === "D"

  // Conflicts open the file itself: resolving means editing the markers.
  const open = () => (kind === "merge" ? void openFile(file.path) : openDiff(diffKind, file.path))

  const discard = async () => {
    const untracked = file.status === "?"
    const ok = await confirm({
      title: untracked ? `Move ${name} to the Trash?` : `Discard changes in ${name}?`,
      description: untracked ? "This file isn't tracked by git. It will be moved to the Trash." : "Your unstaged changes to this file will be lost — this can't be undone.",
      action: untracked ? "Move to Trash" : "Discard changes",
      destructive: true,
    })
    if (ok && (await act("Couldn't discard changes", () => scm.discard([file.path])))) void reloadOpenBuffers([file.path])
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => e.key === "Enter" && open()}
      className={cn("group/row flex h-6 cursor-pointer items-center gap-1.5 pr-1.5 pl-6 text-[12.5px] hover:bg-sidebar-accent/60", active === tab && "bg-sidebar-accent")}
      title={`${file.orig ? `${file.orig} → ` : ""}${file.path} — ${STATUS_LABEL[file.status] ?? file.code}${kind === "merge" ? ` (${file.code})` : ""}`}
    >
      <span className={cn("min-w-0 truncate", deleted && "line-through decoration-muted-foreground/60")}>{name}</span>
      {dir && <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground/70">{dir}</span>}
      {!dir && <span className="flex-1" />}
      <div className="hidden shrink-0 items-center group-hover/row:flex group-focus-within/row:flex">
        {!deleted && (
          <IconAction label="Open file" onClick={() => void openFile(file.path)}>
            <FileText />
          </IconAction>
        )}
        {kind === "changes" && (
          <IconAction label={file.status === "?" ? "Move to Trash" : "Discard changes"} disabled={!!busy} onClick={() => void discard()}>
            <Undo2 />
          </IconAction>
        )}
        {kind === "staged" ? (
          <IconAction label="Unstage" disabled={!!busy} onClick={() => void act("Couldn't unstage", () => scm.unstage([file.path]))}>
            <Minus />
          </IconAction>
        ) : (
          <IconAction label={kind === "merge" ? "Mark resolved (stage)" : "Stage"} disabled={!!busy} onClick={() => void act("Couldn't stage", () => scm.stage([file.path]))}>
            <Plus />
          </IconAction>
        )}
      </div>
      <span className={cn("w-3 shrink-0 text-center font-mono text-[11px] font-semibold", STATUS_COLOR[file.status])}>{file.status}</span>
    </div>
  )
}

// ─── History ───────────────────────────────────────────────────────────────

function History({ oid }: { oid: string | null }) {
  const [open, setOpen] = useState(false)
  const [commits, setCommits] = useState<Commit[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    scm.log().then(
      (c) => {
        setCommits(c)
        setError(null)
      },
      (err: Error) => setError(err.message),
    )
  }, [open, oid])

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-1 border-t pt-1">
      <CollapsibleTrigger className="flex h-7 w-full items-center gap-1 pl-1 text-left text-[11px] font-semibold tracking-wide text-muted-foreground uppercase hover:bg-sidebar-accent/50">
        <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
        Commits
      </CollapsibleTrigger>
      <CollapsibleContent>
        {error && <div className="px-6 py-2 text-[12px] text-destructive">{error}</div>}
        {!commits && !error && <div className="px-6 py-2 text-[12px] text-muted-foreground">Loading…</div>}
        {commits?.length === 0 && <div className="px-6 py-2 text-[12px] text-muted-foreground">No commits yet.</div>}
        {commits?.map((c) => (
          <CommitRow key={c.hash} c={c} expanded={expanded === c.hash} onToggle={() => setExpanded(expanded === c.hash ? null : c.hash)} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  )
}

function CommitRow({ c, expanded, onToggle }: { c: Commit; expanded: boolean; onToggle: () => void }) {
  const [detail, setDetail] = useState<CommitDetail | null>(null)
  const active = useKivo((s) => s.activeFile)

  useEffect(() => {
    if (!expanded || detail) return
    scm.commit(c.hash).then(setDetail, (err: Error) => toast.error("Couldn't load the commit", { description: err.message }))
  }, [expanded, detail, c.hash])

  return (
    <div>
      <button type="button" onClick={onToggle} className="flex w-full items-start gap-1.5 py-1 pr-2 pl-2 text-left hover:bg-sidebar-accent/60" title={`${c.short} · ${c.author} · ${c.date}\n${c.subject}`}>
        <ChevronRight className={cn("mt-0.5 size-3 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90")} />
        <GitCommitHorizontal className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px]">{c.subject}</span>
          <span className="block truncate text-[11px] text-muted-foreground">
            {c.author} · {c.date} · <span className="font-mono">{c.short}</span>
          </span>
        </span>
      </button>
      {expanded && (
        <div className="pb-1">
          {!detail && <div className="py-1 pl-10 text-[11.5px] text-muted-foreground">Loading…</div>}
          {detail?.files.length === 0 && <div className="py-1 pl-10 text-[11.5px] text-muted-foreground">No file changes.</div>}
          {detail?.files.map((f) => {
            const { name, dir } = splitPath(f.path)
            const tab = diffTabPath("commit", f.path, c.hash)
            return (
              <button
                type="button"
                key={f.path}
                onClick={() => openDiff("commit", f.path, c.hash)}
                className={cn("flex h-6 w-full items-center gap-1.5 pr-2 pl-10 text-left text-[12px] hover:bg-sidebar-accent/60", active === tab && "bg-sidebar-accent")}
                title={`${f.orig ? `${f.orig} → ` : ""}${f.path} — ${STATUS_LABEL[f.status] ?? f.code}`}
              >
                <span className="min-w-0 truncate">{name}</span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground/70">{dir}</span>
                <span className={cn("w-3 shrink-0 text-center font-mono text-[11px] font-semibold", STATUS_COLOR[f.status])}>{f.status}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
