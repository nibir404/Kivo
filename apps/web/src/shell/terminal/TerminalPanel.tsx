import { useEffect, useRef, useState } from "react"
import { ArrowDown, ArrowUp, CaseSensitive, Eraser, FolderOpen, Home, Loader2, Maximize2, Minimize2, Plus, RotateCw, Search, SquareTerminal, Trash2, X } from "lucide-react"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut, ContextMenuTrigger } from "@/components/ui/context-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { useKivo } from "@/state/store"
import { useUi } from "../capture"
import { handles, useTerminals, type TerminalTab } from "./store"
import { searches, TerminalSession } from "./TerminalSession"

const mod = typeof navigator !== "undefined" && /Mac/.test(navigator.platform) ? "⌘" : "Ctrl+Shift+"

/** The integrated terminal: every tab is a persistent shell in the project workspace. */
export function TerminalPanel({ visible }: { visible: boolean }) {
  const daemon = useKivo((s) => s.daemon)
  const { tabs, active, hydrate, newTab } = useTerminals()
  const searchOpen = useTerminals((s) => s.searchOpen)

  useEffect(() => {
    if (daemon) void hydrate()
  }, [daemon, hydrate])

  if (!daemon) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 p-4 text-center text-[12px] text-muted-foreground">
        <SquareTerminal className="size-5 opacity-60" />
        <div>The terminal needs the Kivo daemon.</div>
        <div>
          Start Kivo with <code className="font-mono text-foreground">npm run dev</code> (or <code className="font-mono text-foreground">npm start</code>).
        </div>
      </div>
    )
  }

  return (
    <div className="relative h-full">
      {tabs.map((t) => (
        <div key={t.id} className={cn("absolute inset-0", t.id !== active && "invisible")}>
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div className="h-full">
                <TerminalSession key={t.epoch ?? 0} tab={t} visible={visible && t.id === active} />
              </div>
            </ContextMenuTrigger>
            <TerminalMenu id={t.id} />
          </ContextMenu>
          {t.id === active && <Overlay tab={t} />}
        </div>
      ))}
      {tabs.length === 0 && (
        <div className="flex h-full items-center justify-center">
          <Button size="sm" variant="outline" onClick={() => newTab()}>
            <Plus /> New terminal
          </Button>
        </div>
      )}
      {searchOpen && active && <FindBar id={active} />}
    </div>
  )
}

function TerminalMenu({ id }: { id: string }) {
  const { closeTab, restart } = useTerminals()
  const copy = () => document.execCommand("copy")
  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (text) handles.get(id)?.input(text)
    } catch {
      // clipboard permission denied — ⌘V still works
    }
  }
  return (
    <ContextMenuContent className="w-48">
      <ContextMenuItem onSelect={copy}>
        Copy <ContextMenuShortcut>{mod}C</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem onSelect={paste}>
        Paste <ContextMenuShortcut>{mod}V</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => useTerminals.getState().setSearchOpen(true)}>
        Find <ContextMenuShortcut>{mod}F</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => handles.get(id)?.clear()}>
        Clear <ContextMenuShortcut>{mod === "⌘" ? "⌘K" : ""}</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => restart(id)}>Restart shell</ContextMenuItem>
      <ContextMenuItem variant="destructive" onSelect={() => closeTab(id)}>
        Kill terminal
      </ContextMenuItem>
    </ContextMenuContent>
  )
}

/** Explains a session that isn't live, with the one action that fixes it. */
function Overlay({ tab }: { tab: TerminalTab }) {
  const { restart, closeTab, reattach } = useTerminals()
  if (tab.status === "reconnecting")
    return (
      <Banner>
        <Loader2 className="size-3 animate-spin" /> Reconnecting to the Kivo daemon…
      </Banner>
    )
  if (tab.status === "taken")
    return (
      <Banner>
        This shell is open in another Kivo window.
        <Button size="xs" variant="outline" onClick={() => reattach(tab.id)}>
          Use it here
        </Button>
      </Banner>
    )
  if (tab.status === "exited" || tab.status === "error")
    return (
      <Banner>
        {tab.status === "error" ? "The shell couldn't start." : `Shell exited${tab.exitCode ? ` with code ${tab.exitCode}` : ""}.`}
        <Button size="xs" variant="outline" onClick={() => restart(tab.id)}>
          <RotateCw /> Restart
        </Button>
        <Button size="xs" variant="ghost" onClick={() => closeTab(tab.id)}>
          Close
        </Button>
      </Banner>
    )
  return null
}

function Banner({ children }: { children: React.ReactNode }) {
  return <div className="absolute top-2 right-4 flex items-center gap-2 rounded-lg border bg-popover px-2.5 py-1 text-xs text-popover-foreground shadow-sm">{children}</div>
}

