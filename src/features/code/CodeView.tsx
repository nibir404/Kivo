import { useMemo, useRef, useState } from "react"
import CodeMirror, { EditorView, keymap, type ReactCodeMirrorRef } from "@uiw/react-codemirror"
import { javascript } from "@codemirror/lang-javascript"
import { json } from "@codemirror/lang-json"
import { markdown } from "@codemirror/lang-markdown"
import { python } from "@codemirror/lang-python"
import { sql } from "@codemirror/lang-sql"
import { yaml } from "@codemirror/lang-yaml"
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language"
import { tags as t } from "@lezer/highlight"
import { BookmarkPlus, Code2, FileCode2, HelpCircle, MessageSquare, PencilLine, Search, Sparkles, Wand2, X } from "lucide-react"
import { toast } from "sonner"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut, ContextMenuTrigger } from "@/components/ui/context-menu"
import type { KivoRef } from "@/core/types"
import { cn } from "@/lib/utils"
import { openFile, saveFile } from "@/state/runners"
import { useKivo } from "@/state/store"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { conceptIn, useCaptureActions } from "@/shell/capture"
import { useInlineEdit } from "./InlineEdit"

/**
 * Code mode: a pure editor. No explanations in the way — Explain & Capture lives in the
 * right-click menu (and ⌘E), so reading and editing code stays uncluttered.
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
  ".cm-matchingBracket": { backgroundColor: "var(--muted)", outline: "1px solid var(--border)" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--muted)", border: "none", color: "var(--muted-foreground)" },
  ".cm-tooltip": { backgroundColor: "var(--popover)", border: "1px solid var(--border)", borderRadius: "8px" },
  ".cm-panels": { backgroundColor: "var(--background)", color: "var(--foreground)", borderColor: "var(--border)" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in oklch, var(--warning) 30%, transparent)" },
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
  { tag: t.heading, fontWeight: "600" },
])

function languageFor(path: string) {
  const ext = path.split(".").pop()?.toLowerCase()
  switch (ext) {
    case "py":
      return { name: "Python", ext: [python()] }
    case "ts":
      return { name: "TypeScript", ext: [javascript({ typescript: true })] }
    case "tsx":
      return { name: "TypeScript JSX", ext: [javascript({ typescript: true, jsx: true })] }
    case "js":
    case "jsx":
      return { name: "JavaScript", ext: [javascript({ jsx: true })] }
    case "json":
      return { name: "JSON", ext: [json()] }
    case "yaml":
    case "yml":
      return { name: "YAML", ext: [yaml()] }
    case "sql":
      return { name: "SQL", ext: [sql()] }
    case "md":
      return { name: "Markdown", ext: [markdown()] }
    default:
      return { name: "Plain text", ext: [] }
  }
}

export function CodeView() {
  const { openFiles, activeFile, setActiveFile, closeFile, fileCache, editFile } = useKivo()
  const actions = useCaptureActions()
  const cm = useRef<ReactCodeMirrorRef>(null)
  const [cursor, setCursor] = useState({ line: 1, col: 1 })

  const inline = useInlineEdit(cm, activeFile)
  const file = activeFile ? fileCache[activeFile] : undefined
  const lang = useMemo(() => languageFor(activeFile ?? ""), [activeFile])

  /** The selection (or the current line) as a capturable ref. */
  const selectionRef = (): KivoRef | null => {
    const view = cm.current?.view
    if (!view || !activeFile) return null
    const sel = view.state.selection.main
    const line = view.state.doc.lineAt(sel.head)
    const text = sel.empty ? line.text.trim() : view.state.sliceDoc(sel.from, sel.to)
    if (!text) return null
    const startLine = view.state.doc.lineAt(sel.from).number
    return {
      kind: "code",
      id: `${activeFile}:${startLine}:${text.length}`,
      label: text.length > 42 ? `${text.slice(0, 40).trim()}…` : text.trim(),
      detail: `${activeFile}, line ${startLine}:\n${text}`,
      conceptId: conceptIn(text),
    }
  }

  const run = (verb: keyof typeof actions) => {
    const ref = selectionRef()
    if (!ref) return toast("Select some code first")
    actions[verb](ref)
  }

  const save = async () => {
    if (!activeFile) return
    try {
      await saveFile(activeFile)
      toast.success(`Saved ${activeFile.split("/").pop()}`)
    } catch (err) {
      toast.error("Save failed", { description: String((err as Error).message) })
    }
  }

  const extensions = useMemo(
    () => [
      ...lang.ext,
      ...inline.extensions,
      editorTheme,
      syntaxHighlighting(highlight),
      EditorView.lineWrapping,
      keymap.of([
        { key: "Mod-s", preventDefault: true, run: () => (save(), true) },
        { key: "Mod-e", preventDefault: true, run: () => (run("explain"), true) },
      ]),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lang, activeFile, inline.extensions],
  )

  if (!openFiles.length || !activeFile) {
    return (
      <CodeHome />
    )
  }

  const dirty = (p: string) => fileCache[p] && fileCache[p].content !== fileCache[p].saved

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b bg-sidebar">
        {openFiles.map((p) => (
          <div
            key={p}
            data-active={p === activeFile || undefined}
            className="group flex shrink-0 cursor-pointer items-center gap-2 border-r pr-1.5 pl-3 font-mono text-[12px] text-muted-foreground hover:text-foreground data-active:bg-background data-active:text-foreground"
            onClick={() => setActiveFile(p)}
            onMouseDown={(e) => e.button === 1 && closeFile(p)}
            title={p}
          >
            {p.split("/").pop()}
            <button
              aria-label={`Close ${p}`}
              className={cn("flex size-4 items-center justify-center rounded-sm hover:bg-accent", !dirty(p) && "opacity-0 group-hover:opacity-100 group-data-active:opacity-100")}
              onClick={(e) => {
                e.stopPropagation()
                if (dirty(p) && !confirm(`Discard unsaved changes to ${p}?`)) return
                closeFile(p)
              }}
            >
              {dirty(p) ? <span className="size-1.5 rounded-full bg-foreground group-hover:hidden" /> : null}
              <X className={cn("size-3", dirty(p) && "hidden group-hover:block")} />
            </button>
          </div>
        ))}
      </div>
      <div className="flex h-7 shrink-0 items-center gap-1 border-b px-3 font-mono text-[11px] text-muted-foreground">
        {activeFile.split("/").map((seg, i, all) => (
          <span key={i} className={cn(i === all.length - 1 && "text-foreground")}>
            {seg}
            {i < all.length - 1 && <span className="px-1 text-muted-foreground/50">/</span>}
          </span>
        ))}
      </div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="relative min-h-0 flex-1 overflow-hidden">
            {file && (
              <CodeMirror
                key={activeFile}
                ref={cm}
                value={file.content}
                height="100%"
                theme="none"
                extensions={extensions}
                basicSetup={{ highlightActiveLine: true, foldGutter: true, autocompletion: false, bracketMatching: true, indentOnInput: true }}
                onChange={(v) => editFile(activeFile, v)}
                onUpdate={(u) => {
                  if (u.selectionSet || u.docChanged) {
                    const pos = u.state.selection.main.head
                    const line = u.state.doc.lineAt(pos)
                    setCursor({ line: line.number, col: pos - line.from + 1 })
                  }
                }}
                className="h-full"
              />
            )}
            {inline.widget}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-52">
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
          <ContextMenuItem onSelect={save}>
            Save file <ContextMenuShortcut>⌘S</ContextMenuShortcut>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <div className="flex h-6 shrink-0 items-center gap-4 border-t px-3 font-mono text-[11px] text-muted-foreground">
        <span>{lang.name}</span>
        <span>
          Ln {cursor.line}, Col {cursor.col}
        </span>
        <span>UTF-8</span>
        <span className="ml-auto hidden sm:inline">⌘K edit with AI</span>
        <span>{dirty(activeFile) ? "● Unsaved — ⌘S" : "Saved"}</span>
      </div>
    </div>
  )
}

