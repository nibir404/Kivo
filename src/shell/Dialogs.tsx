import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { CONCEPTS } from "@/core/concepts"
import { useKivo } from "@/state/store"

/** Note: store the system explanation next to the user's own interpretation. */
export function NoteDialog() {
  const { noteFor, openNote, saveToLibrary } = useKivo()
  const [text, setText] = useState("")
  useEffect(() => setText(""), [noteFor])
  const c = noteFor?.conceptId ? CONCEPTS[noteFor.conceptId] : undefined
  const system = noteFor?.detail ?? c?.what ?? ""

  return (
    <Dialog open={!!noteFor} onOpenChange={(v) => !v && openNote(null)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{c?.name ?? noteFor?.label}</DialogTitle>
          <DialogDescription>Write it in your own words. Kivo keeps both, and can use yours to explain things later.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-[13px]">
          {system && (
            <div className="space-y-1">
              <div className="text-[11px] font-medium text-muted-foreground">System explanation</div>
              <p className="rounded-md border bg-muted/40 p-2">{system}</p>
            </div>
          )}
          <div className="space-y-1">
            <div className="text-[11px] font-medium text-muted-foreground">My understanding</div>
            <Textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. “PostgreSQL is basically the permanent memory of my application.”" className="min-h-24" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => openNote(null)}>
            Cancel
          </Button>
          <Button
            disabled={!text.trim()}
            onClick={() => {
              if (!noteFor) return
              saveToLibrary(noteFor, text.trim())
              openNote(null)
              toast.success("Note saved to your Library")
            }}
          >
            Save note
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const FIELDS = [
  ["title", "Title", "API became slow"],
  ["problem", "Problem", "What went wrong?"],
  ["context", "Context", "Stack, scale, constraints"],
  ["investigation", "Investigation", "What you looked at and found"],
  ["decision", "Decision", "What you chose, and why"],
  ["implementation", "Implementation", "What changed"],
  ["outcome", "Outcome", "What happened after"],
  ["lesson", "My takeaway", "The one thing to remember"],
] as const

export function ExperienceDialog() {
  const { experienceDraftOpen, setExperienceDraftOpen, addExperience, project, selection } = useKivo()
  const blank = Object.fromEntries(FIELDS.map(([k]) => [k, ""])) as Record<(typeof FIELDS)[number][0], string>
  const [form, setForm] = useState(blank)
  const [before, setBefore] = useState("")
  const [after, setAfter] = useState("")

  useEffect(() => {
    if (!experienceDraftOpen) return
    // Prefill from a runtime selection — e.g. a slow query captured in Observe.
    if (selection?.kind === "span") {
      setForm({ ...blank, title: `${selection.label} was slow`, problem: selection.detail ?? "", context: "FastAPI + PostgreSQL" })
    } else setForm(blank)
    setBefore("")
    setAfter("")
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [experienceDraftOpen])

  return (
    <Dialog open={experienceDraftOpen} onOpenChange={setExperienceDraftOpen}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Capture an experience</DialogTitle>
          <DialogDescription>Not just a note — what happened, what you tried, and what you learned.</DialogDescription>
        </DialogHeader>
        <div className="grid max-h-[60vh] gap-3 overflow-y-auto pr-1 text-[13px]">
          {FIELDS.map(([k, label, ph]) => (
            <div key={k} className="space-y-1">
              <div className="text-[11px] font-medium text-muted-foreground">{label}</div>
              {k === "title" || k === "context" ? (
                <Input value={form[k]} placeholder={ph} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
              ) : (
                <Textarea value={form[k]} placeholder={ph} className="min-h-14" onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
              )}
            </div>
          ))}
          <div className="grid grid-cols-2 gap-2">
            <Input value={before} onChange={(e) => setBefore(e.target.value)} placeholder="Metric before (e.g. 180ms)" />
            <Input value={after} onChange={(e) => setAfter(e.target.value)} placeholder="Metric after (e.g. 42ms)" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setExperienceDraftOpen(false)}>
            Cancel
          </Button>
          <Button
            disabled={!form.title.trim() || !form.lesson.trim()}
            onClick={() => {
              const text = Object.values(form).join(" ").toLowerCase()
              addExperience({
                ...form,
                metric: before && after ? { label: "Latency", before, after } : undefined,
                concepts: Object.values(CONCEPTS)
                  .filter((c) => text.includes(c.name.toLowerCase()))
                  .map((c) => c.id),
                project,
                visibility: "private",
                useAsContext: true,
              })
              setExperienceDraftOpen(false)
              toast.success("Experience saved", { description: "Kivo will bring it up when a similar pattern appears." })
            }}
          >
            Save experience
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
