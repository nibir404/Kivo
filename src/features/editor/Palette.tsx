import { useMemo, useState } from "react"
import { AtSign, Box, Braces, FileCode2, Hash, Heading, KeyRound, SquareFunction, Type, Variable } from "lucide-react"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { isDiffTab } from "@/features/scm/DiffView"
import { useKivo } from "@/state/store"
import { baseName, parentOf } from "./fileOps"
import { scorePath, scoreText } from "./fuzzy"
import { useEditor, type Palette as Mode } from "./store"
import { symbolsOf, type SymbolInfo } from "./symbols"
import { openAt } from "./tabs"

/**
 * One palette, three modes, as in VS Code: Quick Open (⌘P) finds files, ":" goes to a line
 * (⌃G), "@" goes to a symbol in the current file (⌘⇧O). Typing the prefix switches mode, and
 * "file:42" in Quick Open opens a file at a line.
 */

const PREFIX: Record<Exclude<Mode, null>, string> = { files: "", line: ":", symbol: "@" }
const MAX = 60

const KIND_ICON: Record<SymbolInfo["kind"], typeof Box> = {
  class: Box,
  function: SquareFunction,
  method: SquareFunction,
  type: Type,
  variable: Variable,
  heading: Heading,
  key: KeyRound,
  selector: Braces,
}

function Highlight({ text, hits, offset = 0 }: { text: string; hits: number[]; offset?: number }) {
  if (!hits.length) return <>{text}</>
  const set = new Set(hits.map((h) => h - offset))
  return (
    <>
      {[...text].map((c, i) =>
        set.has(i) ? (
          <span key={i} className="font-semibold text-foreground">
            {c}
          </span>
        ) : (
          c
        ),
      )}
    </>
  )
}

export function Palette() {
  const mode = useEditor((s) => s.palette)
  const setPalette = useEditor((s) => s.setPalette)
  // Opening in a mode starts the input with that mode's prefix, like VS Code (remounted per mode).
  const [q, setQ] = useState(() => (mode ? PREFIX[mode] : ""))

  const current = q.startsWith(":") ? "line" : q.startsWith("@") ? "symbol" : "files"
  const close = () => setPalette(null)

  return (
    <Dialog open={!!mode} onOpenChange={(o) => !o && close()}>
      <DialogHeader className="sr-only">
        <DialogTitle>{current === "files" ? "Go to file" : current === "line" ? "Go to line" : "Go to symbol"}</DialogTitle>
        <DialogDescription>Type a file name, “:” and a line number, or “@” and a symbol.</DialogDescription>
      </DialogHeader>
      <DialogContent className="top-[12%] translate-y-0 overflow-hidden rounded-xl! p-0 sm:max-w-xl" showCloseButton={false}>
        <Command shouldFilter={false} loop className="rounded-xl!">
          <CommandInput value={q} onValueChange={setQ} placeholder={current === "files" ? "Search files by name (append :line to jump)" : current === "line" ? "Line number, optionally :column" : "Symbol in this file"} />
          <CommandList className="max-h-[min(60vh,420px)]">
            {current === "files" && <FileResults query={q} onDone={close} />}
            {current === "line" && <LineResult query={q.slice(1)} onDone={close} />}
            {current === "symbol" && <SymbolResults query={q.slice(1)} onDone={close} />}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  )
}

