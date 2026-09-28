import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react"
import { Compartment, EditorState, type Extension } from "@codemirror/state"
import { unifiedMergeView } from "@codemirror/merge"
import { EditorView, keymap, type ReactCodeMirrorRef } from "@uiw/react-codemirror"
import { ArrowUp, Check, Loader2, Sparkles, Square, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { sse } from "@/lib/api"
import { cn } from "@/lib/utils"
import { useKivo } from "@/state/store"

/**
 * Inline edit: select code with the mouse (or press ⌘K), describe a change, watch it stream in as an inline diff,
 * then accept (⌘↵), reject (Esc) or refine with a follow-up. The rest of the file stays editable
 * context; only the region is rewritten.
 */

type Phase = "prompt" | "streaming" | "review" | "error"

interface Session {
  /** Unique per ⌘K invocation, so the prompt re-focuses even if a session was already open. */
  id: number
  phase: Phase
  /** Region in the ORIGINAL document. */
  origFrom: number
  origTo: number
  /** Current length of the (possibly rewritten) region in the live document. */
  liveLen: number
  original: string
  proposal?: string
  instruction?: string
  error?: string
  lines: [number, number]
  insert: boolean
  /** Opened by a mouse selection rather than ⌘K: the user's selection is left exactly as they made it. */
  auto?: boolean
  /** The text the user selected, so ⌘C in the empty prompt still copies it. */
  selected?: string
}

const mergeDiff = new Compartment()
const lock = new Compartment()

const diffTheme = EditorView.theme({
  ".cm-changedLine": { backgroundColor: "color-mix(in oklch, var(--success) 10%, transparent) !important" },
  ".cm-changedText": { backgroundColor: "color-mix(in oklch, var(--success) 22%, transparent) !important", borderRadius: "2px" },
  ".cm-deletedChunk": { backgroundColor: "color-mix(in oklch, var(--destructive) 9%, transparent)", paddingLeft: "6px" },
  ".cm-deletedChunk .cm-deletedText, .cm-deletedChunk del": { backgroundColor: "color-mix(in oklch, var(--destructive) 20%, transparent)", textDecoration: "none" },
  ".cm-changeGutter": { width: "3px", paddingLeft: "0" },
  ".cm-changedLineGutter": { backgroundColor: "var(--success)" },
  ".cm-deletedLineGutter": { backgroundColor: "var(--destructive)" },
})

export function useInlineEdit(cm: RefObject<ReactCodeMirrorRef | null>, path: string | null) {
  const [session, setSession] = useState<Session | null>(null)
  const sessionRef = useRef<Session | null>(null)
  sessionRef.current = session
  const abort = useRef<AbortController | null>(null)
  const ai = useKivo((s) => s.ai)
  const autoOpen = useKivo((s) => s.prefs.aiOnSelect)
  const autoRef = useRef(autoOpen)
  autoRef.current = autoOpen

  const view = () => cm.current?.view ?? null

  const close = useCallback((refocus = true) => {
    abort.current?.abort()
    const v = view()
    v?.dispatch({ effects: [mergeDiff.reconfigure([]), lock.reconfigure([])] })
    setSession(null)
    if (refocus) v?.focus()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const start = useCallback(
    (auto = false) => {
      const v = view()
      if (!v || !path) return
      if (sessionRef.current?.phase === "streaming") return
      if (sessionRef.current) close()
      const { state } = v
      const sel = state.selection.main
      const endPos = !sel.empty && state.doc.lineAt(sel.to).from === sel.to && sel.to > sel.from ? sel.to - 1 : sel.to
      const first = state.doc.lineAt(sel.from)
      const last = state.doc.lineAt(endPos)
      // ⌘K snaps the selection to whole lines so it's clear what will be rewritten; a mouse selection is left alone.
      if (!auto) v.dispatch({ selection: { anchor: first.from, head: last.to } })
      setSession({
        id: Date.now(),
        phase: "prompt",
        origFrom: first.from,
        origTo: last.to,
        liveLen: last.to - first.from,
        original: state.doc.toString(),
        lines: [first.number, last.number],
        insert: sel.empty,
        auto,
        selected: state.sliceDoc(sel.from, sel.to),
      })
    },
    [path, close],
  )

  const run = useCallback(
    async (instruction: string) => {
      const v = view()
      const s = sessionRef.current
      if (!v || !s || !path || !instruction.trim()) return
      const followUp = s.phase === "review" && s.proposal !== undefined
      const ac = new AbortController()
      abort.current = ac
      setSession({ ...s, phase: "streaming", instruction, error: undefined })
      v.dispatch({
        selection: { anchor: s.origFrom },
        effects: [
          mergeDiff.reconfigure([unifiedMergeView({ original: s.original, mergeControls: false, gutter: true, highlightChanges: true, syntaxHighlightDeletions: true }), diffTheme]),
          lock.reconfigure(EditorState.readOnly.of(true)),
        ],
      })

      let raw = ""
      let liveLen = s.liveLen
      let frame = 0
      const apply = () => {
        frame = 0
        const text = clean(raw)
        v.dispatch({ changes: { from: s.origFrom, to: s.origFrom + liveLen, insert: text } })
        liveLen = text.length
      }
      try {
        await sse<{ t: string; channel?: string; text?: string }>(
          "/api/ai/edit",
          { path, content: s.original, from: s.origFrom, to: s.origTo, instruction, previous: followUp ? s.proposal : undefined },
          (e) => {
            if (e.t === "delta" && e.channel === "content") {
              raw += e.text
              frame ||= requestAnimationFrame(apply)
            }
          },
          ac.signal,
        )
        if (frame) cancelAnimationFrame(frame)
        apply()
        const proposal = clean(raw)
        setSession({ ...s, phase: "review", instruction, proposal, liveLen })
      } catch (err) {
        if (frame) cancelAnimationFrame(frame)
        if (ac.signal.aborted) {
          apply()
          setSession({ ...s, phase: "review", instruction, proposal: clean(raw), liveLen })
        } else setSession({ ...s, phase: "error", error: String((err as Error).message), liveLen })
      } finally {
        v.dispatch({ effects: lock.reconfigure([]) })
      }
    },
    [path],
  )

  const accept = useCallback(() => {
    const v = view()
    if (!v || sessionRef.current?.phase !== "review") return
    v.dispatch({ effects: mergeDiff.reconfigure([]) })
    setSession(null)
    v.focus()
  }, [])

  const reject = useCallback(() => {
    const v = view()
    const s = sessionRef.current
    if (!v || !s) return
    abort.current?.abort()
    if (s.phase !== "prompt") v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: s.original } })
    close()
  }, [close])

  const stop = useCallback(() => abort.current?.abort(), [])

  // Handlers change identity; the editor keymap reads them through a ref.
  const handlers = useRef({ start, accept, reject, close })
  handlers.current = { start, accept, reject, close }

  // Selecting with the mouse opens the prompt once the selection settles (drag, double- or triple-click).
  const settle = useRef(0)
  const onSelectEnd = useCallback((v: EditorView) => {
    clearTimeout(settle.current)
    settle.current = window.setTimeout(() => {
      if (!autoRef.current || sessionRef.current) return
      const sel = v.state.selection.main
      if (sel.empty || !v.state.sliceDoc(sel.from, sel.to).trim()) return
      handlers.current.start(true)
    }, 220)
  }, [])

  const extensions: Extension[] = useMemo(
    () => [
      mergeDiff.of([]),
      lock.of([]),
      keymap.of([
        { key: "Mod-k", preventDefault: true, run: () => (handlers.current.start(), true) },
        { key: "Mod-Enter", run: () => (sessionRef.current?.phase === "review" ? (handlers.current.accept(), true) : false) },
        { key: "Escape", run: () => (sessionRef.current ? (handlers.current.reject(), true) : false) },
      ]),
      EditorView.domEventHandlers({
        mousedown: (e) => {
          clearTimeout(settle.current)
          // Starting a new selection dismisses an untouched auto-opened prompt.
          const s = sessionRef.current
          if (e.button === 0 && s?.auto && s.phase === "prompt") handlers.current.close(false)
          return false
        },
        mouseup: (e, v) => {
          if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.altKey) onSelectEnd(v)
          return false
        },
      }),
    ],
    [onSelectEnd],
  )

  // Reset if the file changes underneath an open session.
  useEffect(() => {
    if (sessionRef.current) setSession(null)
  }, [path])

  const widget = session ? <InlineEditWidget cm={cm} session={session} model={ai?.model} onRun={run} onAccept={accept} onReject={reject} onStop={stop} /> : null
  return { extensions, widget, start: () => start(), active: !!session }
}