/** No file open: suggest where to start instead of an empty editor. */
function CodeHome() {
  const files = useKivo((s) => s.files)
  const build = useKivo((s) => s.build)
  const setCommandOpen = useKivo((s) => s.setCommandOpen)
  const built = build ? [...new Set(Object.values(build.runs).flatMap((r) => r.files))] : []
  const key = files.filter((f) => /(^|\/)(README\.md|main\.py|router\.py|service\.py|docker-compose\.yml|pyproject\.toml)$/.test(f))
  const suggested = [...new Set([...built.filter((f) => files.includes(f)), ...key])].slice(0, 7)

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
            <div className="px-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{built.length ? "From your last build" : "Good places to start"}</div>
            {suggested.map((f) => (
              <button key={f} onClick={() => openFile(f)} className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent">
                <FileCode2 className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate font-mono text-[12px]">{f.split("/").pop()}</span>
                <span className="ml-auto truncate pl-3 font-mono text-[11px] text-muted-foreground">{f.split("/").slice(0, -1).join("/")}</span>
              </button>
            ))}
          </div>
        )}
        <Button variant="outline" size="sm" className="w-full justify-start gap-2 font-normal text-muted-foreground" onClick={() => setCommandOpen(true)}>
          <Search /> Search files and commands
          <span className="ml-auto flex gap-1">
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd>
          </span>
        </Button>
        <div className="grid grid-cols-2 gap-2 text-[11px] text-muted-foreground">
          <div className="flex items-center gap-2 rounded-lg border p-2.5">
            <Kbd>⌘K</Kbd> or select code to edit with AI
          </div>
          <div className="flex items-center gap-2 rounded-lg border p-2.5">
            <Kbd>⌘E</Kbd> Explain selection
          </div>
        </div>
      </div>
    </div>
  )
}
