import { useEffect, useRef, useState } from "react"
import { create } from "zustand"
import { CaseSensitive, ChevronRight, ChevronsDownUp, Ellipsis, FileCode2, Loader2, Regex, Replace, ReplaceAll, WholeWord, X } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { isDiffTab } from "@/features/scm/DiffView"
import { editorApi, type SearchHit, type SearchParams, type SearchResult } from "@/lib/editor-api"
import { cn } from "@/lib/utils"
import { useKivo } from "@/state/store"
import { baseName, parentOf } from "./fileOps"
import { buildMatcher, findInText, globFilter, previewHit, replaceInText, splitLines } from "@kivo/core/match"
import { useEditor } from "./store"
import { isDirty, openAt, syncOpenFiles } from "./tabs"

/**
 * Find in files (⌘⇧F) with replace. The daemon searches the disk; files with unsaved edits are
 * searched in their editor buffers instead, so results always match what the user sees. Replace
 * writes clean files on disk and applies the change to unsaved buffers in the editor (left
 * unsaved, for the user to review and save).
 */

interface Query {
  query: string
  replace: string
  regex: boolean
  caseSensitive: boolean
  wholeWord: boolean
  include: string
  exclude: string
  showReplace: boolean
  showFilters: boolean
}

interface SearchState extends Query {
  set: (p: Partial<Query>) => void
  result: SearchResult | null
  error: string | null
  loading: boolean
  collapsed: Record<string, boolean>
}

/** Module-level so the query and results survive switching sidebar views. */
const useSearch = create<SearchState>((set) => ({
  query: "",
  replace: "",
  regex: false,
  caseSensitive: false,
  wholeWord: false,
  include: "",
  exclude: "",
  showReplace: false,
  showFilters: false,
  set: (p) => set(p),
  result: null,
  error: null,
  loading: false,
  collapsed: {},
}))

const params = (q: Query): SearchParams => ({ query: q.query, regex: q.regex, caseSensitive: q.caseSensitive, wholeWord: q.wholeWord, include: q.include || undefined, exclude: q.exclude || undefined })

/** Open files with unsaved edits that the filters allow — these are searched/replaced in memory. */
function dirtyBuffers(q: Query) {
  const inc = globFilter(q.include)
  const exc = globFilter(q.exclude)
  return useKivo
    .getState()
    .openFiles.filter((p) => !isDiffTab(p) && isDirty(p) && (!inc || inc(p)) && !(exc && exc(p)))
}

function bufferHits(re: RegExp, text: string): SearchHit[] {
  const lines = splitLines(text)
  return findInText(re, text).map((m) => previewHit(lines[m.line - 1].text, m.line, m.col, m.len))
}

let controller: AbortController | null = null

async function runSearch() {
  const q = useSearch.getState()
  controller?.abort()
  if (!q.query) return useSearch.setState({ result: null, error: null, loading: false })
  let re: RegExp
  try {
    re = buildMatcher(q)
  } catch (err) {
    return useSearch.setState({ error: (err as Error).message, result: null, loading: false })
  }
  const ac = (controller = new AbortController())
  useSearch.setState({ loading: true, error: null })
  try {
    const r = await editorApi.search({ ...params(q), maxResults: 2000 }, ac.signal)
    if (ac.signal.aborted) return
    // Overlay unsaved buffers: their in-editor text is what the user expects to be searched.
    const cache = useKivo.getState().fileCache
    for (const p of dirtyBuffers(q)) {
      const matches = bufferHits(re, cache[p].content)
      const i = r.files.findIndex((f) => f.path === p)
      r.total += matches.length - (i >= 0 ? r.files[i].matches.length : 0)
      if (i >= 0) r.files.splice(i, 1)
      if (matches.length) r.files.splice(i >= 0 ? i : r.files.length, 0, { path: p, matches })
    }
    useSearch.setState({ result: r, loading: false })
  } catch (err) {
    if (ac.signal.aborted) return
    useSearch.setState({ error: (err as Error).message, result: null, loading: false })
  }
}

