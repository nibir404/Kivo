import { useCallback, useEffect, useRef, useState } from "react"
import { javascript } from "@codemirror/lang-javascript"
import { json } from "@codemirror/lang-json"
import { markdown } from "@codemirror/lang-markdown"
import { python } from "@codemirror/lang-python"
import { sql } from "@codemirror/lang-sql"
import { yaml } from "@codemirror/lang-yaml"
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language"
import { goToNextChunk, goToPreviousChunk, MergeView, unifiedMergeView } from "@codemirror/merge"
import { EditorState, type Extension } from "@codemirror/state"
import { EditorView, drawSelection, highlightActiveLine, keymap, lineNumbers } from "@codemirror/view"
import { tags as t } from "@lezer/highlight"
import { ArrowDown, ArrowUp, Columns2, FileText, LoaderCircle, Minus, Plus, Rows2, Save } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { api } from "@/lib/api"
import { diffTabPath, parseDiffTab, scm, type DiffContent } from "@/lib/scm-api"
import { cn } from "@/lib/utils"
import { openFile } from "@/state/runners"
import { useKivo } from "@/state/store"
import { useScm } from "./state"

/**
 * Renders a diff editor tab. Tabs whose path starts with "diff://" are diffs:
 *   diff://working/<path>        — working tree vs index (the right side is editable; ⌘S saves)
 *   diff://staged/<path>         — index vs HEAD
 *   diff://commit/<hash>/<path>  — a commit vs its first parent
 */

export const isDiffTab = (path: string | null | undefined) => !!path && path.startsWith("diff://")

// Same look as the code editor (src/features/code/CodeView.tsx), plus diff colours from the theme tokens.
const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "12.5px", backgroundColor: "var(--background)", color: "var(--foreground)" },
  ".cm-scroller": { fontFamily: "'Geist Mono Variable', ui-monospace, monospace", lineHeight: "1.65" },
  ".cm-content": { caretColor: "var(--foreground)", padding: "8px 0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--foreground)" },
  ".cm-gutters": { backgroundColor: "var(--background)", color: "color-mix(in oklch, var(--muted-foreground) 55%, transparent)", border: "none", paddingRight: "4px" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--foreground)" },
  ".cm-activeLine": { backgroundColor: "color-mix(in oklch, var(--muted) 45%, transparent)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "color-mix(in oklch, var(--info) 28%, transparent) !important" },
  "&.cm-focused": { outline: "none" },
  // Removed on the left / in deleted chunks, added on the right.
  "&.cm-merge-a .cm-changedLine, .cm-deletedChunk": { backgroundColor: "color-mix(in oklch, var(--destructive) 10%, transparent)" },
  "&.cm-merge-a .cm-changedText, .cm-deletedChunk .cm-deletedText": { background: "color-mix(in oklch, var(--destructive) 26%, transparent)" },
  "&.cm-merge-b .cm-changedLine, .cm-inlineChangedLine": { backgroundColor: "color-mix(in oklch, var(--success) 10%, transparent)" },
  "&.cm-merge-b .cm-changedText": { background: "color-mix(in oklch, var(--success) 26%, transparent)" },
  "&.cm-merge-a .cm-changedLineGutter, .cm-deletedLineGutter": { background: "var(--destructive)" },
  "&.cm-merge-b .cm-changedLineGutter, .cm-inlineChangedLineGutter": { background: "var(--success)" },
  ".cm-changeGutter": { width: "3px", paddingLeft: "0" },
  ".cm-collapsedLines": { background: "var(--muted)", color: "var(--muted-foreground)", fontSize: "11px", padding: "2px 12px" },
})

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword], color: "var(--foreground)", fontWeight: "600" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--success)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--info)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--muted-foreground)", fontStyle: "italic" },
  { tag: [t.className, t.typeName, t.definition(t.className)], color: "var(--warning)" },
  { tag: [t.propertyName, t.attributeName], color: "color-mix(in oklch, var(--foreground) 80%, var(--info))" },
  { tag: [t.meta, t.annotation, t.processingInstruction], color: "var(--muted-foreground)" },
  { tag: [t.operator, t.punctuation, t.bracket], color: "color-mix(in oklch, var(--foreground) 65%, transparent)" },
  { tag: t.heading, fontWeight: "600" },
])

