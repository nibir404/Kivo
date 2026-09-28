import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react"
import { ChevronRight, ChevronsDownUp, Copy, CopyPlus, FileCode2, FilePlus, Folder, FolderOpen, FolderPlus, Pencil, RefreshCw, SquareTerminal, Trash } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut, ContextMenuTrigger } from "@/components/ui/context-menu"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { openFile } from "@/state/runners"
import { useKivo } from "@/state/store"
import { baseName, checkName, copyPath, createIn, duplicate, join, openInTerminal, parentOf, renameTo, reveal, trash } from "./fileOps"
import { under, useEditor } from "./store"
import { isDirty, refreshTree } from "./tabs"
import { inBrowser } from "@/lib/transport"

/**
 * The Code-mode explorer: the project's files as a tree, with the file operations of a desktop
 * editor — new file/folder, rename/move (inline, or drag onto a folder), duplicate, delete to the
 * Trash (confirmed), copy path, reveal in Finder, open a terminal there.
 */

interface Node {
  name: string
  path: string
  dir: boolean
  children: Node[]
}

function buildTree(files: string[], dirs: string[]): Node {
  const root: Node = { name: "", path: "", dir: true, children: [] }
  const index = new Map<string, Node>([["", root]])
  const ensure = (path: string, dir: boolean): Node => {
    const hit = index.get(path)
    if (hit) return hit
    const parent = ensure(parentOf(path), true)
    const node: Node = { name: baseName(path), path, dir, children: [] }
    parent.children.push(node)
    index.set(path, node)
    return node
  }
  for (const d of dirs) ensure(d, true)
  for (const f of files) ensure(f, false)
  const sort = (n: Node) => {
    n.children.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }))
    n.children.forEach(sort)
  }
  sort(root)
  return root
}

/** The folder a "new file" lands in: the selected folder, else the selected file's folder, else the root. */
function targetDir(selected: string | null, files: string[]) {
  if (!selected) return ""
  return files.includes(selected) ? parentOf(selected) : selected
}

const DeleteCtx = createContext<(path: string, dir: boolean) => void>(() => {})

