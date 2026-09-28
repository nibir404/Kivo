import { lazy, Suspense, useEffect, useRef, useState } from "react"
import { Keyboard, Loader2, PanelBottom, PanelLeft, PanelRight } from "lucide-react"
import { useDefaultLayout, type PanelImperativeHandle } from "react-resizable-panels"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { BuildView } from "@/features/build/BuildView"
import { workspace } from "@/features/workspace/registry"
import { cn } from "@/lib/utils"
import { init, openFile } from "@/state/runners"
import { useKivo } from "@/state/store"
import { BottomPanel } from "./BottomPanel"
import { CommandMenu } from "./CommandMenu"
import { ContextPanel } from "./ContextPanel"
import { ExperienceDialog, NoteDialog } from "./Dialogs"
import { ErrorBoundary } from "./ErrorBoundary"
import { Navigator } from "./Navigator"
import { TopBar, MODES } from "./TopBar"
import { FloatingCaptureToolbar, useDismissCapture, useUi } from "./capture"
import { PreferenceDialogs } from "./Preferences"
import { ProjectDialogs } from "./projects/ProjectDialogs"
import { useWidthTier } from "./useCompact"

// The editor (CodeMirror) and graph views (React Flow) are heavy; load them the first time they're opened.
const CodeView = lazy(() => import("@/features/code/CodeView").then((m) => ({ default: m.CodeView })))
const LearnView = lazy(() => import("@/features/learn/LearnView").then((m) => ({ default: m.LearnView })))
const LibraryView = lazy(() => import("@/features/library/LibraryView").then((m) => ({ default: m.LibraryView })))
const ObserveView = lazy(() => import("@/features/observe/ObserveView").then((m) => ({ default: m.ObserveView })))

/** Drives time: build steps advance on their own schedule and live traffic flows while running. */
function useEngine() {
  const build = useKivo((s) => s.build)
  const advanceBuild = useKivo((s) => s.advanceBuild)
  const runtimeLive = useKivo((s) => s.runtimeLive)
  const tickRuntime = useKivo((s) => s.tickRuntime)

  useEffect(() => {
    // Real builds are driven by the daemon; only the offline simulation advances on a timer.
    if (!build || build.finished || build.real) return
    const t = setTimeout(advanceBuild, build.steps[build.index].durationMs)
    return () => clearTimeout(t)
  }, [build, advanceBuild])

  useEffect(() => {
    if (!runtimeLive) return
    tickRuntime()
    const t = setInterval(tickRuntime, 1400)
    return () => clearInterval(t)
  }, [runtimeLive, tickRuntime])
}

function useShortcuts(toggle: (p: "left" | "right" | "bottom") => void) {
  const { setCommandOpen, setMode, commandOpen, setDialog } = useKivo()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement | null)?.closest?.("input,textarea,[contenteditable=true],.cm-editor,.xterm")
      if (e.key === "?" && !typing && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        setDialog("shortcuts")
        return
      }
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.key === ",") {
        e.preventDefault()
        setDialog("settings")
        return
      }
      if (e.key === "k") {
        // Inside the code editor ⌘K is inline edit, inside the terminal it clears — both handle it themselves.
        if ((e.target as HTMLElement | null)?.closest?.(".cm-editor,.xterm")) return
        e.preventDefault()
        setCommandOpen(!commandOpen)
      }
      const m = MODES.find((x) => x.key === e.key)
      if (m) {
        e.preventDefault()
        setMode(m.id)
      }
      if (e.key === "b") {
        e.preventDefault()
        toggle("left")
      }
      if (e.key === "j") {
        e.preventDefault()
        toggle("bottom")
      }
      if (e.key === "i") {
        e.preventDefault()
        toggle("right")
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [setCommandOpen, setMode, commandOpen, toggle, setDialog])
}

