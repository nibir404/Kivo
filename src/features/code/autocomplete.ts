import { Annotation, Prec, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state"
import { Decoration, EditorView, keymap, ViewPlugin, WidgetType, type ViewUpdate } from "@codemirror/view"
import { requestCompletion } from "@/lib/agent-api"
import { useKivo } from "@/state/store"

/**
 * Tab autocomplete: after a pause in typing, ask the daemon for a short continuation and show it
 * as dimmed ghost text at the cursor. Tab accepts (only while a suggestion is visible — otherwise
 * Tab indents as usual), Esc dismisses, typing the suggested characters consumes them, anything
 * else cancels. Built for a tight free-tier rate limit: debounced, cached, and it backs off
 * (silently) after 429s.
 */

const DEBOUNCE_MS = 600
const BEFORE = 1500
const AFTER = 500

interface Ghost {
  pos: number
  text: string
}

const setGhost = StateEffect.define<Ghost | null>()
/** Marks our own insertion so it isn't mistaken for the user typing over the suggestion. */
const accepting = Annotation.define<boolean>()

class GhostWidget extends WidgetType {
  readonly text: string
  constructor(text: string) {
    super()
    this.text = text
  }
  eq(other: GhostWidget) {
    return other.text === this.text
  }
  toDOM() {
    const span = document.createElement("span")
    span.className = "cm-ghost-text"
    span.textContent = this.text
    span.setAttribute("aria-hidden", "true")
    return span
  }
  ignoreEvent() {
    return false
  }
}

const ghostField = StateField.define<Ghost | null>({
  create: () => null,
  update(g, tr) {
    for (const e of tr.effects) if (e.is(setGhost)) return e.value
    if (!g) return null
    if (tr.docChanged) {
      if (tr.annotation(accepting)) return null
      // Typing exactly what the suggestion says keeps the rest of it; any other edit cancels it.
      let next: Ghost | null = null
      let changes = 0
      tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        changes++
        const ins = inserted.toString()
        if (fromA === g.pos && toA === fromA && ins && g.text.startsWith(ins)) next = { pos: g.pos + ins.length, text: g.text.slice(ins.length) }
      })
      const n = next as Ghost | null
      return changes === 1 && n && n.text ? n : null
    }
    const sel = tr.state.selection.main
    if (!sel.empty || sel.head !== g.pos) return null
    return g
  },
  provide: (f) => EditorView.decorations.from(f, (g) => (g ? Decoration.set([Decoration.widget({ widget: new GhostWidget(g.text), side: 1 }).range(g.pos)]) : Decoration.none)),
})

// Shared by every editor instance: one rate limit, one cache.
const cache = new Map<string, string>()
const CACHE_MAX = 60
let failures = 0
let pausedUntil = 0

function remember(key: string, value: string) {
  cache.delete(key)
  cache.set(key, value)
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!)
}

function backoff(retryAfterMs: number) {
  failures++
  pausedUntil = Date.now() + Math.min(5 * 60_000, Math.max(retryAfterMs, 4000 * 2 ** (failures - 1)))
}

const LANGS: Record<string, string> = { py: "Python", ts: "TypeScript", tsx: "TypeScript React", js: "JavaScript", jsx: "JavaScript React", json: "JSON", md: "Markdown", yml: "YAML", yaml: "YAML", sql: "SQL", go: "Go", rs: "Rust", java: "Java", kt: "Kotlin", swift: "Swift", css: "CSS", html: "HTML", sh: "Shell" }

function enabled() {
  const s = useKivo.getState()
  return s.prefs.autocomplete !== false && s.daemon && !!s.ai?.ai
}

/** Only suggest where a continuation makes sense: after some code, not in front of other text on the line. */
function context(state: EditorState) {
  const sel = state.selection.main
  if (!sel.empty || state.readOnly) return null
  const pos = sel.head
  const line = state.doc.lineAt(pos)
  const rest = state.sliceDoc(pos, line.to)
  if (!/^[\s)\]}'"`;,:]*$/.test(rest)) return null
  const prefix = state.sliceDoc(Math.max(0, pos - BEFORE), pos)
  if (!prefix.trim()) return null
  return { pos, prefix, suffix: state.sliceDoc(pos, Math.min(state.doc.length, pos + AFTER)) }
}

