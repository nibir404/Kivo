import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react"
import CodeMirror, { EditorView, keymap, type ReactCodeMirrorRef } from "@uiw/react-codemirror"
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language"
import { openSearchPanel, search } from "@codemirror/search"
import { Prec } from "@codemirror/state"
import { rectangularSelection } from "@codemirror/view"
import { tags as t } from "@lezer/highlight"
import { BookmarkPlus, ChevronRight, Code2, FileCode2, HelpCircle, MessageSquare, PencilLine, Search, SearchCode, Sparkles, TriangleAlert, Wand2 } from "lucide-react"
import { toast } from "sonner"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut, ContextMenuTrigger } from "@/components/ui/context-menu"
import type { KivoRef } from "@kivo/core/types"
import { activeView } from "@/features/editor/activeView"
import { EditorGlobal } from "@/features/editor/Sidebar"
import { useEditor } from "@/features/editor/store"
import { symbolAt, symbolsOf } from "@/features/editor/symbols"
import { keepMine, reloadFromDisk } from "@/features/editor/tabs"
import { DiffView, isDiffTab } from "@/features/scm/DiffView"
import { cn } from "@/lib/utils"
import { openFile, saveFile } from "@/state/runners"
import { useKivo } from "@/state/store"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { conceptIn, useCaptureActions } from "@/shell/capture"
import { useInlineEdit } from "./InlineEdit"
import { aiAutocomplete } from "./autocomplete"
import { detectIndent, indentExtensions, languageFor } from "./languages"
import { TabBar } from "./TabBar"
import { useTabShortcuts } from "./tabActions"
import { initialStateFor, rememberScroll, rememberState, savedScroll } from "./viewState"

/**
 * Code mode: a pure editor. No explanations in the way — Explain & Capture lives in the
 * right-click menu (and ⌘E), so reading and editing code stays uncluttered. Editing works like
 * a desktop editor: multi-cursor (⌘D, ⌥-click, ⌘⌥↑↓, ⇧⌥-drag for columns), ⌘F / ⌘⌥F find and
 * replace, ⌘/ comments, ⌥↑↓ move and ⇧⌥↓ duplicate lines, folding, per-tab undo history.
 */

const editorTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "12.5px", backgroundColor: "var(--background)", color: "var(--foreground)" },
  ".cm-scroller": { fontFamily: "'Geist Mono Variable', ui-monospace, monospace", lineHeight: "1.65" },
  ".cm-content": { caretColor: "var(--foreground)", padding: "8px 0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--foreground)" },
  ".cm-gutters": { backgroundColor: "var(--background)", color: "color-mix(in oklch, var(--muted-foreground) 55%, transparent)", border: "none", paddingRight: "8px" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--foreground)" },
  ".cm-activeLine": { backgroundColor: "color-mix(in oklch, var(--muted) 45%, transparent)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "color-mix(in oklch, var(--info) 28%, transparent) !important" },
  ".cm-selectionMatch": { backgroundColor: "color-mix(in oklch, var(--info) 14%, transparent)" },
  ".cm-matchingBracket": { backgroundColor: "var(--muted)", outline: "1px solid var(--border)" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--muted)", border: "none", color: "var(--muted-foreground)", padding: "0 4px", borderRadius: "3px" },
  // Fold markers appear on gutter hover, like VS Code.
  ".cm-foldGutter .cm-gutterElement": { opacity: "0", transition: "opacity 120ms", cursor: "pointer", padding: "0 2px" },
  ".cm-gutters:hover .cm-foldGutter .cm-gutterElement": { opacity: "1" },
  ".cm-tooltip": { backgroundColor: "var(--popover)", border: "1px solid var(--border)", borderRadius: "8px" },
  ".cm-panels": { backgroundColor: "var(--sidebar)", color: "var(--foreground)", borderColor: "var(--border)" },
  ".cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in oklch, var(--warning) 30%, transparent)", borderRadius: "2px" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "color-mix(in oklch, var(--warning) 60%, transparent)", outline: "1px solid var(--warning)" },
  // In-file find / replace (⌘F, ⌘⌥F), restyled to match the app.
  ".cm-panel.cm-search": { padding: "4px 36px 4px 8px", fontFamily: "inherit", fontSize: "12px", position: "relative" },
  ".cm-search .cm-textfield": { height: "24px", margin: "2px 3px", verticalAlign: "middle", padding: "0 8px", width: "220px", border: "1px solid var(--border)", borderRadius: "6px", backgroundColor: "var(--background)", color: "var(--foreground)", fontFamily: "'Geist Mono Variable', ui-monospace, monospace", fontSize: "12px", outline: "none" },
  ".cm-search .cm-textfield:focus": { borderColor: "var(--ring)", boxShadow: "0 0 0 1px color-mix(in oklch, var(--ring) 40%, transparent)" },
  ".cm-search .cm-button": { height: "24px", margin: "2px 3px", verticalAlign: "middle", padding: "0 8px", border: "1px solid var(--border)", borderRadius: "6px", backgroundImage: "none", backgroundColor: "var(--background)", color: "var(--foreground)", fontSize: "11.5px", textTransform: "none" },
  ".cm-search .cm-button:hover": { backgroundColor: "var(--accent)" },
  ".cm-search .cm-button:active": { backgroundImage: "none" },
  ".cm-search label": { display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "11.5px", color: "var(--muted-foreground)", margin: "2px 4px", verticalAlign: "middle" },
  ".cm-search input[type=checkbox]": { accentColor: "var(--info)", margin: "0" },
  ".cm-search button[name=close]": { position: "absolute", top: "6px", right: "8px", width: "22px", height: "22px", border: "none", borderRadius: "6px", background: "transparent", color: "var(--muted-foreground)", fontSize: "16px", lineHeight: "1", cursor: "pointer" },
  ".cm-search button[name=close]:hover": { backgroundColor: "var(--accent)", color: "var(--foreground)" },
})