/** When a build finishes, say what happened and offer next steps — the user picks one (or none). */
function useBuildNotice() {
  const finished = useKivo((s) => s.build?.finished)
  const notify = useKivo((s) => s.prefs.buildNotify)
  const seen = useRef(false)
  useEffect(() => {
    // Skip the state we loaded with; only announce transitions to finished.
    if (!seen.current) {
      seen.current = true
      return
    }
    if (!finished || !notify) return
    const s = useKivo.getState()
    const b = s.build!
    const spec = s.services.find((x) => x.id === b.specId)
    const name = spec?.name ?? b.specId
    const tests = spec?.tests ?? []
    const passed = tests.filter((t) => t.status === "pass").length
    const summary = tests.length ? `${passed}/${tests.length} tests passing` : undefined
    const open = () => {
      s.openService(b.specId)
    }
    if (!b.real) toast(`${name} simulated`, { description: "Offline simulation — connect the daemon for a real build.", action: { label: "Open", onClick: open } })
    else if (b.ok && !b.url) toast.success(`${name}: code written`, { description: "Not installed, tested or started — that needs Kivo on your computer", action: { label: "Open", onClick: open }, duration: 8000 })
    else if (b.ok) toast.success(`${name} is ready`, { description: [summary, "running locally"].filter(Boolean).join(" · "), action: { label: "Open", onClick: open }, duration: 8000 })
    else
      toast.warning(`${name} finished with issues`, {
        description: summary ?? b.error ?? "Some steps need attention.",
        action: { label: "Review", onClick: open },
        duration: 10000,
      })
  }, [finished, notify])
}