/** Apply the replacement to unsaved buffers (for the given files, or all dirty ones that match). */
function replaceInBuffers(q: Query, only?: string[]) {
  const re = buildMatcher(q)
  let count = 0
  for (const p of only ?? dirtyBuffers(q)) {
    const f = useKivo.getState().fileCache[p]
    if (!f) continue
    const next = replaceInText(re, f.content, q.replace, q.regex)
    if (!next.count) continue
    useKivo.getState().editFile(p, next.text)
    count += next.count
  }
  return count
}

export function SearchPanel() {
  const s = useSearch()
  const daemon = useKivo((st) => st.daemon)
  const focusTick = useEditor((st) => st.searchFocusTick)
  const input = useRef<HTMLTextAreaElement>(null)
  const [confirm, setConfirm] = useState<{ files: number; total: number; buffers: number } | null>(null)
  const [replacing, setReplacing] = useState(false)

  // ⌘⇧F: focus the field, seeded with the editor selection when there is one.
  useEffect(() => {
    const seed = useEditor.getState().searchSeed
    if (seed) {
      useSearch.setState({ query: seed })
      useEditor.setState({ searchSeed: null })
    }
    // After the click that opened the view has finished moving focus (to its button / tooltip).
    const t = setTimeout(() => {
      input.current?.focus()
      input.current?.select()
    }, 30)
    return () => clearTimeout(t)
  }, [focusTick])

  // Search as you type (debounced), and again whenever an option or filter changes.
  useEffect(() => {
    const t = setTimeout(runSearch, 250)
    return () => clearTimeout(t)
  }, [s.query, s.regex, s.caseSensitive, s.wholeWord, s.include, s.exclude])

  const askReplaceAll = async () => {
    if (!s.query) return
    try {
      const buffers = dirtyBuffers(s)
      const dry = await editorApi.replace({ ...params(s), replace: s.replace, skip: buffers, dryRun: true })
      const re = buildMatcher(s)
      const inBuffers = buffers.reduce((n, p) => n + findInText(re, useKivo.getState().fileCache[p].content).length, 0)
      const files = dry.files.length + buffers.filter((p) => findInText(re, useKivo.getState().fileCache[p].content).length).length
      if (!dry.total && !inBuffers) return toast("Nothing to replace")
      setConfirm({ files, total: dry.total + inBuffers, buffers: inBuffers })
    } catch (err) {
      toast.error("Couldn't prepare the replacement", { description: (err as Error).message })
    }
  }

  const replaceAll = async () => {
    setConfirm(null)
    setReplacing(true)
    try {
      const buffers = dirtyBuffers(s)
      const r = await editorApi.replace({ ...params(s), replace: s.replace, skip: buffers })
      const inBuffers = replaceInBuffers(s, buffers)
      await syncOpenFiles(r.files.map((f) => f.path))
      toast.success(`Replaced ${r.total + inBuffers} occurrence${r.total + inBuffers === 1 ? "" : "s"}`, {
        description: inBuffers ? `${inBuffers} in unsaved editors — review and save them.` : undefined,
      })
    } catch (err) {
      toast.error("Replace failed", { description: (err as Error).message })
    }
    setReplacing(false)
    void runSearch()
  }

  const replaceFile = async (path: string) => {
    try {
      let n: number
      if (isDirty(path)) n = replaceInBuffers(s, [path])
      else {
        n = (await editorApi.replace({ ...params(s), replace: s.replace, paths: [path] })).total
        await syncOpenFiles([path])
      }
      toast.success(`Replaced ${n} in ${baseName(path)}`)
    } catch (err) {
      toast.error("Replace failed", { description: (err as Error).message })
    }
    void runSearch()
  }

  const r = s.result
  const allCollapsed = !!r?.files.length && r.files.every((f) => s.collapsed[f.path])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-0.5 pr-1.5 pl-3">
        <span className="flex-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Search</span>
        <IconToggle label={allCollapsed ? "Expand all" : "Collapse all"} onClick={() => useSearch.setState({ collapsed: allCollapsed ? {} : Object.fromEntries((r?.files ?? []).map((f) => [f.path, true])) })}>
          <ChevronsDownUp />
        </IconToggle>
        <IconToggle label="Clear results" onClick={() => useSearch.setState({ query: "", replace: "", result: null, error: null })}>
          <X />
        </IconToggle>
      </div>
      <div className="space-y-1.5 px-2 pb-2">
        <div className="flex gap-1">
          <IconToggle label="Toggle replace" onClick={() => s.set({ showReplace: !s.showReplace })} className="h-auto self-stretch">
            <ChevronRight className={cn("transition-transform", s.showReplace && "rotate-90")} />
          </IconToggle>
          <div className="min-w-0 flex-1 space-y-1.5">
            <Field
              inputRef={input}
              value={s.query}
              onChange={(query) => s.set({ query })}
              placeholder="Search"
              onEnter={runSearch}
              addons={
                <>
                  <OptToggle label="Match case" on={s.caseSensitive} onClick={() => s.set({ caseSensitive: !s.caseSensitive })}>
                    <CaseSensitive />
                  </OptToggle>
                  <OptToggle label="Match whole word" on={s.wholeWord} onClick={() => s.set({ wholeWord: !s.wholeWord })}>
                    <WholeWord />
                  </OptToggle>
                  <OptToggle label="Use regular expression" on={s.regex} onClick={() => s.set({ regex: !s.regex })}>
                    <Regex />
                  </OptToggle>
                </>
              }
            />
            {s.showReplace && (
              <Field
                value={s.replace}
                onChange={(replace) => s.set({ replace })}
                placeholder={s.regex ? "Replace ($1 for groups)" : "Replace"}
                onEnter={askReplaceAll}
                addons={
                  <OptToggle label="Replace all" on={false} onClick={askReplaceAll} disabled={!r?.total || replacing || !daemon}>
                    {replacing ? <Loader2 className="animate-spin" /> : <ReplaceAll />}
                  </OptToggle>
                }
              />
            )}
          </div>
        </div>
        <div className="flex justify-end">
          <button className="flex items-center rounded px-1 text-muted-foreground hover:text-foreground" aria-label="Toggle file filters" onClick={() => s.set({ showFilters: !s.showFilters })}>
            <Ellipsis className="size-3.5" />
          </button>
        </div>
        {s.showFilters && (
          <div className="space-y-1.5">
            <label className="block space-y-0.5">
              <span className="text-[11px] text-muted-foreground">files to include</span>
              <Field value={s.include} onChange={(include) => s.set({ include })} placeholder="e.g. *.py, src/**" onEnter={runSearch} />
            </label>
            <label className="block space-y-0.5">
              <span className="text-[11px] text-muted-foreground">files to exclude</span>
              <Field value={s.exclude} onChange={(exclude) => s.set({ exclude })} placeholder="e.g. tests, *.min.js" onEnter={runSearch} />
            </label>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto pb-6">
        {s.error && <div className="mx-2 rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1.5 text-[12px] text-destructive">{s.error}</div>}
        {!s.error && r && (
          <div className="flex items-center gap-2 px-3 pb-1 text-[11px] text-muted-foreground">
            {s.loading && <Loader2 className="size-3 animate-spin" />}
            {r.total ? `${r.total}${r.truncated ? "+" : ""} result${r.total === 1 ? "" : "s"} in ${r.files.length} file${r.files.length === 1 ? "" : "s"}` : "No results found"}
            {r.truncated && <span className="text-warning">· showing the first {r.total}, refine the search</span>}
          </div>
        )}
        {!r && s.loading && <Loader2 className="mx-3 size-3 animate-spin text-muted-foreground" />}
        {!s.query && !r && <p className="px-3 text-[12px] text-muted-foreground">Search every file in the project. ⌘⇧F from anywhere.</p>}
        {r?.files.map((f) => (
          <FileGroup key={f.path} path={f.path} matches={f.matches} collapsed={!!s.collapsed[f.path]} replacement={s.showReplace ? s.replace : null} onReplace={() => replaceFile(f.path)} />
        ))}
      </div>

      <Dialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Replace all?</DialogTitle>
            <DialogDescription>
              Replace {confirm?.total} occurrence{confirm?.total === 1 ? "" : "s"} across {confirm?.files} file{confirm?.files === 1 ? "" : "s"} with “{s.replace}”.
              {confirm && confirm.buffers > 0 && ` ${confirm.buffers} of them are in files with unsaved changes; those are changed in the editor and left for you to save.`} Files on disk are written
              immediately.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button autoFocus onClick={replaceAll}>
              <ReplaceAll /> Replace
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function FileGroup({ path, matches, collapsed, replacement, onReplace }: { path: string; matches: SearchHit[]; collapsed: boolean; replacement: string | null; onReplace: () => void }) {
  const dirty = useKivo((st) => isDirty(path) && !!st.fileCache[path])
  const toggle = () => useSearch.setState((st) => ({ collapsed: { ...st.collapsed, [path]: !collapsed } }))
  return (
    <div>
      <div className="group flex items-center gap-1 py-0.5 pr-1.5 pl-2 hover:bg-accent/60">
        <button className="flex min-w-0 flex-1 items-center gap-1 text-left" onClick={toggle} title={path}>
          <ChevronRight className={cn("size-3 shrink-0 text-muted-foreground transition-transform", !collapsed && "rotate-90")} />
          <FileCode2 className="size-3 shrink-0 text-muted-foreground" />
          <span className="truncate font-mono text-[12px]">{baseName(path)}</span>
          <span className="min-w-0 truncate text-[11px] text-muted-foreground">{parentOf(path)}</span>
          {dirty && <span className="size-1.5 shrink-0 rounded-full bg-foreground/70" title="Unsaved — searched in the editor" />}
        </button>
        {replacement !== null && (
          <IconToggle label={`Replace in ${baseName(path)}`} onClick={onReplace} className="hidden group-hover:flex">
            <Replace />
          </IconToggle>
        )}
        <span className="rounded-full bg-muted px-1.5 font-mono text-[10px] text-muted-foreground">{matches.length}</span>
      </div>
      {!collapsed &&
        matches.map((m, i) => (
          <button
            key={`${m.line}:${m.col}:${i}`}
            className="flex w-full items-baseline gap-2 py-px pr-2 pl-9 text-left font-mono text-[11.5px] text-foreground/80 hover:bg-accent/60 hover:text-foreground"
            onClick={() => openAt(path, m.line, m.col, m.len)}
            title={`Line ${m.line}`}
          >
            <span className="min-w-0 flex-1 truncate whitespace-pre">
              {m.before}
              <span className={cn("rounded-[2px]", replacement ? "bg-destructive/20 line-through decoration-destructive/70" : "bg-warning/35 text-foreground")}>{m.text}</span>
              {replacement ? <span className="rounded-[2px] bg-success/25 text-foreground">{replacement}</span> : null}
              {m.after}
            </span>
            <span className="shrink-0 text-[10px] text-muted-foreground">{m.line}</span>
          </button>
        ))}
    </div>
  )
}

function Field({
  value,
  onChange,
  placeholder,
  onEnter,
  addons,
  inputRef,
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
  onEnter?: () => void
  addons?: React.ReactNode
  inputRef?: React.Ref<HTMLTextAreaElement>
}) {
  return (
    <div className="flex items-start rounded-md border bg-background focus-within:border-ring focus-within:ring-1 focus-within:ring-ring/40">
      <textarea
        ref={inputRef}
        rows={1}
        value={value}
        spellCheck={false}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault()
            onEnter?.()
          }
        }}
        className="min-h-6 min-w-0 flex-1 resize-none bg-transparent px-1.5 py-1 font-mono text-[12px] leading-4 outline-none placeholder:font-sans placeholder:text-muted-foreground"
      />
      {addons && <div className="flex shrink-0 items-center gap-px p-0.5">{addons}</div>}
    </div>
  )
}

function OptToggle({ label, on, onClick, disabled, children }: { label: string; on: boolean; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-label={label}
          aria-pressed={on}
          disabled={disabled}
          onClick={onClick}
          className="flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40 aria-pressed:bg-info/20 aria-pressed:text-foreground aria-pressed:ring-1 aria-pressed:ring-info/60 [&_svg]:size-3.5"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function IconToggle({ label, onClick, className, children }: { label: string; onClick: () => void; className?: string; children: React.ReactNode }) {
  return (
    <Button variant="ghost" size="icon-xs" aria-label={label} title={label} onClick={onClick} className={cn("text-muted-foreground", className)}>
      {children}
    </Button>
  )
}