/** Restrained, monochrome-first syntax colours; hue only where it carries meaning. */
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword], color: "var(--foreground)", fontWeight: "600" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--success)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--info)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--muted-foreground)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName))], color: "var(--foreground)", textDecoration: "none" },
  { tag: [t.className, t.typeName, t.definition(t.className)], color: "var(--warning)" },
  { tag: [t.propertyName, t.attributeName], color: "color-mix(in oklch, var(--foreground) 80%, var(--info))" },
  { tag: [t.meta, t.annotation, t.processingInstruction], color: "var(--muted-foreground)" },
  { tag: [t.variableName, t.name], color: "var(--foreground)" },
  { tag: [t.operator, t.punctuation, t.bracket], color: "color-mix(in oklch, var(--foreground) 65%, transparent)" },
  { tag: [t.tagName], color: "color-mix(in oklch, var(--foreground) 80%, var(--warning))" },
  { tag: [t.inserted], color: "var(--success)" },
  { tag: [t.deleted], color: "var(--destructive)" },
  { tag: t.heading, fontWeight: "600" },
])

/** Editing behaviour shared by every file (languages and AI features are added per file). */
const editing = [
  search({ top: true }),
  // ⌥-click adds a cursor (VS Code); ⇧⌥-drag makes a column selection.
  EditorView.clickAddsSelectionRange.of((e) => e.altKey),
  rectangularSelection({ eventFilter: (e) => e.altKey && e.shiftKey }),
  Prec.high(
    keymap.of([
      {
        key: "Mod-Alt-f",
        preventDefault: true,
        run: (v) => {
          openSearchPanel(v)
          requestAnimationFrame(() => v.dom.querySelector<HTMLInputElement>(".cm-search input[name=replace]")?.focus())
          return true
        },
      },
    ]),
  ),
]

export function CodeView() {
  const openFiles = useKivo((s) => s.openFiles)
  const activeFile = useKivo((s) => s.activeFile)
  useTabShortcuts()

  // Remember what was opened, for Quick Open's "recently opened".
  useEffect(() => {
    if (activeFile && !isDiffTab(activeFile)) useEditor.getState().touchRecent(activeFile)
  }, [activeFile])

  if (!openFiles.length || !activeFile)
    return (
      <>
        <CodeHome />
        <EditorGlobal />
      </>
    )

  return (
    <div className="flex h-full flex-col">
      <EditorGlobal />
      <TabBar />
      {isDiffTab(activeFile) ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <DiffView tab={activeFile} />
        </div>
      ) : (
        <FileEditor path={activeFile} />
      )}
    </div>
  )
}

