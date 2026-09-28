import { useMemo, useRef, useState, type RefObject } from "react"
import { AtSign, CornerDownLeft, FileText, Square, TextSelect, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { useKivo } from "@/state/store"
import { fuzzyFiles } from "./mentions"
import type { Mention } from "./store"

type Option = { key: string; label: string; hint?: string; mention: Mention }

/**
 * The AI input for Ask and Agent: Enter sends, Shift+Enter is a newline, and typing @ opens a
 * fuzzy file picker (plus @open for the editor's file and @selection for selected code). Picked
 * items become chips above the input; their contents are attached to the message.
 */
export function Composer({
  value,
  onChange,
  mentions,
  onMentions,
  onSubmit,
  placeholder,
  running,
  onStop,
  inputRef,
}: {
  value: string
  onChange: (v: string) => void
  mentions: Mention[]
  onMentions: (m: Mention[]) => void
  onSubmit: () => void
  placeholder: string
  running?: boolean
  onStop?: () => void
  inputRef?: RefObject<HTMLTextAreaElement | null>
}) {
  const files = useKivo((s) => s.files)
  const activeFile = useKivo((s) => s.activeFile)
  const selection = useKivo((s) => s.selection)
  const own = useRef<HTMLTextAreaElement>(null)
  const ref = inputRef ?? own
  const [query, setQuery] = useState<string | null>(null)
  const [index, setIndex] = useState(0)

  const options = useMemo<Option[]>(() => {
    if (query === null) return []
    const q = query.toLowerCase()
    const out: Option[] = []
    if (activeFile && "open".startsWith(q)) out.push({ key: "@open", label: "@open", hint: activeFile, mention: { kind: "open", path: activeFile } })
    if (selection?.kind === "code" && selection.detail && "selection".startsWith(q))
      out.push({ key: "@selection", label: "@selection", hint: selection.label, mention: { kind: "selection", label: selection.label, text: selection.detail } })
    for (const f of fuzzyFiles(query, files, 8)) out.push({ key: f, label: f.split("/").pop()!, hint: f.split("/").slice(0, -1).join("/"), mention: { kind: "file", path: f } })
    return out
  }, [query, files, activeFile, selection])

  /** Re-read the "@query" right before the caret. */
  const sync = (text: string, caret: number) => {
    const m = text.slice(0, caret).match(/(?:^|\s)@([^\s@]*)$/)
    setQuery(m ? m[1] : null)
    setIndex(0)
  }

  const pick = (o: Option) => {
    const el = ref.current
    const caret = el?.selectionStart ?? value.length
    const before = value.slice(0, caret).replace(/@[^\s@]*$/, "")
    const next = before + value.slice(caret)
    onChange(next)
    const same = (a: Mention, b: Mention) => a.kind === b.kind && (a.kind === "selection" || (a as { path: string }).path === (b as { path: string }).path)
    if (!mentions.some((m) => same(m, o.mention))) onMentions([...mentions, o.mention])
    setQuery(null)
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(before.length, before.length)
    })
  }

  const open = query !== null && options.length > 0

  return (
    <div className="relative space-y-1.5">
      {mentions.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {mentions.map((m, i) => {
            const Icon = m.kind === "selection" ? TextSelect : FileText
            const label = m.kind === "file" ? m.path.split("/").pop() : m.kind === "open" ? `open · ${m.path.split("/").pop()}` : `selection · ${m.label}`
            return (
              <span key={i} title={m.kind === "selection" ? m.text.slice(0, 300) : m.path} className="flex h-5 max-w-full items-center gap-1 rounded-md border bg-muted/60 pr-0.5 pl-1.5 font-mono text-[11px]">
                <Icon className="size-3 shrink-0 text-muted-foreground" />
                <span className="truncate">{label}</span>
                <button aria-label={`Remove ${label}`} className="flex size-4 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => onMentions(mentions.filter((_, k) => k !== i))}>
                  <X className="size-3" />
                </button>
              </span>
            )
          })}
        </div>
      )}
      {open && (
        <div role="listbox" className="absolute bottom-full left-0 z-20 mb-1 max-h-64 w-full overflow-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-md">
          {options.map((o, i) => (
            <button
              key={o.key}
              role="option"
              aria-selected={i === index}
              onMouseDown={(e) => {
                e.preventDefault()
                pick(o)
              }}
              onMouseEnter={() => setIndex(i)}
              className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1 text-left", i === index && "bg-accent")}
            >
              {o.mention.kind === "selection" ? <TextSelect className="size-3.5 shrink-0 text-muted-foreground" /> : o.mention.kind === "open" ? <AtSign className="size-3.5 shrink-0 text-muted-foreground" /> : <FileText className="size-3.5 shrink-0 text-muted-foreground" />}
              <span className="truncate font-mono text-[12px]">{o.label}</span>
              {o.hint && <span className="ml-auto truncate pl-2 font-mono text-[11px] text-muted-foreground">{o.hint}</span>}
            </button>
          ))}
        </div>
      )}
      <div className="relative">
        <Textarea
          ref={ref}
          value={value}
          onChange={(e) => {
            onChange(e.target.value)
            sync(e.target.value, e.target.selectionStart)
          }}
          onClick={(e) => sync(value, e.currentTarget.selectionStart)}
          onBlur={() => setQuery(null)}
          onKeyDown={(e) => {
            if (open) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault()
                setIndex((i) => (i + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length)
                return
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault()
                pick(options[index])
                return
              }
              if (e.key === "Escape") {
                e.preventDefault()
                setQuery(null)
                return
              }
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              if (!running) onSubmit()
            }
          }}
          placeholder={placeholder}
          className="min-h-16 resize-none pr-10 text-[13px]"
        />
        {running && onStop ? (
          <Button size="icon-xs" variant="secondary" className="absolute right-2 bottom-2" onClick={onStop} aria-label="Stop">
            <Square className="fill-current" />
          </Button>
        ) : (
          <Button size="icon-xs" className="absolute right-2 bottom-2" onClick={onSubmit} aria-label="Send">
            <CornerDownLeft />
          </Button>
        )}
      </div>
    </div>
  )
}
