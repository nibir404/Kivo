import { useEffect, useRef, useState, type ReactNode } from "react"
import { create } from "zustand"
import { toast } from "sonner"
import { BookmarkPlus, HelpCircle, MessageSquare, PencilLine, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { CONCEPTS } from "@/core/concepts"
import type { KivoRef } from "@/core/types"
import { cn } from "@/lib/utils"
import { useKivo } from "@/state/store"

/**
 * Explain & Capture — the signature interaction.
 *
 * Any object in Kivo can be wrapped in <Capturable>. Selecting it (click) or highlighting
 * text inside a capture scope raises the floating toolbar: Explain · Why? · Note · Save · Ask AI.
 * The same five verbs work on code, architecture, runtime events, logs and AI output.
 */

interface UiState {
  anchor: { x: number; y: number } | null
  anchorRef: KivoRef | null
  anchorEl: Node | null
  explainFocus: "top" | "why"
  askFocusTick: number
  rightOpenTick: number
  bottomOpenTick: number
  /** A command queued for the integrated terminal (typed into the live shell). */
  terminalCmd: { id: number; cmd: string } | null
  setAnchor: (a: UiState["anchor"], ref: KivoRef | null, el?: Node | null) => void
  setExplainFocus: (f: UiState["explainFocus"]) => void
  focusAsk: () => void
  openRight: () => void
  runInTerminal: (cmd: string) => void
  /** Bumped to restore the default panel layout. */
  resetLayoutTick: number
  resetLayout: () => void
  /** Text to pre-fill the intent composer with (e.g. when refining a description). Consumed on read. */
  prefill: string | null
  setPrefill: (t: string | null) => void
}

export const useUi = create<UiState>((set) => ({
  anchor: null,
  anchorRef: null,
  anchorEl: null,
  explainFocus: "top",
  askFocusTick: 0,
  rightOpenTick: 0,
  bottomOpenTick: 0,
  terminalCmd: null,
  resetLayoutTick: 0,
  prefill: null,
  setPrefill: (prefill) => set({ prefill }),
  resetLayout: () => set((s) => ({ resetLayoutTick: s.resetLayoutTick + 1 })),
  setAnchor: (anchor, anchorRef, anchorEl = null) => set({ anchor, anchorRef, anchorEl }),
  setExplainFocus: (explainFocus) => set({ explainFocus }),
  focusAsk: () => set((s) => ({ askFocusTick: s.askFocusTick + 1 })),
  openRight: () => set((s) => ({ rightOpenTick: s.rightOpenTick + 1 })),
  runInTerminal: (cmd) => {
    useKivo.getState().setBottomTab("terminal")
    set((s) => ({ bottomOpenTick: s.bottomOpenTick + 1, terminalCmd: { id: Date.now(), cmd } }))
  },
}))

/** Find a known concept mentioned in free text (for text selections). */
export function conceptIn(text: string): string | undefined {
  const t = text.toLowerCase()
  return Object.values(CONCEPTS).find((c) => t.includes(c.name.toLowerCase()) || t.includes(c.id))?.id
}

export function useCaptureActions() {
  const select = useKivo((s) => s.select)
  const saveToLibrary = useKivo((s) => s.saveToLibrary)
  const openNote = useKivo((s) => s.openNote)
  const { setExplainFocus, focusAsk, openRight, setAnchor } = useUi()

  return {
    explain(ref: KivoRef) {
      setExplainFocus("top")
      select(ref, "explain")
      openRight()
      setAnchor(null, null)
    },
    why(ref: KivoRef) {
      setExplainFocus("why")
      select(ref, "explain")
      openRight()
      setAnchor(null, null)
    },
    note(ref: KivoRef) {
      openNote(ref)
      setAnchor(null, null)
    },
    save(ref: KivoRef) {
      saveToLibrary(ref)
      setAnchor(null, null)
      toast.success(`Saved “${ref.label}” to your Library`, {
        action: { label: "Add note", onClick: () => openNote(ref) },
      })
    },
    ask(ref: KivoRef) {
      select(ref, "ai")
      openRight()
      focusAsk()
      setAnchor(null, null)
    },
  }
}

const VERBS = [
  { key: "explain", label: "Explain", icon: Sparkles, hint: "E" },
  { key: "why", label: "Why?", icon: HelpCircle, hint: "W" },
  { key: "note", label: "Note", icon: PencilLine, hint: "N" },
  { key: "save", label: "Save", icon: BookmarkPlus, hint: "S" },
  { key: "ask", label: "Ask AI", icon: MessageSquare, hint: "A" },
] as const

export function CaptureBar({ refObj, compact, className }: { refObj: KivoRef; compact?: boolean; className?: string }) {
  const actions = useCaptureActions()
  return (
    <div className={cn("flex items-center gap-0.5", className)}>
      {VERBS.map((v) => (
        <Tooltip key={v.key}>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size={compact ? "icon-xs" : "xs"}
              className="text-muted-foreground hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation()
                actions[v.key](refObj)
              }}
            >
              <v.icon />
              {!compact && v.label}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {v.label} <Kbd className="ml-1">{v.hint}</Kbd>
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  )
}

/** Floating toolbar, rendered once at the app root. */
export function FloatingCaptureToolbar() {
  const { anchor, anchorRef, anchorEl, setAnchor } = useUi()
  const actions = useCaptureActions()
  const enabled = useKivo((s) => s.prefs.captureToolbar)

  useEffect(() => {
    if (!anchorRef || !enabled) return
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el?.closest?.("input,textarea,[contenteditable=true],[role=dialog]") || e.metaKey || e.ctrlKey || e.altKey) return
      const map: Record<string, keyof typeof actions> = { e: "explain", w: "why", n: "note", s: "save", a: "ask" }
      const verb = map[e.key.toLowerCase()]
      if (verb) {
        e.preventDefault()
        actions[verb](anchorRef)
      } else if (e.key === "Escape") setAnchor(null, null)
    }
    const hide = () => setAnchor(null, null)
    // Only hide when the region containing the anchor scrolls — live logs scrolling elsewhere shouldn't dismiss it.
    const onScroll = (e: Event) => {
      const t = e.target as Node
      if (!anchorEl || t === document || t.contains(anchorEl)) hide()
    }
    window.addEventListener("keydown", onKey)
    window.addEventListener("resize", hide)
    document.addEventListener("scroll", onScroll, true)
    return () => {
      window.removeEventListener("keydown", onKey)
      window.removeEventListener("resize", hide)
      document.removeEventListener("scroll", onScroll, true)
    }
  }, [anchorRef, anchorEl, actions, setAnchor, enabled])

  if (!enabled || !anchor || !anchorRef) return null
  const left = Math.min(Math.max(8, anchor.x - 170), window.innerWidth - 348)
  const top = Math.max(8, anchor.y - 44)
  return (
    <div
      data-capture-toolbar
      className="kivo-in fixed z-50 flex items-center rounded-lg border bg-popover p-0.5 shadow-lg shadow-black/5"
      style={{ left, top }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <span className="max-w-28 truncate px-2 font-mono text-[11px] text-muted-foreground">{anchorRef.label}</span>
      <div className="mx-0.5 h-4 w-px bg-border" />
      <CaptureBar refObj={anchorRef} />
    </div>
  )
}

/**
 * Makes any element selectable. Click selects it (updating the Context Panel) and raises the toolbar.
 */
export function Capturable({
  refObj,
  children,
  className,
  as: Tag = "div",
  onSelect,
}: {
  refObj: KivoRef
  children: ReactNode
  className?: string
  as?: "div" | "span" | "li" | "button" | "tr"
  onSelect?: () => void
}) {
  const selection = useKivo((s) => s.selection)
  const select = useKivo((s) => s.select)
  const setAnchor = useUi((s) => s.setAnchor)
  const el = useRef<HTMLElement>(null)
  const active = selection?.kind === refObj.kind && selection.id === refObj.id

  return (
    <Tag
      ref={el as never}
      data-capturable
      data-active={active || undefined}
      className={cn(
        "cursor-pointer rounded-md transition-colors data-active:bg-accent data-active:ring-1 data-active:ring-border",
        className,
      )}
      onClick={(e: React.MouseEvent) => {
        if (window.getSelection()?.toString()) return
        e.stopPropagation()
        select(refObj)
        onSelect?.()
        const r = el.current!.getBoundingClientRect()
        setAnchor({ x: Math.min(e.clientX, r.right), y: r.top }, refObj, el.current)
      }}
    >
      {children}
    </Tag>
  )
}

/** Wrap regions (logs, code, explanations, AI output) where free-text highlighting should raise the toolbar. */
export function CaptureScope({ children, source, className }: { children: ReactNode; source: string; className?: string }) {
  const setAnchor = useUi((s) => s.setAnchor)
  const select = useKivo((s) => s.select)
  return (
    <div
      className={className}
      onMouseUp={() => {
        const sel = window.getSelection()
        const text = sel?.toString().trim()
        if (!sel || !text || text.length < 2) return
        const rect = sel.getRangeAt(0).getBoundingClientRect()
        const conceptId = conceptIn(text)
        const ref: KivoRef = {
          kind: source === "code" ? "code" : source === "log" ? "log" : "text",
          id: `sel:${text.slice(0, 40)}`,
          label: text.length > 42 ? `${text.slice(0, 40)}…` : text,
          detail: text,
          conceptId,
        }
        select(ref)
        setAnchor({ x: rect.left + rect.width / 2, y: rect.top }, ref, sel.getRangeAt(0).commonAncestorContainer)
      }}
    >
      {children}
    </div>
  )
}

/** Clears the toolbar on outside clicks. */
export function useDismissCapture() {
  const setAnchor = useUi((s) => s.setAnchor)
  const [, force] = useState(0)
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (t.closest("[data-capture-toolbar],[data-capturable]")) return
      setAnchor(null, null)
      force((n) => n + 1)
    }
    document.addEventListener("mousedown", onDown)
    return () => document.removeEventListener("mousedown", onDown)
  }, [setAnchor])
}