function FileResults({ query, onDone }: { query: string; onDone: () => void }) {
  const files = useKivo((s) => s.files)
  const openFiles = useKivo((s) => s.openFiles)
  const recent = useEditor((s) => s.recent)
  // "router.py:42" or "router.py:42:7" jumps to a position.
  const m = /^(.*?)(?::(\d+)(?::(\d+))?)?$/.exec(query.trim())!
  const name = m[1]
  const line = m[2] ? Number(m[2]) : undefined
  const col = m[3] ? Number(m[3]) - 1 : 0

  const results = useMemo(() => {
    const known = new Set(files)
    const rank = new Map<string, number>()
    const order = [...recent, ...openFiles].filter((p) => known.has(p))
    order.forEach((p, i) => rank.has(p) || rank.set(p, i))
    if (!name) return { recent: [...new Set(order)].slice(0, 20).map((p) => ({ path: p, hits: [] as number[] })), rest: [] }
    const scored: { path: string; score: number; hits: number[] }[] = []
    for (const p of files) {
      const s = scorePath(name, p)
      if (!s) continue
      // Recently used files float up, but a much better name match still wins.
      const r = rank.get(p)
      scored.push({ path: p, score: s.score + (r === undefined ? 0 : 25 - Math.min(20, r)), hits: s.hits })
    }
    scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length)
    return { recent: [], rest: scored.slice(0, MAX) }
  }, [files, openFiles, recent, name])

  const go = (path: string) => {
    onDone()
    void openAt(path, line ?? 0, col)
  }

  const item = (r: { path: string; hits: number[] }) => {
    const slash = r.path.lastIndexOf("/") + 1
    return (
      <CommandItem key={r.path} value={r.path} onSelect={() => go(r.path)} className="gap-2">
        <FileCode2 className="text-muted-foreground" />
        <span className="shrink-0 font-mono text-[12.5px] text-foreground/90">
          <Highlight text={baseName(r.path)} hits={r.hits} offset={slash} />
        </span>
        <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
          <Highlight text={parentOf(r.path)} hits={r.hits.filter((h) => h < slash)} />
        </span>
      </CommandItem>
    )
  }

  if (!files.length) return <CommandEmpty>No files — is the daemon connected?</CommandEmpty>
  return (
    <>
      <CommandEmpty>No matching files</CommandEmpty>
      {results.recent.length > 0 && <CommandGroup heading="Recently opened">{results.recent.map(item)}</CommandGroup>}
      {results.rest.length > 0 && <CommandGroup heading={line ? `Open at line ${line}` : undefined}>{results.rest.map(item)}</CommandGroup>}
    </>
  )
}

function useActiveText() {
  const activeFile = useKivo((s) => s.activeFile)
  const text = useKivo((s) => (s.activeFile ? s.fileCache[s.activeFile]?.content : undefined))
  return activeFile && !isDiffTab(activeFile) && text !== undefined ? { path: activeFile, text } : null
}

function LineResult({ query, onDone }: { query: string; onDone: () => void }) {
  const active = useActiveText()
  if (!active) return <CommandEmpty>Open a file first</CommandEmpty>
  const total = active.text.split("\n").length
  const m = /^\s*(\d+)?(?:[:,](\d+))?\s*$/.exec(query)
  const line = m?.[1] ? Math.min(Math.max(1, Number(m[1])), total) : null
  const col = m?.[2] ? Math.max(0, Number(m[2]) - 1) : 0
  return (
    <CommandGroup>
      <CommandItem
        value="goto-line"
        disabled={!line}
        onSelect={() => {
          if (!line) return
          onDone()
          useEditor.getState().revealAt({ path: active.path, line, col, len: 0 })
        }}
      >
        <Hash className="text-muted-foreground" />
        {line ? `Go to line ${line}${col ? `, column ${col + 1}` : ""}` : `Type a line number between 1 and ${total}`}
      </CommandItem>
    </CommandGroup>
  )
}

function SymbolResults({ query, onDone }: { query: string; onDone: () => void }) {
  const active = useActiveText()
  const symbols = useMemo(() => (active ? symbolsOf(active.path, active.text) : []), [active?.path, active?.text]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!active) return <CommandEmpty>Open a file first</CommandEmpty>
  const list = query.trim()
    ? symbols
        .map((s) => ({ s, m: scoreText(query, s.name) }))
        .filter((x) => x.m)
        .sort((a, b) => b.m!.score - a.m!.score)
        .slice(0, MAX)
    : symbols.slice(0, 400).map((s) => ({ s, m: null }))
  if (!symbols.length) return <CommandEmpty>No symbols found in {baseName(active.path)}</CommandEmpty>
  return (
    <>
      <CommandEmpty>No matching symbols</CommandEmpty>
      <CommandGroup heading={`${symbols.length} symbol${symbols.length === 1 ? "" : "s"} in ${baseName(active.path)}`}>
        {list.map(({ s, m }) => {
          const Icon = KIND_ICON[s.kind] ?? AtSign
          return (
            <CommandItem
              key={`${s.line}:${s.name}`}
              value={`${s.line}:${s.name}`}
              onSelect={() => {
                onDone()
                useEditor.getState().revealAt({ path: active.path, line: s.line, col: s.col, len: s.name.length })
              }}
              className="gap-2"
            >
              <span style={{ paddingLeft: query.trim() ? 0 : Math.min(s.depth, 6) * 10 }} className="flex items-center gap-2">
                <Icon className="size-3.5 text-muted-foreground" />
                <span className="font-mono text-[12.5px]">
                  <Highlight text={s.name} hits={m?.hits ?? []} />
                </span>
              </span>
              <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                {s.kind} · {s.line}
              </span>
            </CommandItem>
          )
        })}
      </CommandGroup>
    </>
  )
}