function FindBar({ id }: { id: string }) {
  const setSearchOpen = useTerminals((s) => s.setSearchOpen)
  const [query, setQuery] = useState("")
  const [caseSensitive, setCase] = useState(false)
  const [result, setResult] = useState<{ index: number; count: number } | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const search = searches.get(id)

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [id])

  useEffect(() => {
    if (!search) return
    const sub = search.onDidChangeResults((r) => setResult({ index: r.resultIndex, count: r.resultCount }))
    return () => {
      sub.dispose()
      search.clearDecorations()
    }
  }, [search])

  const opts = {
    caseSensitive,
    decorations: { matchBackground: "#62520a", matchOverviewRuler: "#d4a800", activeMatchBackground: "#a8710a", activeMatchColorOverviewRuler: "#ff9800" },
  }
  const find = (dir: "next" | "prev", incremental = false) => {
    if (!search) return
    if (!query) {
      search.clearDecorations()
      setResult(null)
      return
    }
    if (dir === "next") search.findNext(query, { ...opts, incremental })
    else search.findPrevious(query, opts)
  }

  useEffect(() => {
    find("next", true)
  }, [query, caseSensitive]) // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => {
    search?.clearDecorations()
    setSearchOpen(false)
    handles.get(id)?.focus()
  }

  return (
    <div className="absolute top-1.5 right-4 z-10 flex items-center gap-0.5 rounded-lg border bg-popover p-0.5 pl-2 shadow-md">
      <Search className="size-3.5 text-muted-foreground" />
      <input
        ref={input}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") find(e.shiftKey ? "prev" : "next")
          if (e.key === "Escape") close()
        }}
        placeholder="Find"
        aria-label="Find in terminal"
        className="h-6 w-44 bg-transparent px-1.5 text-xs outline-none placeholder:text-muted-foreground"
      />
      <span className="min-w-12 text-center font-mono text-[10.5px] text-muted-foreground tabular-nums">
        {query ? (result ? (result.count ? `${result.index + 1}/${result.count}` : "none") : "") : ""}
      </span>
      <Button size="icon-xs" variant={caseSensitive ? "secondary" : "ghost"} aria-label="Match case" aria-pressed={caseSensitive} onClick={() => setCase((v) => !v)}>
        <CaseSensitive />
      </Button>
      <Button size="icon-xs" variant="ghost" aria-label="Previous match" onClick={() => find("prev")}>
        <ArrowUp />
      </Button>
      <Button size="icon-xs" variant="ghost" aria-label="Next match" onClick={() => find("next")}>
        <ArrowDown />
      </Button>
      <Button size="icon-xs" variant="ghost" aria-label="Close find" onClick={close}>
        <X />
      </Button>
    </div>
  )
}

/** Tabs and actions for the terminal, shown in the bottom panel's header. */
export function TerminalToolbar() {
  const { tabs, active, newTab, closeTab, setActive, setSearchOpen } = useTerminals()
  const bottomMax = useUi((s) => s.bottomMax)
  const toggleBottomMax = useUi((s) => s.toggleBottomMax)
  const daemon = useKivo((s) => s.daemon)
  if (!daemon) return null
  return (
    <div className="ml-auto flex min-w-0 items-center gap-0.5">
      <div className="flex min-w-0 items-center gap-0.5 overflow-x-auto" role="tablist" aria-label="Terminals">
        {tabs.length > 1 &&
          tabs.map((t, i) => (
            <div
              key={t.id}
              role="tab"
              aria-selected={t.id === active}
              tabIndex={0}
              onClick={() => setActive(t.id)}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setActive(t.id)}
              onAuxClick={(e) => e.button === 1 && closeTab(t.id)}
              title={t.title}
              className={cn(
                "group flex h-6 max-w-40 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground",
                t.id === active && "bg-accent text-foreground",
              )}
            >
              <span className={cn("size-1.5 shrink-0 rounded-full", t.status === "open" ? "bg-success" : t.status === "reconnecting" || t.status === "connecting" ? "bg-warning" : "bg-muted-foreground/50")} />
              <span className="truncate">
                {i + 1}: {t.title}
              </span>
              <button
                aria-label={`Kill terminal ${i + 1}`}
                className="-mr-1 rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-background/60 focus-visible:opacity-100"
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(t.id)
                }}
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
      </div>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button size="icon-xs" variant="ghost" aria-label="New terminal">
                <Plus />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>New terminal</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem onSelect={() => newTab()}>
            <FolderOpen /> In the project folder
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => newTab("~")}>
            <Home /> In my home folder
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Action label={`Find (${mod}F)`} onClick={() => setSearchOpen(true)} disabled={!active}>
        <Search />
      </Action>
      <Action label="Clear" onClick={() => active && handles.get(active)?.clear()} disabled={!active}>
        <Eraser />
      </Action>
      <Action label="Kill terminal" onClick={() => active && closeTab(active)} disabled={!active}>
        <Trash2 />
      </Action>
      <Action label={bottomMax ? "Restore panel size" : "Maximize panel"} onClick={toggleBottomMax}>
        {bottomMax ? <Minimize2 /> : <Maximize2 />}
      </Action>
    </div>
  )
}

function Action({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button size="icon-xs" variant="ghost" aria-label={label} onClick={onClick} disabled={disabled}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