interface CursorInfo {
  line: number
  col: number
  selections: number
  selected: number
}

function FileEditor({ path }: { path: string }) {
  const file = useKivo((s) => s.fileCache[path])
  const editFile = useKivo((s) => s.editFile)
  const conflict = useEditor((s) => s.conflicts.includes(path))
  const reveal = useEditor((s) => s.reveal)
  const actions = useCaptureActions()
  const cm = useRef<ReactCodeMirrorRef>(null)
  const [cursor, setCursor] = useState<CursorInfo>({ line: 1, col: 1, selections: 1, selected: 0 })
  const [viewTick, setViewTick] = useState(0)

  const inline = useInlineEdit(cm, path)
  const lang = useMemo(() => languageFor(path), [path])
  // Indentation is detected once per opened file, so typing doesn't flip it mid-edit.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const indent = useMemo(() => detectIndent(file?.content ?? ""), [path, !!file])
  const eol = useMemo(() => (file?.content.includes("\r\n") ? "CRLF" : "LF"), [file?.content])
  const deferred = useDeferredValue(file?.content ?? "")
  const symbols = useMemo(() => symbolsOf(path, deferred), [path, deferred])
  const crumbs = useMemo(() => symbolAt(symbols, deferred, cursor.line), [symbols, deferred, cursor.line])

  /** The selection (or the current line) as a capturable ref. */
  const selectionRef = (): KivoRef | null => {
    const view = cm.current?.view
    if (!view) return null
    const sel = view.state.selection.main
    const line = view.state.doc.lineAt(sel.head)
    const text = sel.empty ? line.text.trim() : view.state.sliceDoc(sel.from, sel.to)
    if (!text) return null
    const startLine = view.state.doc.lineAt(sel.from).number
    return {
      kind: "code",
      id: `${path}:${startLine}:${text.length}`,
      label: text.length > 42 ? `${text.slice(0, 40).trim()}…` : text.trim(),
      detail: `${path}, line ${startLine}:\n${text}`,
      conceptId: conceptIn(text),
    }
  }

  const run = (verb: keyof typeof actions) => {
    const ref = selectionRef()
    if (!ref) return toast("Select some code first")
    actions[verb](ref)
  }

  const save = async () => {
    try {
      await saveFile(path)
      useEditor.getState().setConflict(path, false)
      toast.success(`Saved ${path.split("/").pop()}`)
    } catch (err) {
      toast.error("Save failed", { description: String((err as Error).message) })
    }
  }

  const extensions = useMemo(
    () => [
      ...lang.ext,
      ...inline.extensions,
      aiAutocomplete(),
      ...indentExtensions(indent),
      ...editing,
      editorTheme,
      syntaxHighlighting(highlight),
      EditorView.lineWrapping,
      keymap.of([
        { key: "Mod-s", preventDefault: true, run: () => (save(), true) },
        { key: "Mod-e", preventDefault: true, run: () => (run("explain"), true) },
      ]),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lang, path, indent, inline.extensions],
  )

  // Put the cursor where a search result / go-to asked for, once the editor for that file exists.
  useEffect(() => {
    const view = cm.current?.view
    // Right after a tab switch the ref can still hold the previous file's (destroyed) editor.
    if (!reveal || reveal.path !== path || !view || !view.dom.isConnected) return
    const doc = view.state.doc
    const line = doc.line(Math.min(Math.max(1, reveal.line), doc.lines))
    const from = Math.min(line.from + reveal.col, line.to)
    const to = Math.min(from + reveal.len, line.to)
    view.dispatch({ selection: { anchor: from, head: to }, effects: EditorView.scrollIntoView(from, { y: "center" }) })
    view.focus()
    useEditor.getState().clearReveal()
  }, [reveal, path, viewTick])

  useEffect(
    () => () => {
      if (activeView.current && !activeView.current.dom.isConnected) activeView.current = null
    },
    [path],
  )

  const initialState = useMemo(() => (file ? initialStateFor(path, file.content) : undefined), [path]) // eslint-disable-line react-hooks/exhaustive-deps
  const segments = path.split("/")

  return (
    <>
      <div className="flex h-7 shrink-0 items-center gap-0.5 overflow-hidden border-b px-3 font-mono text-[11px] whitespace-nowrap text-muted-foreground">
        {segments.map((seg, i) => {
          const last = i === segments.length - 1
          const target = segments.slice(0, i + 1).join("/")
          return (
            <span key={i} className="flex shrink-0 items-center gap-0.5">
              <button
                className={cn("rounded px-0.5 hover:bg-accent hover:text-foreground", last && "text-foreground")}
                title={last ? "Go to symbol (⌘⇧O)" : `Reveal ${target} in the explorer`}
                onClick={() => {
                  const ed = useEditor.getState()
                  if (last) return ed.setPalette("symbol")
                  ed.setView("explorer")
                  ed.expandTo(`${target}/x`)
                  ed.select(target)
                }}
              >
                {seg}
              </button>
              {!last && <ChevronRight className="size-3 opacity-50" />}
            </span>
          )
        })}
        {crumbs.map((s) => (
          <span key={`${s.line}:${s.name}`} className="flex min-w-0 items-center gap-0.5">
            <ChevronRight className="size-3 shrink-0 opacity-50" />
            <button className="truncate rounded px-0.5 hover:bg-accent hover:text-foreground" onClick={() => useEditor.getState().revealAt({ path, line: s.line, col: s.col, len: s.name.length })}>
              {s.name}
            </button>
          </span>
        ))}
      </div>
      {conflict && (
        <div className="flex shrink-0 items-center gap-2 border-b bg-warning/10 px-3 py-1.5 text-[12px]">
          <TriangleAlert className="size-3.5 shrink-0 text-warning" />
          <span className="min-w-0 flex-1 truncate">
            <span className="font-mono">{path.split("/").pop()}</span> changed on disk while you have unsaved edits.
          </span>
          <Button size="xs" variant="outline" onClick={() => reloadFromDisk(path)}>
            Reload from disk
          </Button>
          <Button size="xs" variant="ghost" onClick={() => keepMine(path)}>
            Keep mine
          </Button>
        </div>
      )}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="relative min-h-0 flex-1 overflow-hidden">
            {file && (
              <CodeMirror
                key={path}
                ref={cm}
                value={file.content}
                initialState={initialState}
                height="100%"
                theme="none"
                extensions={extensions}
                basicSetup={{ highlightActiveLine: true, foldGutter: true, autocompletion: false, bracketMatching: true, closeBrackets: true, indentOnInput: true, rectangularSelection: false, crosshairCursor: false }}
                onChange={(v) => editFile(path, v)}
                onCreateEditor={(view) => {
                  activeView.current = view
                  view.scrollDOM.addEventListener("scroll", () => rememberScroll(path, view.scrollDOM.scrollTop), { passive: true })
                  const top = savedScroll(path)
                  const pendingReveal = useEditor.getState().reveal?.path === path
                  if (top && !pendingReveal) requestAnimationFrame(() => (view.scrollDOM.scrollTop = top))
                  setViewTick((n) => n + 1)
                }}
                onUpdate={(u) => {
                  rememberState(path, u.state)
                  if (u.selectionSet || u.docChanged) {
                    const sel = u.state.selection
                    const pos = sel.main.head
                    const line = u.state.doc.lineAt(pos)
                    setCursor({ line: line.number, col: pos - line.from + 1, selections: sel.ranges.length, selected: sel.ranges.reduce((n, r) => n + r.to - r.from, 0) })
                  }
                }}
                className="h-full"
              />
            )}
            {inline.widget}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-56">
          <ContextMenuItem onSelect={() => setTimeout(inline.start, 0)}>
            <Wand2 /> Edit with AI <ContextMenuShortcut>⌘K</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => run("explain")}>
            <Sparkles /> Explain <ContextMenuShortcut>⌘E</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => run("why")}>
            <HelpCircle /> Why is this here?
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => run("ask")}>
            <MessageSquare /> Ask AI
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => run("note")}>
            <PencilLine /> Note
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => run("save")}>
            <BookmarkPlus /> Save to Library
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => useEditor.getState().setPalette("symbol")}>
            Go to Symbol… <ContextMenuShortcut>⌘⇧O</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() => {
              const v = cm.current?.view
              const sel = v?.state.selection.main
              const text = v && sel && !sel.empty ? v.state.sliceDoc(sel.from, sel.to) : undefined
              useEditor.getState().focusSearch(text && !text.includes("\n") ? text : undefined)
            }}
          >
            <SearchCode /> Find in Files <ContextMenuShortcut>⌘⇧F</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem onSelect={save}>
            Save file <ContextMenuShortcut>⌘S</ContextMenuShortcut>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <div className="flex h-6 shrink-0 items-center gap-4 border-t px-3 font-mono text-[11px] text-muted-foreground">
        <button className="hover:text-foreground" title="Go to line (⌃G)" onClick={() => useEditor.getState().setPalette("line")}>
          Ln {cursor.line}, Col {cursor.col}
          {cursor.selections > 1 ? ` (${cursor.selections} selections)` : cursor.selected ? ` (${cursor.selected} selected)` : ""}
        </button>
        <span title="Detected from the file">{indent.tabs ? "Tabs" : `Spaces: ${indent.size}`}</span>
        <span>UTF-8</span>
        <span>{eol}</span>
        <span>{lang.name}</span>
        <span className="ml-auto hidden lg:inline">⌘K edit with AI · ⌘P files · ⌘⇧F search</span>
        <span>{file && file.content !== file.saved ? "● Unsaved — ⌘S" : "Saved"}</span>
      </div>
    </>
  )
}