function language(path: string): Extension[] {
  switch (path.split(".").pop()?.toLowerCase()) {
    case "py":
      return [python()]
    case "ts":
    case "mts":
    case "cts":
      return [javascript({ typescript: true })]
    case "tsx":
      return [javascript({ typescript: true, jsx: true })]
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return [javascript({ jsx: true })]
    case "json":
      return [json()]
    case "yaml":
    case "yml":
      return [yaml()]
    case "sql":
      return [sql()]
    case "md":
    case "markdown":
      return [markdown()]
    default:
      return []
  }
}

const INLINE_KEY = "kivo:diff-inline"
const readInline = () => {
  try {
    return localStorage.getItem(INLINE_KEY) === "1"
  } catch {
    return false
  }
}

export function DiffView({ tab }: { tab: string }) {
  // One editor instance per tab, so state (unsaved edits, loaded sides) never leaks between diffs.
  return <DiffEditor key={tab} tab={tab} />
}

function DiffEditor({ tab }: { tab: string }) {
  const target = parseDiffTab(tab)
  const [data, setData] = useState<DiffContent | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [inline, setInline] = useState(readInline)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const version = useScm((s) => s.version)
  const { act, busy, refresh } = useScm()
  const host = useRef<HTMLDivElement>(null)
  /** The editor holding the modified side (right pane, or the unified view). */
  const modifiedView = useRef<EditorView | null>(null)
  const dirtyRef = useRef(false)
  const dataRef = useRef<DiffContent | null>(null)
  useEffect(() => {
    dataRef.current = data
  }, [data])

  const kind = target?.kind
  const file = target?.path ?? ""
  const ref = target?.ref

  // Load, and reload whenever git status changes — but never clobber unsaved edits.
  useEffect(() => {
    if (!kind) return
    let cancelled = false
    scm.diff(kind, file, ref).then(
      (d) => {
        if (cancelled || dirtyRef.current) return
        const cur = dataRef.current
        if (cur && cur.original === d.original && cur.modified === d.modified && cur.editable === d.editable) return
        setData(d)
        setError(null)
      },
      (err: Error) => !cancelled && setError(err.message),
    )
    return () => {
      cancelled = true
    }
  }, [kind, file, ref, version])

  const save = useCallback(async () => {
    const view = modifiedView.current
    const d = dataRef.current
    if (!view || !d?.editable) return true
    const text = view.state.doc.toString()
    setSaving(true)
    try {
      await api.write(d.path, text)
      // Keep a plain editor tab of the same file in step, if it has no edits of its own.
      const s = useKivo.getState()
      const open = s.fileCache[d.path]
      if (open && open.content === open.saved) {
        s.editFile(d.path, text)
        s.markSaved(d.path)
      }
      dataRef.current = { ...d, modified: text }
      dirtyRef.current = false
      setDirty(false)
      void refresh()
    } catch (err) {
      toast.error(`Couldn't save ${d.path}`, { description: (err as Error).message })
    } finally {
      setSaving(false)
    }
    return true
  }, [refresh])

  // (Re)build the CodeMirror views when the content or layout changes.
  useEffect(() => {
    const el = host.current
    if (!el || !data || data.binary || data.tooLarge) return
    const editable = data.editable
    const base = [lineNumbers(), drawSelection(), highlightActiveLine(), theme, syntaxHighlighting(highlight), EditorView.lineWrapping, ...language(data.path)]
    const readOnly = [EditorState.readOnly.of(true), EditorView.editable.of(false)]
    const onEdit = EditorView.updateListener.of((u) => {
      if (!u.docChanged) return
      const isDirty = u.state.doc.toString() !== dataRef.current?.modified
      dirtyRef.current = isDirty
      setDirty(isDirty)
    })
    const saveKeys = keymap.of([
      {
        key: "Mod-s",
        preventDefault: true,
        run: () => {
          void save()
          return true
        },
      },
    ])
    const nav = keymap.of([
      { key: "Alt-ArrowDown", run: goToNextChunk },
      { key: "Alt-ArrowUp", run: goToPreviousChunk },
    ])
    const modExt = [...base, nav, ...(editable ? [saveKeys, onEdit] : readOnly)]
    const collapse = { margin: 3, minSize: 8 }
    let destroy: () => void
    if (inline) {
      const view = new EditorView({
        parent: el,
        doc: data.modified,
        extensions: [...modExt, unifiedMergeView({ original: data.original, mergeControls: false, highlightChanges: true, gutter: true, collapseUnchanged: collapse })],
      })
      modifiedView.current = view
      destroy = () => view.destroy()
    } else {
      const mv = new MergeView({
        parent: el,
        a: { doc: data.original, extensions: [...base, ...readOnly] },
        b: { doc: data.modified, extensions: modExt },
        highlightChanges: true,
        gutter: true,
        collapseUnchanged: collapse,
      })
      mv.dom.style.height = "100%"
      modifiedView.current = mv.b
      destroy = () => mv.destroy()
    }
    dirtyRef.current = false
    setDirty(false)
    return () => {
      modifiedView.current = null
      destroy()
    }
  }, [data, inline, save])

  if (!target) return <Message>This diff tab's address isn't recognised: {tab}</Message>

  const toggleInline = () => {
    if (dirty && !window.confirm("Switching layout discards your unsaved edits in this diff. Continue?")) return
    setInline((v) => {
      try {
        localStorage.setItem(INLINE_KEY, v ? "0" : "1")
      } catch {
        // storage unavailable — the choice just isn't remembered
      }
      return !v
    })
  }

  const sideLabel = kind === "commit" ? (ref ?? "").slice(0, 7) : kind === "staged" ? "Staged" : "Working Tree"
  const noChanges = data && !data.binary && !data.tooLarge && data.original === data.modified
  const other = kind === "working" ? "staged" : "working"

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <span className="min-w-0 truncate text-[12.5px]" title={data?.originalPath ? `${data.originalPath} → ${file}` : file}>
          {data?.originalPath && <span className="text-muted-foreground">{data.originalPath} → </span>}
          {file}
        </span>
        <span className={cn("shrink-0 rounded px-1.5 py-px text-[10.5px] font-medium", kind === "commit" ? "bg-muted font-mono text-muted-foreground" : "bg-info/15 text-info")}>{sideLabel}</span>
        {data && (
          <span className="hidden shrink-0 text-[11px] text-muted-foreground md:inline">
            {data.originalLabel} ↔ {data.modifiedLabel}
          </span>
        )}
        {dirty && <span className="shrink-0 text-[11px] text-warning">● unsaved</span>}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <HeaderButton label="Previous change (⌥↑)" onClick={() => modifiedView.current && goToPreviousChunk(modifiedView.current)}>
            <ArrowUp />
          </HeaderButton>
          <HeaderButton label="Next change (⌥↓)" onClick={() => modifiedView.current && goToNextChunk(modifiedView.current)}>
            <ArrowDown />
          </HeaderButton>
          <HeaderButton label={inline ? "Side-by-side" : "Inline"} onClick={toggleInline}>
            {inline ? <Columns2 /> : <Rows2 />}
          </HeaderButton>
          {data?.editable && (
            <HeaderButton label="Save (⌘S)" disabled={!dirty || saving} onClick={() => void save()}>
              {saving ? <LoaderCircle className="animate-spin" /> : <Save />}
            </HeaderButton>
          )}
          {kind === "working" && (
            <Button
              variant="ghost"
              size="xs"
              disabled={!!busy || dirty}
              title={dirty ? "Save first" : undefined}
              onClick={() => void act("Couldn't stage", () => scm.stage([file]))}
            >
              <Plus /> Stage
            </Button>
          )}
          {kind === "staged" && (
            <Button variant="ghost" size="xs" disabled={!!busy} onClick={() => void act("Couldn't unstage", () => scm.unstage([file]))}>
              <Minus /> Unstage
            </Button>
          )}
          <Button variant="ghost" size="xs" disabled={data?.modified === "" && data?.editable === false && kind !== "commit"} onClick={() => void openFile(file)}>
            <FileText /> Open file
          </Button>
        </div>
      </div>
      {error ? (
        <Message>{error}</Message>
      ) : !data ? (
        <Message>
          <LoaderCircle className="size-3.5 animate-spin" /> Loading diff…
        </Message>
      ) : data.binary ? (
        <Message>Binary file — no text diff to show.</Message>
      ) : data.tooLarge ? (
        <Message>This file is too large to diff here (2 MB max).</Message>
      ) : (
        <>
          {noChanges && kind !== "commit" && (
            <div className="flex shrink-0 items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-[12px] text-muted-foreground">
              No {kind === "working" ? "unstaged" : "staged"} changes in this file.
              <Button variant="link" size="xs" className="h-auto p-0 text-[12px]" onClick={() => useKivo.getState().openFile(diffTabPath(other, file), "")}>
                Show {other === "staged" ? "staged" : "working tree"} changes
              </Button>
            </div>
          )}
          <div ref={host} className="min-h-0 flex-1 overflow-hidden" />
        </>
      )}
    </div>
  )
}

function HeaderButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label={label} disabled={disabled} onClick={onClick}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function Message({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center gap-2 p-4 text-[12.5px] text-muted-foreground">{children}</div>
}