/** Strip code fences and trailing blank lines models sometimes add. */
function clean(text: string) {
  return text.replace(/^\s*```[\w-]*\n/, "").replace(/\n?```\s*$/, "").replace(/\n+$/, "")
}

function InlineEditWidget({
  cm,
  session,
  model,
  onRun,
  onAccept,
  onReject,
  onStop,
}: {
  cm: RefObject<ReactCodeMirrorRef | null>
  session: Session
  model?: string
  onRun: (instruction: string) => void
  onAccept: () => void
  onReject: () => void
  onStop: () => void
}) {
  const [text, setText] = useState("")
  const [top, setTop] = useState<number | null>(null)
  const input = useRef<HTMLInputElement>(null)

  // Anchor above the first line of the region; follow the editor's scroll.
  useEffect(() => {
    const v = cm.current?.view
    if (!v) return
    const place = () => {
      const len = v.state.doc.length
      const host = v.dom.getBoundingClientRect()
      const first = v.coordsAtPos(Math.min(session.origFrom, len))
      if (!first) return setTop(null)
      // Deleted lines render as blocks above the change; anchor above those too, never over the diff.
      const deleted = [...v.dom.querySelectorAll(".cm-deletedChunk")].map((el) => el.getBoundingClientRect().top).filter((t) => t <= first.top && t > first.top - 600)
      const y = Math.min(first.top, ...deleted) - host.top
      if (y >= 96) return setTop(y - 8)
      // No room above: sit under the region's last line instead of covering the diff.
      const last = v.coordsAtPos(v.state.doc.lineAt(Math.min(session.origFrom + session.liveLen, len)).to)
      setTop((last?.bottom ?? first.bottom) - host.top + 6)
    }
    place()
    v.scrollDOM.addEventListener("scroll", place)
    const ro = new ResizeObserver(place)
    ro.observe(v.dom)
    return () => {
      v.scrollDOM.removeEventListener("scroll", place)
      ro.disconnect()
    }
  }, [cm, session.origFrom, session.liveLen, session.phase])

  useEffect(() => {
    if (session.phase === "prompt" || session.phase === "review") {
      setText("")
      requestAnimationFrame(() => input.current?.focus())
    }
  }, [session.phase, session.id, top === null])

  if (top === null) return null
  const above = top > 96
  const range = session.lines[0] === session.lines[1] ? `line ${session.lines[0]}` : `lines ${session.lines[0]}–${session.lines[1]}`

  return (
    <div
      className="absolute right-4 left-12 z-20 max-w-2xl"
      style={above ? { top, transform: "translateY(-100%)" } : { top }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="kivo-in rounded-xl border bg-popover shadow-lg shadow-black/10">
        {(session.phase === "prompt" || session.phase === "review" || session.phase === "error") && (
          <form
            className="flex items-center gap-2 px-3 py-2"
            onSubmit={(e) => {
              e.preventDefault()
              if (text.trim()) onRun(text.trim())
            }}
          >
            <Sparkles className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              ref={input}
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                // The prompt took focus from a selection: with nothing typed, ⌘C/⌘X still act on the code.
                if (!text && session.selected && (e.metaKey || e.ctrlKey) && (e.key === "c" || e.key === "x")) {
                  e.preventDefault()
                  navigator.clipboard.writeText(session.selected).catch(() => {})
                  if (e.key === "x") {
                    const v = cm.current?.view
                    onReject()
                    if (v) v.dispatch(v.state.replaceSelection(""))
                  }
                  return
                }
                if (e.key === "Escape") {
                  e.preventDefault()
                  onReject()
                }
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && session.phase === "review") {
                  e.preventDefault()
                  onAccept()
                }
              }}
              placeholder={session.phase === "review" ? "Ask for a follow-up change…" : session.insert ? "Generate or change code here…" : "Edit the selected code…"}
              className="h-7 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
            />
            <Button type="submit" size="icon-xs" disabled={!text.trim()} aria-label="Submit">
              <ArrowUp />
            </Button>
          </form>
        )}

        {session.phase === "streaming" && (
          <div className="flex items-center gap-2 px-3 py-2.5 text-[13px]">
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">
              <span className="text-muted-foreground">Editing {range} · </span>
              {session.instruction}
            </span>
            <Button size="xs" variant="ghost" onClick={onStop}>
              <Square className="size-3" /> Stop
            </Button>
          </div>
        )}

        <div className="flex items-center gap-2 border-t px-3 py-1.5 text-[11px] text-muted-foreground">
          {session.phase === "review" ? (
            <>
              <Button size="xs" onClick={onAccept} className="h-6">
                <Check /> Accept <Kbd className="ml-0.5 bg-primary-foreground/15 text-primary-foreground">⌘↵</Kbd>
              </Button>
              <Button size="xs" variant="ghost" onClick={onReject} className="h-6">
                <X /> Reject <Kbd className="ml-0.5">Esc</Kbd>
              </Button>
              <span className="ml-auto truncate">“{session.instruction}”</span>
            </>
          ) : session.phase === "error" ? (
            <span className={cn("truncate text-destructive")}>{session.error}</span>
          ) : (
            <>
              <span>{session.insert ? `At ${range}` : `Selected ${range}`}</span>
              <span className="ml-auto font-mono">{model?.split("/").pop() ?? "offline"}</span>
              <span>
                <Kbd>↵</Kbd> run · <Kbd>Esc</Kbd> close
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