export function AppShell() {
  useEngine()
  useBuildNotice()
  useDismissCapture()
  useEffect(() => {
    init()
  }, [])
  const tier = useWidthTier()
  const compact = tier === "compact"
  const mode = useKivo((s) => s.mode)
  const discipline = useKivo((s) => s.discipline)
  const activeFile = useKivo((s) => s.activeFile)
  const activeServiceId = useKivo((s) => s.activeServiceId)
  const rightOpenTick = useUi((s) => s.rightOpenTick)
  const bottomOpenTick = useUi((s) => s.bottomOpenTick)
  const focusCode = useKivo((s) => s.prefs.focusCode)
  const welcomed = useKivo((s) => s.welcomed)
  const resetLayoutTick = useUi((s) => s.resetLayoutTick)
  // Panel sizes are the user's: remember them across sessions (only changes the user made by hand).
  const outer = useDefaultLayout({ id: "kivo-shell-v", storage: localStorage, onlySaveAfterUserInteractions: true })
  const inner = useDefaultLayout({ id: "kivo-shell-h", storage: localStorage, onlySaveAfterUserInteractions: true })
  const left = useRef<PanelImperativeHandle>(null)
  const right = useRef<PanelImperativeHandle>(null)
  const bottom = useRef<PanelImperativeHandle>(null)
  // Compact layout: side panels become sheets.
  const [leftSheet, setLeftSheet] = useState(false)
  const [rightSheet, setRightSheet] = useState(false)

  const toggle = (p: "left" | "right" | "bottom") => {
    if (compact && p === "left") return setLeftSheet((v) => !v)
    if (compact && p === "right") return setRightSheet((v) => !v)
    const r = { left, right, bottom }[p].current
    if (!r) return
    if (r.isCollapsed()) r.expand()
    else r.collapse()
  }
  useShortcuts(toggle)

  useEffect(() => {
    if (!rightOpenTick) return
    if (compact) setRightSheet(true)
    else if (right.current?.isCollapsed()) right.current.expand()
  }, [rightOpenTick]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (bottomOpenTick && bottom.current?.isCollapsed()) bottom.current.expand()
  }, [bottomOpenTick])

  // Maximize the bottom panel over the workspace, and put it back where the user had it.
  const bottomMax = useUi((s) => s.bottomMax)
  const restoreBottom = useRef<number | null>(null)
  useEffect(() => {
    const b = bottom.current
    if (!b) return
    if (bottomMax) {
      restoreBottom.current = b.isCollapsed() ? null : b.getSize().inPixels
      requestAnimationFrame(() => b.resize("88%"))
    } else if (restoreBottom.current !== null) {
      b.resize(restoreBottom.current)
      restoreBottom.current = null
    }
  }, [bottomMax])

  // First visit: a calm workspace (terminal folded away) and a short welcome.
  useEffect(() => {
    if (!outer.defaultLayout) bottom.current?.collapse()
    if (!welcomed) setTimeout(() => useKivo.getState().setDialog("welcome"), 400)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!resetLayoutTick) return
    for (const key of Object.keys(localStorage)) if (key.includes("kivo-shell")) localStorage.removeItem(key)
    left.current?.expand()
    left.current?.resize(240)
    right.current?.expand()
    right.current?.resize(360)
    bottom.current?.collapse()
    toast.success("Layout reset")
  }, [resetLayoutTick])

  // Picking something in the navigator sheet closes it, so the content is visible.
  useEffect(() => setLeftSheet(false), [activeFile, activeServiceId, mode])

  // Medium widths start with the context panel folded, so the workspace has room.
  useEffect(() => {
    if (tier === "medium" && right.current && !right.current.isCollapsed()) right.current.collapse()
  }, [tier])

  // Code mode is a pure editor: fold the context panel away, and restore it on the way out.
  const autoCollapsed = useRef(false)
  useEffect(() => {
    const r = right.current
    if (!r || compact) return
    if (mode === "code" && focusCode && !r.isCollapsed()) {
      r.collapse()
      autoCollapsed.current = true
    } else if (mode !== "code" && autoCollapsed.current) {
      r.expand()
      autoCollapsed.current = false
    }
  }, [mode, compact, focusCode])

  const main = (
    <main key={mode} className="kivo-fade h-full min-w-0 overflow-hidden">
      <ErrorBoundary resetKey={mode}>
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
            </div>
          }
        >
          {mode === "build" && <BuildView />}
          {mode === "code" && <CodeView />}
          {mode === "observe" && <ObserveView />}
          {mode === "learn" && <LearnView />}
          {mode === "library" && <LibraryView />}
        </Suspense>
      </ErrorBoundary>
    </main>
  )

  return (
    <div className="flex h-full flex-col bg-background text-foreground" data-workspace={discipline} style={{ "--ws-h": workspace(discipline).hue } as React.CSSProperties}>
      <TopBar compact={compact} onToggleLeft={() => toggle("left")} onToggleRight={() => toggle("right")} />
      <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1" id="kivo-shell-v" defaultLayout={outer.defaultLayout} onLayoutChanged={outer.onLayoutChanged}>
        <ResizablePanel id="work" defaultSize="72" minSize="30">
          {compact ? (
            main
          ) : (
            <ResizablePanelGroup orientation="horizontal" id="kivo-shell-h" defaultLayout={inner.defaultLayout} onLayoutChanged={inner.onLayoutChanged}>
              <ResizablePanel id="nav" panelRef={left} defaultSize={240} minSize={180} maxSize={380} collapsible>
                <Navigator />
              </ResizablePanel>
              <ResizableHandle />
              <ResizablePanel id="main" minSize={320}>
                {main}
              </ResizablePanel>
              <ResizableHandle />
              <ResizablePanel id="context" panelRef={right} defaultSize={360} minSize={280} maxSize={560} collapsible>
                <ErrorBoundary>
                  <ContextPanel />
                </ErrorBoundary>
              </ResizablePanel>
            </ResizablePanelGroup>
          )}
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel id="bottom" panelRef={bottom} defaultSize={compact ? 180 : 240} minSize={100} collapsible>
          <BottomPanel />
        </ResizablePanel>
      </ResizablePanelGroup>
      <StatusBar toggle={toggle} compact={compact} />

      {compact && (
        <>
          <Sheet open={leftSheet} onOpenChange={setLeftSheet}>
            <SheetContent side="left" className="w-72 gap-0 p-0" showCloseButton={false}>
              <SheetTitle className="sr-only">Navigator</SheetTitle>
              <Navigator />
            </SheetContent>
          </Sheet>
          <Sheet open={rightSheet} onOpenChange={setRightSheet}>
            <SheetContent side="right" className="w-[min(92vw,420px)] gap-0 p-0 sm:max-w-none" showCloseButton={false}>
              <SheetTitle className="sr-only">Context</SheetTitle>
              <ErrorBoundary>
                <ContextPanel />
              </ErrorBoundary>
            </SheetContent>
          </Sheet>
        </>
      )}
      <CommandMenu />
      <NoteDialog />
      <ExperienceDialog />
      <PreferenceDialogs />
      <FloatingCaptureToolbar />
      <ProjectDialogs />
    </div>
  )
}