export function Explorer() {
  const files = useKivo((s) => s.files)
  const daemon = useKivo((s) => s.daemon)
  const activeFile = useKivo((s) => s.activeFile)
  const emptyDirs = useEditor((s) => s.emptyDirs)
  const edit = useEditor((s) => s.edit)
  const tree = useMemo(() => buildTree(files, emptyDirs), [files, emptyDirs])
  const [confirm, setConfirm] = useState<{ path: string; dir: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [dropRoot, setDropRoot] = useState(false)

  // Follow the active editor: open its folders so the file is visible, like VS Code's auto-reveal.
  useEffect(() => {
    if (!activeFile || activeFile.includes("://")) return
    useEditor.getState().expandTo(activeFile)
    requestAnimationFrame(() => document.querySelector(`[data-tree-path="${CSS.escape(activeFile)}"]`)?.scrollIntoView({ block: "nearest" }))
  }, [activeFile])

  const startNew = (kind: "new-file" | "new-folder", dir?: string) => {
    const ed = useEditor.getState()
    const d = dir ?? targetDir(ed.selected, files)
    if (d) ed.setExpanded(d, true)
    ed.setEdit({ kind, dir: d })
  }

  const refresh = async () => {
    setBusy(true)
    await refreshTree()
    setBusy(false)
  }

  const dirtyInside = confirm ? useKivo.getState().openFiles.filter((p) => under(p, confirm.path) && isDirty(p)) : []

  return (
    <DeleteCtx.Provider value={(path, dir) => setConfirm({ path, dir })}>
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex h-8 shrink-0 items-center gap-0.5 pr-1.5 pl-3">
          <span className="flex-1 truncate text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            Explorer <span className="normal-case">· {files.length} files</span>
          </span>
          <ToolButton label="New file" onClick={() => startNew("new-file")} disabled={!daemon}>
            <FilePlus />
          </ToolButton>
          <ToolButton label="New folder" onClick={() => startNew("new-folder")} disabled={!daemon}>
            <FolderPlus />
          </ToolButton>
          <ToolButton label="Refresh" onClick={refresh} disabled={!daemon}>
            <RefreshCw className={cn(busy && "animate-spin")} />
          </ToolButton>
          <ToolButton label="Collapse folders" onClick={() => useEditor.getState().collapseAll()}>
            <ChevronsDownUp />
          </ToolButton>
        </div>
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div
              className={cn("min-h-0 flex-1 overflow-auto pb-6 font-mono text-[12px]", dropRoot && "bg-accent/40")}
              onClick={(e) => e.target === e.currentTarget && useEditor.getState().select(null)}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes("application/x-kivo-path")) return
                e.preventDefault()
                setDropRoot(e.target === e.currentTarget)
              }}
              onDragLeave={() => setDropRoot(false)}
              onDrop={(e) => {
                setDropRoot(false)
                const src = e.dataTransfer.getData("application/x-kivo-path")
                if (src && e.target === e.currentTarget && parentOf(src) !== "") void renameTo(src, baseName(src))
              }}
            >
              {edit && edit.kind !== "rename" && edit.dir === "" && <NewEntry kind={edit.kind} dir="" depth={0} />}
              {tree.children.map((n) => (
                <TreeRow key={n.path} node={n} depth={0} />
              ))}
              {!files.length && <div className="px-4 py-3 font-sans text-[12px] text-muted-foreground">{daemon ? "This folder is empty." : "Connect the daemon to browse files."}</div>}
            </div>
          </ContextMenuTrigger>
          {/* No focus restore on close: it would blur (and so commit) the inline name input at once. */}
          <ContextMenuContent className="w-52" onCloseAutoFocus={(e) => e.preventDefault()}>
            <ContextMenuItem onSelect={() => startNew("new-file", "")}>
              <FilePlus /> New File…
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => startNew("new-folder", "")}>
              <FolderPlus /> New Folder…
            </ContextMenuItem>
            {!inBrowser && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => reveal("")}>
                  <FolderOpen /> Reveal Project in Finder
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => openInTerminal("")}>
                  <SquareTerminal /> Open in Terminal
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => copyPath("", true)}>
                  <Copy /> Copy Project Path
                </ContextMenuItem>
              </>
            )}
          </ContextMenuContent>
        </ContextMenu>
      </div>

      <Dialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {confirm ? `“${baseName(confirm.path)}”` : ""}?</DialogTitle>
            <DialogDescription>
              {inBrowser
                ? `${confirm?.dir ? "The folder and everything in it" : "The file"} will be deleted permanently — a browser can't move files to the Trash.`
                : `${confirm?.dir ? "The folder and everything in it" : "The file"} will be moved to the Trash. You can restore it from there.`}
              {dirtyInside.length > 0 && ` Unsaved changes in ${dirtyInside.length === 1 ? baseName(dirtyInside[0]) : `${dirtyInside.length} open files`} will be lost.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              autoFocus
              onClick={() => {
                const c = confirm
                setConfirm(null)
                if (c) void trash(c.path)
              }}
            >
              <Trash /> {inBrowser ? "Delete" : "Move to Trash"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DeleteCtx.Provider>
  )
}

function ToolButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label={label} onClick={onClick} disabled={disabled} className="text-muted-foreground">
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/** Arrow keys walk the visible rows, like a native tree. */
function moveFocus(from: HTMLElement, delta: number) {
  const rows = [...document.querySelectorAll<HTMLElement>("[data-tree-row]")]
  rows[rows.indexOf(from) + delta]?.focus()
}

function TreeRow({ node, depth }: { node: Node; depth: number }) {
  const active = useKivo((s) => s.mode === "code" && s.activeFile === node.path)
  const dirty = useKivo((s) => !node.dir && !!s.fileCache[node.path] && s.fileCache[node.path].content !== s.fileCache[node.path].saved)
  const stored = useEditor((s) => s.expanded[node.path])
  const selected = useEditor((s) => s.selected === node.path)
  const edit = useEditor((s) => s.edit)
  const askDelete = useContext(DeleteCtx)
  const [dropHere, setDropHere] = useState(false)
  const open = node.dir && !!stored
  const renaming = edit?.kind === "rename" && edit.path === node.path
  const pad = 8 + depth * 12
  const dirOf = node.dir ? node.path : parentOf(node.path)
  const ed = useEditor.getState

  const activate = () => {
    ed().select(node.path)
    if (node.dir) ed().setExpanded(node.path, !open)
    else void openFile(node.path)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key === "F2") {
      e.preventDefault()
      ed().setEdit({ kind: "rename", path: node.path })
    } else if (e.key === "Delete" || (e.key === "Backspace" && e.metaKey)) {
      e.preventDefault()
      askDelete(node.path, node.dir)
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      moveFocus(e.currentTarget, e.key === "ArrowDown" ? 1 : -1)
    } else if (e.key === "ArrowRight" && node.dir && !open) ed().setExpanded(node.path, true)
    else if (e.key === "ArrowLeft" && node.dir && open) ed().setExpanded(node.path, false)
  }

  const Icon = node.dir ? (open ? FolderOpen : Folder) : FileCode2

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          {renaming ? (
            <div className="flex items-center gap-1 py-px pr-2" style={{ paddingLeft: pad + (node.dir ? 0 : 16) }}>
              {node.dir && <ChevronRight className="size-3 shrink-0 text-muted-foreground" />}
              <Icon className="size-3 shrink-0 text-muted-foreground" />
              <NameInput
                initial={node.name}
                selectStem={!node.dir}
                onSubmit={async (name) => {
                  ed().setEdit(null)
                  // A name with slashes moves the entry, relative to its current folder.
                  if (name !== node.name) await renameTo(node.path, join(parentOf(node.path), name))
                }}
                onCancel={() => ed().setEdit(null)}
              />
            </div>
          ) : (
            <button
              data-tree-row
              data-tree-path={node.path}
              data-active={active || undefined}
              data-selected={selected || undefined}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData("application/x-kivo-path", node.path)
                e.dataTransfer.effectAllowed = "move"
              }}
              onDragOver={(e) => {
                if (!node.dir || !e.dataTransfer.types.includes("application/x-kivo-path")) return
                e.preventDefault()
                e.stopPropagation()
                setDropHere(true)
              }}
              onDragLeave={() => setDropHere(false)}
              onDrop={(e) => {
                setDropHere(false)
                if (!node.dir) return
                e.preventDefault()
                e.stopPropagation()
                const src = e.dataTransfer.getData("application/x-kivo-path")
                if (!src || src === node.path || under(node.path, src) || parentOf(src) === node.path) return
                ed().setExpanded(node.path, true)
                void renameTo(src, join(node.path, baseName(src)))
              }}
              className={cn(
                "flex w-full items-center gap-1 rounded-md py-0.5 pr-2 text-left text-foreground/80 outline-none hover:bg-accent/60 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring data-active:bg-accent data-active:text-foreground data-selected:bg-accent/70",
                dropHere && "bg-accent ring-1 ring-ring",
              )}
              style={{ paddingLeft: pad + (node.dir ? 0 : 16) }}
              onClick={activate}
              onKeyDown={onKeyDown}
              onContextMenu={() => ed().select(node.path)}
              title={node.path}
            >
              {node.dir && <ChevronRight className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />}
              <Icon className="size-3 shrink-0 text-muted-foreground" />
              <span className={cn("truncate", dirty && "italic")}>{node.name}</span>
              {dirty && <span className="ml-auto size-1.5 shrink-0 rounded-full bg-foreground/70" aria-label="unsaved" />}
            </button>
          )}
        </ContextMenuTrigger>
        <ContextMenuContent className="w-56" onCloseAutoFocus={(e) => e.preventDefault()}>
          {!node.dir && <ContextMenuItem onSelect={() => void openFile(node.path)}>Open</ContextMenuItem>}
          <ContextMenuItem onSelect={() => (ed().setExpanded(dirOf, true), ed().setEdit({ kind: "new-file", dir: dirOf }))}>
            <FilePlus /> New File…
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => (ed().setExpanded(dirOf, true), ed().setEdit({ kind: "new-folder", dir: dirOf }))}>
            <FolderPlus /> New Folder…
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => ed().setEdit({ kind: "rename", path: node.path })}>
            <Pencil /> Rename… <ContextMenuShortcut>F2</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => void duplicate(node.path)}>
            <CopyPlus /> Duplicate
          </ContextMenuItem>
          <ContextMenuItem variant="destructive" onSelect={() => askDelete(node.path, node.dir)}>
            <Trash /> Delete <ContextMenuShortcut>⌘⌫</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => copyPath(node.path, true)}>
            <Copy /> Copy Path
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => copyPath(node.path, false)}>
            <Copy /> Copy Relative Path
          </ContextMenuItem>
          {!inBrowser && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => reveal(node.path)}>
                <FolderOpen /> Reveal in Finder
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => openInTerminal(dirOf)}>
                <SquareTerminal /> Open in Terminal
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
      {open && (
        <>
          {edit && edit.kind !== "rename" && edit.dir === node.path && <NewEntry kind={edit.kind} dir={node.path} depth={depth + 1} />}
          {node.children.map((c) => (
            <TreeRow key={c.path} node={c} depth={depth + 1} />
          ))}
        </>
      )}
    </div>
  )
}

function NewEntry({ kind, dir, depth }: { kind: "new-file" | "new-folder"; dir: string; depth: number }) {
  const folder = kind === "new-folder"
  const Icon = folder ? Folder : FileCode2
  return (
    <div className="flex items-center gap-1 py-px pr-2" style={{ paddingLeft: 8 + depth * 12 + (folder ? 0 : 16) }}>
      {folder && <ChevronRight className="size-3 shrink-0 text-muted-foreground" />}
      <Icon className="size-3 shrink-0 text-muted-foreground" />
      <NameInput
        initial=""
        onSubmit={async (name) => {
          useEditor.getState().setEdit(null)
          await createIn(dir, name, folder ? "folder" : "file")
        }}
        onCancel={() => useEditor.getState().setEdit(null)}
      />
    </div>
  )
}

/** Inline name field: Enter commits, Esc cancels, clicking away commits a non-empty name (as VS Code does). */
function NameInput({ initial, selectStem, onSubmit, onCancel }: { initial: string; selectStem?: boolean; onSubmit: (name: string) => void; onCancel: () => void }) {
  const ref = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(initial)
  const done = useRef(false)
  const error = value && value !== initial ? checkName(value) : null

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const dot = initial.lastIndexOf(".")
    const focus = () => {
      if (document.activeElement === el) return
      el.focus()
      el.setSelectionRange(0, selectStem && dot > 0 ? dot : initial.length)
    }
    focus()
    // Opened from a context menu, whose focus trap holds focus until its exit animation ends.
    const timers = [50, 150, 300].map((ms) => setTimeout(focus, ms))
    return () => timers.forEach(clearTimeout)
  }, [initial, selectStem])

  const commit = () => {
    if (done.current) return
    const v = value.trim()
    if (!v || v === initial) {
      done.current = true
      return onCancel()
    }
    if (checkName(v)) return
    done.current = true
    onSubmit(v)
  }

  return (
    <div className="relative min-w-0 flex-1">
      <input
        ref={ref}
        value={value}
        spellCheck={false}
        aria-invalid={!!error || undefined}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === "Enter") commit()
          if (e.key === "Escape") {
            done.current = true
            onCancel()
          }
        }}
        onBlur={(e) => {
          // Focus pulled back by the closing menu isn't the user clicking away.
          if ((e.relatedTarget as Element | null)?.closest('[role="menu"]')) return
          commit()
        }}
        className="h-5 w-full rounded-sm border border-ring bg-background px-1 font-mono text-[12px] outline-none aria-invalid:border-destructive"
      />
      {error && <div className="absolute top-full right-0 left-0 z-10 rounded-b-sm bg-destructive px-1.5 py-0.5 font-sans text-[11px] text-white">{error}</div>}
    </div>
  )
}