/** No file open: suggest where to start instead of an empty editor. */
function CodeHome() {
  const files = useKivo((s) => s.files)
  const build = useKivo((s) => s.build)
  const recent = useEditor((s) => s.recent)
  const built = build ? [...new Set(Object.values(build.runs).flatMap((r) => r.files))] : []
  const key = files.filter((f) => /(^|\/)(README\.md|main\.py|router\.py|service\.py|docker-compose\.yml|pyproject\.toml)$/.test(f))
  const recentHere = recent.filter((f) => files.includes(f))
  const suggested = [...new Set([...recentHere, ...built.filter((f) => files.includes(f)), ...key])].slice(0, 7)

  return (
    <div className="flex h-full items-center justify-center overflow-auto p-8">
      <div className="kivo-in w-full max-w-md space-y-6">
        <div className="space-y-1.5">
          <Code2 className="size-5 text-muted-foreground" />
          <h2 className="pt-2 text-lg font-semibold tracking-tight">Open a file to start</h2>
          <p className="text-[13px] text-muted-foreground">Pick one below, browse the explorer, or search by name.</p>
        </div>
        {suggested.length > 0 && (
          <div className="space-y-px">
            <div className="px-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{recentHere.length ? "Recently opened" : built.length ? "From your last build" : "Good places to start"}</div>
            {suggested.map((f) => (
              <button key={f} onClick={() => openFile(f)} className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent">
                <FileCode2 className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate font-mono text-[12px]">{f.split("/").pop()}</span>
                <span className="ml-auto truncate pl-3 font-mono text-[11px] text-muted-foreground">{f.split("/").slice(0, -1).join("/")}</span>
              </button>
            ))}
          </div>
        )}
        <Button variant="outline" size="sm" className="w-full justify-start gap-2 font-normal text-muted-foreground" onClick={() => useEditor.getState().setPalette("files")}>
          <Search /> Go to file
          <span className="ml-auto flex gap-1">
            <Kbd>⌘</Kbd>
            <Kbd>P</Kbd>
          </span>
        </Button>
        <div className="grid grid-cols-2 gap-2 text-[11px] text-muted-foreground">
          <div className="flex items-center gap-2 rounded-lg border p-2.5">
            <Kbd>⌘K</Kbd> or select code to edit with AI
          </div>
          <div className="flex items-center gap-2 rounded-lg border p-2.5">
            <Kbd>⌘E</Kbd> Explain selection
          </div>
          <div className="flex items-center gap-2 rounded-lg border p-2.5">
            <Kbd>⌘⇧F</Kbd> Find in files
          </div>
          <div className="flex items-center gap-2 rounded-lg border p-2.5">
            <Kbd>⌘⇧T</Kbd> Reopen closed tab
          </div>
        </div>
      </div>
    </div>
  )
}