/** Always-visible system status. Every item is live and clickable — it takes you to the thing it describes. */
function StatusBar({ toggle, compact }: { toggle: (p: "left" | "right" | "bottom") => void; compact: boolean }) {
  const { services, library, experiences, daemon, build, runtimeLive, toggleRuntime, openService, setMode, setDialog, activeFile, fileCache } = useKivo()
  const running = services.filter((s) => s.status === "running").length
  const building = build && !build.finished ? build : null
  const buildingName = building ? (services.find((s) => s.id === building.specId)?.name ?? building.specId) : ""
  const dirty = activeFile && fileCache[activeFile] && fileCache[activeFile].content !== fileCache[activeFile].saved
  const item = "flex h-full items-center gap-1.5 rounded-sm px-1.5 hover:bg-accent hover:text-foreground"

  return (
    <footer className="flex h-7 shrink-0 items-center gap-1 border-t px-1.5 text-[11px] text-muted-foreground">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={item}>
            <span className={cn("size-1.5 rounded-full", daemon ? "bg-success" : "kivo-pulse bg-warning")} />
            {daemon ? "Connected" : "Connecting…"}
          </span>
        </TooltipTrigger>
        <TooltipContent>{daemon ? "Local Kivo daemon is running — builds, files and the terminal are real." : "Waiting for the Kivo daemon (npm run dev). Everything works offline in simulation meanwhile."}</TooltipContent>
      </Tooltip>

      {building ? (
        <button className={item} onClick={() => openService(building.specId)}>
          <Loader2 className="size-3 animate-spin" />
          Building {buildingName} · {Math.min(building.index + 1, building.steps.length)}/{building.steps.length}
        </button>
      ) : (
        <button className={item} onClick={() => setMode("build")}>
          <span className={cn("size-1.5 rounded-full", running ? "bg-success" : "bg-muted-foreground/40")} />
          {running} {running === 1 ? "service" : "services"} running
        </button>
      )}

      {!compact && (
        <>
          <button className={item} onClick={toggleRuntime}>
            <span className={cn("size-1.5 rounded-full", runtimeLive ? "kivo-pulse bg-info" : "bg-muted-foreground/40")} />
            Demo traffic {runtimeLive ? "on" : "off"}
          </button>
          <button className={item} onClick={() => setMode("library")}>
            {library.length} notes · {experiences.length} experiences
          </button>
          {activeFile && (
            <button className={cn(item, "max-w-72")} onClick={() => openFile(activeFile)}>
              <span className="truncate font-mono">{activeFile}</span>
              {dirty && <span className="size-1.5 shrink-0 rounded-full bg-foreground" aria-label="Unsaved changes" />}
            </button>
          )}
        </>
      )}

      <div className="ml-auto flex h-full items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-xs" onClick={() => setDialog("shortcuts")} aria-label="Keyboard shortcuts">
              <Keyboard />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Keyboard shortcuts ?</TooltipContent>
        </Tooltip>
        {(
          [
            ["left", PanelLeft, "⌘B", "navigator"],
            ["bottom", PanelBottom, "⌘J", "terminal"],
            ["right", PanelRight, "⌘I", "context"],
          ] as const
        ).map(([p, Icon, key, name]) => (
          <Tooltip key={p}>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-xs" onClick={() => toggle(p)} aria-label={`Toggle ${name} panel`}>
                <Icon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              Toggle {name} {key}
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
    </footer>
  )
}
