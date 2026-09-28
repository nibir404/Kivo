import { useEffect, useRef, useState } from "react"
import { ArrowUp, Folder, FolderGit2, FolderOpen, GitBranch, Home, Loader2, TriangleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import { api, sse, type DirListing, type ProjectInfo } from "@/lib/api"
import { openProjectFolder, reloadCurrentProject } from "@/state/runners"
import { useKivo } from "@/state/store"
import { useUi } from "../capture"

const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform)

/** Open Folder (⌘O) and Clone Repository dialogs, mounted once in the shell. */
export function ProjectDialogs() {
  const dialog = useUi((s) => s.projectDialog)
  const setDialog = useUi((s) => s.setProjectDialog)
  const daemon = useKivo((s) => s.daemon)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((isMac ? e.metaKey : e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "o" && daemon) {
        e.preventDefault()
        setDialog("open")
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [daemon, setDialog])

  return (
    <>
      <OpenFolderDialog open={dialog === "open"} onClose={() => setDialog(null)} onClone={() => setDialog("clone")} />
      <CloneDialog open={dialog === "clone"} onClose={() => setDialog(null)} />
    </>
  )
}

function OpenFolderDialog({ open, onClose, onClone }: { open: boolean; onClose: () => void; onClone: () => void }) {
  const [listing, setListing] = useState<DirListing | null>(null)
  const [path, setPath] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [picking, setPicking] = useState(false)
  const current = useKivo((s) => s.projectInfo)

  const browse = async (to: string) => {
    setError(null)
    try {
      const l = await api.dirs(to)
      setListing(l)
      setPath(l.path)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  useEffect(() => {
    if (!open) return
    // Start next to the current project (its parent), or in the home folder.
    const start = current && current.kind !== "demo" ? current.dir.replace(/\/[^/]+$/, "") || "~" : "~"
    void browse(start)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const openPath = async (p: string) => {
    setBusy(true)
    setError(null)
    try {
      await openProjectFolder(p)
      onClose()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const native = async () => {
    setPicking(true)
    setError(null)
    try {
      const { path: picked } = await api.pickFolder()
      if (picked) await openPath(picked)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setPicking(false)
    }
  }

  const home = listing?.home
  const crumbs = listing ? crumbsOf(listing.path, home) : []

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="gap-4 sm:max-w-2xl [&>*]:min-w-0">
        <DialogHeader>
          <DialogTitle>Open a project</DialogTitle>
          <DialogDescription>Any folder on this Mac. Kivo reads and edits files there, and its terminal opens there. Nothing is copied or committed for you.</DialogDescription>
        </DialogHeader>

        {isMac && (
          <Button variant="outline" onClick={native} disabled={picking || busy} className="justify-start gap-2">
            {picking ? <Loader2 className="animate-spin" /> : <FolderOpen />}
            {picking ? "Choose a folder in the Finder window…" : "Choose with Finder…"}
          </Button>
        )}

        <div className="min-w-0 space-y-2">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              void browse(path)
            }}
          >
            <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="~/code/my-app" aria-label="Folder path" className="font-mono text-[12px]" spellCheck={false} />
            <Button type="submit" variant="outline">
              Go
            </Button>
          </form>

          <div className="flex min-w-0 items-center gap-0.5 text-[12px] text-muted-foreground">
            <Button size="icon-xs" variant="ghost" aria-label="Home folder" onClick={() => browse("~")}>
              <Home />
            </Button>
            <Button size="icon-xs" variant="ghost" aria-label="Up one folder" disabled={!listing?.parent} onClick={() => listing?.parent && browse(listing.parent)}>
              <ArrowUp />
            </Button>
            <div className="flex min-w-0 flex-1 items-center overflow-x-auto [scrollbar-width:none]">
              {crumbs.map((c, i) => (
                <span key={c.path} className="flex items-center">
                  {i > 0 && <span className="px-0.5 text-muted-foreground/50">/</span>}
                  <button className="rounded px-1 whitespace-nowrap hover:bg-accent hover:text-foreground" onClick={() => browse(c.path)}>
                    {c.label}
                  </button>
                </span>
              ))}
            </div>
          </div>

          <ScrollArea className="h-64 rounded-lg border">
            <div className="p-1">
              {listing?.dirs.length === 0 && <div className="p-3 text-[12px] text-muted-foreground">No folders here.</div>}
              {listing?.dirs.map((d) => (
                <div key={d.path} className="group flex items-center rounded-md hover:bg-accent">
                  <button className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-[13px]" onClick={() => browse(d.path)} onDoubleClick={() => openPath(d.path)} title="Click to look inside · double-click to open">
                    {d.git ? <FolderGit2 className="size-4 shrink-0 text-muted-foreground" /> : <Folder className="size-4 shrink-0 text-muted-foreground" />}
                    <span className="truncate">{d.name}</span>
                    {d.git && <span className="rounded border px-1 text-[10px] text-muted-foreground">git</span>}
                  </button>
                  <Button size="xs" variant="ghost" className="mr-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100" onClick={() => openPath(d.path)} disabled={busy}>
                    Open
                  </Button>
                </div>
              ))}
            </div>
          </ScrollArea>
        </div>

        {error && (
          <p className="flex items-start gap-2 rounded-lg border border-destructive/30 px-3 py-2 text-[12.5px] text-destructive">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            {error}
          </p>
        )}

        <DialogFooter className="items-center sm:justify-between">
          <Button variant="ghost" size="sm" onClick={onClone} className="gap-1.5 text-muted-foreground">
            <GitBranch /> Clone a repository instead
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={() => listing && openPath(listing.path)} disabled={!listing || busy || listing.path === home}>
              {busy && <Loader2 className="animate-spin" />}
              Open {listing ? listing.path.split("/").pop() || listing.path : "folder"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function crumbsOf(abs: string, home?: string) {
  const out: { label: string; path: string }[] = []
  let rest = abs
  let prefix = ""
  if (home && (abs === home || abs.startsWith(home + "/"))) {
    out.push({ label: "~", path: home })
    rest = abs.slice(home.length)
    prefix = home
  } else out.push({ label: "/", path: "/" })
  for (const seg of rest.split("/").filter(Boolean)) {
    prefix = `${prefix}/${seg}`.replace(/^\/\//, "/")
    out.push({ label: seg, path: prefix })
  }
  return out
}

type CloneEvent = { t: "start"; dest: string } | { t: "progress"; phase: string; percent: number } | { t: "log"; line: string } | { t: "error"; message: string } | { t: "done"; project: ProjectInfo }

function CloneDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [url, setUrl] = useState("")
  const [parent, setParent] = useState("")
  const [name, setName] = useState("")
  const [branch, setBranch] = useState("")
  const [state, setState] = useState<{ phase: string; percent: number; log: string[]; error?: string; running: boolean }>({ phase: "", percent: 0, log: [], running: false })
  const ac = useRef<AbortController | null>(null)
  const nameTouched = useRef(false)
  const repoInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setState({ phase: "", percent: 0, log: [], running: false })
    api
      .projects()
      .then((p) => setParent((v) => v || p.cloneRoot))
      .catch(() => {})
  }, [open])

  // Suggest the folder name from the repository, until the user edits it.
  useEffect(() => {
    if (nameTouched.current) return
    const m = url.trim().match(/([^/:]+?)(?:\.git)?\/?$/)
    setName(m ? m[1] : "")
  }, [url])

  const clone = async () => {
    const controller = new AbortController()
    ac.current = controller
    setState({ phase: "Connecting", percent: 0, log: [], running: true })
    let finished = false
    try {
      await sse<CloneEvent>(
        "/api/projects/clone",
        { url, parent, name: name || undefined, branch: branch || undefined },
        (e) => {
          if (e.t === "progress") setState((s) => ({ ...s, phase: e.phase, percent: e.percent }))
          else if (e.t === "log") setState((s) => ({ ...s, log: [...s.log, e.line].slice(-6) }))
          else if (e.t === "done") {
            finished = true
            setState((s) => ({ ...s, running: false, phase: "Done", percent: 100 }))
          }
        },
        controller.signal,
      )
      if (!finished) throw new Error("The connection to Kivo closed before the clone finished. If the folder was created, open it with Open folder.")
      await reloadCurrentProject()
      onClose()
    } catch (err) {
      if (controller.signal.aborted) setState({ phase: "", percent: 0, log: [], running: false })
      else setState((s) => ({ ...s, running: false, error: (err as Error).message }))
    } finally {
      ac.current = null
    }
  }

  const close = () => {
    ac.current?.abort()
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && close()}>
      {/* Opened from a menu, whose trigger wants focus back — put it in the repository field instead. */}
      <DialogContent
        className="gap-4 sm:max-w-lg"
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          repoInput.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>Clone a repository</DialogTitle>
          <DialogDescription>
            Uses your own git setup, so private repositories work if you're signed in (an SSH key, or <code className="font-mono text-[12px]">gh auth login</code>).
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (url.trim() && !state.running) void clone()
          }}
        >
          <label className="block space-y-1">
            <span className="text-[12px] text-muted-foreground">Repository</span>
            <Input ref={repoInput} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="owner/repo · https://github.com/owner/repo · git@github.com:owner/repo.git" className="font-mono text-[12px]" spellCheck={false} disabled={state.running} />
          </label>
          <div className="grid grid-cols-[1fr_10rem] gap-2">
            <label className="block space-y-1">
              <span className="text-[12px] text-muted-foreground">Into folder</span>
              <Input value={parent} onChange={(e) => setParent(e.target.value)} className="font-mono text-[12px]" spellCheck={false} disabled={state.running} />
            </label>
            <label className="block space-y-1">
              <span className="text-[12px] text-muted-foreground">As</span>
              <Input
                value={name}
                onChange={(e) => {
                  nameTouched.current = true
                  setName(e.target.value)
                }}
                className="font-mono text-[12px]"
                spellCheck={false}
                disabled={state.running}
              />
            </label>
          </div>
          <label className="block space-y-1">
            <span className="text-[12px] text-muted-foreground">Branch (optional)</span>
            <Input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="default branch" className="font-mono text-[12px]" spellCheck={false} disabled={state.running} />
          </label>

          {(state.running || state.log.length > 0) && (
            <div className="space-y-1.5 rounded-lg border p-3">
              <div className="flex justify-between text-[12px]">
                <span>{state.phase || "Starting"}</span>
                <span className="text-muted-foreground tabular-nums">{state.percent}%</span>
              </div>
              <Progress value={state.percent} />
              {state.log.length > 0 && <pre className="max-h-20 overflow-auto font-mono text-[10.5px] whitespace-pre-wrap text-muted-foreground">{state.log.join("\n")}</pre>}
            </div>
          )}
          {state.error && (
            <p className="flex items-start gap-2 rounded-lg border border-destructive/30 px-3 py-2 text-[12.5px] text-destructive">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
              {state.error}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              {state.running ? "Cancel clone" : "Cancel"}
            </Button>
            <Button type="submit" disabled={!url.trim() || state.running}>
              {state.running && <Loader2 className="animate-spin" />}
              Clone and open
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Recent projects for menus: the current one first, then by last opened. */
export function useRecentProjects(open: boolean) {
  const [list, setList] = useState<ProjectInfo[]>([])
  const daemon = useKivo((s) => s.daemon)
  const current = useKivo((s) => s.projectInfo?.id)
  useEffect(() => {
    if (!open || !daemon) return
    api
      .projects()
      .then((p) => setList(p.projects))
      .catch(() => setList([]))
  }, [open, daemon, current])
  return [list, setList] as const
}

export const shortPath = (dir: string, home?: string) => (home && dir.startsWith(home) ? "~" + dir.slice(home.length) : dir.replace(/^\/Users\/[^/]+/, "~"))
