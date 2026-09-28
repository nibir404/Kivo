import { useState } from "react"
import { useTheme } from "next-themes"
import {
  BookmarkPlus,
  Boxes,
  Bug,
  Check,
  FileCode2,
  GraduationCap,
  Keyboard,
  Settings,
  HelpCircle,
  History,
  Lightbulb,
  MessageSquare,
  Moon,
  Network,
  Play,
  Search,
  Server,
  Sparkles,
  Wand2,
} from "lucide-react"
import { toast } from "sonner"
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command"
import { CONCEPTS } from "@/core/concepts"
import { ask, openFile, understand } from "@/state/runners"
import { useKivo } from "@/state/store"
import { useCaptureActions } from "./capture"
import { startNewService } from "./Preferences"
import { askInWorkspace } from "@/features/workspace/hooks"
import { workspace, WORKSPACES } from "@/features/workspace/registry"
import { LEVELS, MODES } from "./TopBar"

/** Universal command interface. Unmatched input is treated as natural language: build it, or ask about it. */
export function CommandMenu() {
  const k = useKivo()
  const actions = useCaptureActions()
  const { resolvedTheme, setTheme } = useTheme()
  const [q, setQ] = useState("")

  const run = (fn: () => void) => {
    fn()
    k.setCommandOpen(false)
    setQ("")
  }
  const needsSelection = (fn: (r: NonNullable<typeof k.selection>) => void) => () => {
    if (k.selection) fn(k.selection)
    else toast("Select something first", { description: "Click any service, node, runtime event or text." })
  }
  const latestError = k.traces.find((t) => t.status >= 400)

  return (
    <CommandDialog
      open={k.commandOpen}
      onOpenChange={(v) => {
        k.setCommandOpen(v)
        if (!v) setQ("")
      }} className="sm:max-w-xl">
      <Command>
        <CommandInput value={q} onValueChange={setQ} placeholder="Describe what you want, or type a command…" />
        <CommandList className="max-h-[420px]">
          {q.trim().length <= 3 && <CommandEmpty>No command matches.</CommandEmpty>}
          {q.trim().length > 3 && (
            <CommandGroup heading="Natural language" forceMount>
              {k.discipline === "software" ? (
                <CommandItem forceMount value={`__build ${q}`} onSelect={() => run(() => understand(q))}>
                  <Wand2 />
                  Build: <span className="truncate text-muted-foreground">{q}</span>
                  <CommandShortcut>↵</CommandShortcut>
                </CommandItem>
              ) : (
                // Building services is Software's flow; elsewhere the question is asked in the workspace's context.
                <CommandItem forceMount value={`__wsask ${q}`} onSelect={() => run(() => askInWorkspace(workspace(k.discipline), q))}>
                  <MessageSquare />
                  Ask in {workspace(k.discipline).label}: <span className="truncate text-muted-foreground">{q}</span>
                  <CommandShortcut>↵</CommandShortcut>
                </CommandItem>
              )}
              <CommandItem
                forceMount
                value={`__ask ${q}`}
                onSelect={() =>
                  run(() => {
                    k.select(k.selection, "ai")
                    ask(q, k.selection)
                  })
                }
              >
                <MessageSquare />
                Ask Kivo: <span className="truncate text-muted-foreground">{q}</span>
              </CommandItem>
            </CommandGroup>
          )}
          <CommandGroup heading="Actions">
            <CommandItem onSelect={() => run(startNewService)}>
              <Sparkles /> Create service
            </CommandItem>
            <CommandItem onSelect={() => run(needsSelection(actions.explain))}>
              <Lightbulb /> Explain selected <CommandShortcut>E</CommandShortcut>
            </CommandItem>
            <CommandItem onSelect={() => run(needsSelection(actions.why))}>
              <HelpCircle /> Why is this here? <CommandShortcut>W</CommandShortcut>
            </CommandItem>
            <CommandItem onSelect={() => run(needsSelection(actions.save))}>
              <BookmarkPlus /> Save to library <CommandShortcut>S</CommandShortcut>
            </CommandItem>
            <CommandItem onSelect={() => run(() => k.setMode("learn"))}>
              <Network /> Show architecture
            </CommandItem>
            <CommandItem onSelect={() => run(() => { if (!k.runtimeLive) k.toggleRuntime(); k.setMode("observe") })}>
              <Play /> {k.runtimeLive ? "Watch demo traffic" : "Start demo traffic"}
            </CommandItem>
            <CommandItem
              onSelect={() =>
                run(() => {
                  if (!latestError) return toast("No recent errors")
                  const span = latestError.spans.find((s) => s.status === "error") ?? latestError.spans[0]
                  k.selectTrace(latestError.id)
                  k.setMode("observe")
                  k.select({ kind: "span", id: span.id, label: span.name, conceptId: span.concept }, "explain")
                })
              }
            >
              <Bug /> Debug error {latestError && <span className="font-mono text-xs text-muted-foreground">{latestError.status} {latestError.route}</span>}
            </CommandItem>
            <CommandItem onSelect={() => run(() => k.setContextTab("knowledge"))}>
              <Search /> Find related knowledge
            </CommandItem>
            <CommandItem onSelect={() => run(() => k.setMode("library"))}>
              <History /> Show previous experience
            </CommandItem>
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="Open service">
            {k.services.map((s) => (
              <CommandItem key={s.id} value={`service ${s.name}`} onSelect={() => run(() => k.openService(s.id))}>
                <Server /> {s.name}
              </CommandItem>
            ))}
          </CommandGroup>
          {q.trim().length > 1 && (
            <CommandGroup heading="Files">
              {k.files
                .filter((f) => f.toLowerCase().includes(q.trim().toLowerCase()))
                .slice(0, 8)
                .map((f) => (
                  <CommandItem key={f} value={`file ${f}`} onSelect={() => run(() => openFile(f))}>
                    <FileCode2 /> <span className="truncate font-mono text-xs">{f}</span>
                  </CommandItem>
                ))}
            </CommandGroup>
          )}
          <CommandGroup heading="Concepts">
            {Object.values(CONCEPTS).map((c) => (
              <CommandItem key={c.id} value={`concept ${c.name} ${c.category}`} onSelect={() => run(() => actions.explain({ kind: "concept", id: c.id, label: c.name, conceptId: c.id }))}>
                <Boxes /> {c.name} <span className="text-xs text-muted-foreground">{c.category}</span>
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandGroup heading="Go to">
            {MODES.map((m) => (
              <CommandItem key={m.id} value={`mode ${m.label}`} onSelect={() => run(() => k.setMode(m.id))}>
                {m.label}
                <CommandShortcut>⌘{m.key}</CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandGroup heading="Workspace">
            {WORKSPACES.map((w) => (
              <CommandItem key={w.id} value={`workspace ${w.label}`} onSelect={() => run(() => k.setDiscipline(w.id))}>
                <w.icon /> {w.label}
                {k.discipline === w.id && <Check className="ml-auto" />}
              </CommandItem>
            ))}
            {k.discipline !== "software" &&
              workspace(k.discipline).sections.map((sec) => (
                <CommandItem key={sec.id} value={`section ${workspace(k.discipline).label} ${sec.label}`} onSelect={() => run(() => k.openWorkspaceSection(sec.id))}>
                  <sec.icon /> {sec.label}
                  <CommandShortcut>{workspace(k.discipline).label}</CommandShortcut>
                </CommandItem>
              ))}
          </CommandGroup>
          <CommandGroup heading="Preferences">
            <CommandItem onSelect={() => run(() => setTheme(resolvedTheme === "dark" ? "light" : "dark"))}>
              <Moon /> Toggle theme
            </CommandItem>
            {LEVELS.map((l) => (
              <CommandItem key={l.id} value={`explain as ${l.label} level`} onSelect={() => run(() => k.setLevel(l.id))}>
                <GraduationCap /> Explain as {l.label}
                {k.level === l.id && <Check className="ml-auto" />}
              </CommandItem>
            ))}
            <CommandItem onSelect={() => run(() => k.setDialog("settings"))}>
              <Settings /> Preferences <CommandShortcut>⌘,</CommandShortcut>
            </CommandItem>
            <CommandItem onSelect={() => run(() => k.setDialog("shortcuts"))}>
              <Keyboard /> Keyboard shortcuts <CommandShortcut>?</CommandShortcut>
            </CommandItem>
            <CommandItem onSelect={() => run(() => k.setDialog("welcome"))}>
              <Sparkles /> Getting started
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  )
}