const fetcher = ViewPlugin.fromClass(
  class {
    timer = 0
    ac: AbortController | null = null
    readonly view: EditorView
    constructor(view: EditorView) {
      this.view = view
    }

    update(u: ViewUpdate) {
      if (!u.docChanged && !u.selectionSet && !u.focusChanged) return
      this.cancel()
      // Suggest after typing (including right after accepting one), never after cursor moves or deletions.
      const typed = u.docChanged && u.transactions.some((tr) => tr.isUserEvent("input"))
      if (typed && !u.state.field(ghostField) && u.view.hasFocus) this.timer = window.setTimeout(() => this.fetch(), DEBOUNCE_MS)
    }

    cancel() {
      clearTimeout(this.timer)
      this.ac?.abort()
      this.ac = null
    }

    async fetch() {
      const view = this.view
      // Not while the inline edit (⌘K) owns the editor: it locks it read-only and takes focus.
      if (!enabled() || Date.now() < pausedUntil || !view.hasFocus || view.state.field(ghostField)) return
      const ctx = context(view.state)
      const file = useKivo.getState().activeFile
      if (!ctx || !file) return
      const key = `${file}\0${ctx.prefix.slice(-400)}\0${ctx.suffix.slice(0, 120)}`
      const doc = view.state.doc
      const show = (text: string) => {
        if (view.state.doc !== doc || view.state.selection.main.head !== ctx.pos || !view.hasFocus || !text) return
        view.dispatch({ effects: setGhost.of({ pos: ctx.pos, text }) })
      }
      const hit = cache.get(key)
      if (hit !== undefined) return show(hit)
      const ac = new AbortController()
      this.ac = ac
      try {
        const r = await requestCompletion({ path: file, language: LANGS[file.split(".").pop()?.toLowerCase() ?? ""] ?? "", prefix: ctx.prefix, suffix: ctx.suffix }, ac.signal)
        if (ac.signal.aborted) return
        if (!r.ok) return backoff(r.retryAfterMs)
        failures = 0
        remember(key, r.completion)
        show(r.completion)
      } catch {
        if (!ac.signal.aborted) backoff(0)
      } finally {
        if (this.ac === ac) this.ac = null
      }
    }

    destroy() {
      this.cancel()
    }
  },
)

function accept(view: EditorView) {
  const g = view.state.field(ghostField)
  if (!g) return false
  view.dispatch({
    changes: { from: g.pos, insert: g.text },
    selection: { anchor: g.pos + g.text.length },
    effects: setGhost.of(null),
    annotations: accepting.of(true),
    userEvent: "input.complete",
    scrollIntoView: true,
  })
  return true
}

function dismiss(view: EditorView) {
  if (!view.state.field(ghostField)) return false
  view.dispatch({ effects: setGhost.of(null) })
  return true
}

const theme = EditorView.baseTheme({
  ".cm-ghost-text": { opacity: "0.45", color: "var(--muted-foreground)", whiteSpace: "pre-wrap", pointerEvents: "none" },
})

/** The ghost-text autocomplete extension for the code editor. */
export function aiAutocomplete(): Extension {
  return [
    ghostField,
    fetcher,
    theme,
    // Highest precedence so Tab/Esc reach us before indentation and the inline-edit keymap — but only claimed while a suggestion shows.
    Prec.highest(
      keymap.of([
        { key: "Tab", run: accept },
        { key: "Escape", run: dismiss },
      ]),
    ),
    // Deferred: dispatching inside a DOM focus handler can re-enter the view's update cycle.
    EditorView.domEventHandlers({ blur: (_e, view) => void (view.state.field(ghostField) && setTimeout(() => view.dom.isConnected && dismiss(view), 0)) }),
  ]
}
