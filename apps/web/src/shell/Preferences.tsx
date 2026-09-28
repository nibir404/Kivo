import type { ReactNode } from "react"
import { useTheme } from "next-themes"
import { ArrowRight, Code2, Compass, FolderOpen, Monitor, Moon, Network, RefreshCw, Sparkles, Sun } from "lucide-react"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Kbd } from "@/components/ui/kbd"
import { Switch } from "@/components/ui/switch"
import type { Level } from "@kivo/core/types"
import { cn } from "@/lib/utils"
import { refreshProviders, switchProvider } from "@/state/runners"
import { useKivo } from "@/state/store"
import { useUi } from "./capture"
import { KivoMark, LEVELS } from "./TopBar"

export function PreferenceDialogs() {
  return (
    <>
      <WelcomeDialog />
      <SettingsDialog />
      <ShortcutsDialog />
    </>
  )
}

/** Focus the intent composer on the Build home (used from several entry points). */
export function startNewService() {
  const s = useKivo.getState()
  s.discardDraft()
  s.openService(null)
  focusWhenReady("intent-input")
}

/** Focus an element once it exists and nothing (e.g. a closing dialog's focus trap) takes focus back. */
export function focusWhenReady(id: string, tries = 20) {
  const el = document.getElementById(id)
  const dialogOpen = !!document.querySelector("[role=dialog]")
  if (!dialogOpen && el) {
    el.focus()
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) el.setSelectionRange(el.value.length, el.value.length)
  }
  if ((dialogOpen || document.activeElement !== el) && tries > 0) setTimeout(() => focusWhenReady(id, tries - 1), 50)
}

// ─── Welcome ─────────────────────────────────────────────────────────────────

function WelcomeDialog() {
  const { dialog, setDialog, setWelcomed, level, setLevel, setMode, ai, daemon } = useKivo()
  const open = dialog === "welcome"
  const close = () => {
    setWelcomed(true)
    setDialog(null)
  }
  const start = (fn: () => void) => {
    close()
    fn()
  }
  const paths = [
    ...(daemon
      ? [
          { icon: FolderOpen, title: "Open your project", body: "A folder on this Mac, or clone one from GitHub. The editor, terminal and git all work on it.", go: () => useUi.getState().setProjectDialog("open") },
        ]
      : []),
    { icon: Sparkles, title: "Build a service", body: "Describe it in plain words. You review the plan before anything is generated.", go: startNewService },
    { icon: Network, title: "Explore the demo architecture", body: "See how the demo project fits together and click anything to understand it.", go: () => setMode("learn") },
    { icon: Code2, title: "Open the code", body: "A focused editor with inline AI edits. Select code and press ⌘K.", go: () => setMode("code") },
  ]

  return (
    <Dialog open={open} onOpenChange={(v) => !v && close()}>
      {/* Focus goes wherever the chosen path puts it, not back to where the dialog opened from. */}
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-xl" onCloseAutoFocus={(e) => e.preventDefault()}>
        <div className="space-y-2 border-b px-6 pt-6 pb-5">
          <KivoMark className="size-8" />
          <DialogHeader className="gap-1 pt-2">
            <DialogTitle className="text-xl tracking-tight">Welcome to Kivo</DialogTitle>
            <DialogDescription>Describe what you want. Kivo plans it, builds it, and explains every step. What happens next is always your call.</DialogDescription>
          </DialogHeader>
        </div>

        <div className="space-y-5 px-6 py-5">
          <div className="space-y-2">
            <div className="text-[13px] font-medium">How should Kivo explain things to you?</div>
            <LevelPicker value={level} onChange={setLevel} />
            <p className="text-[11px] text-muted-foreground">You can change this at any time from your avatar menu.</p>
          </div>

          <div className="space-y-2">
            <div className="text-[13px] font-medium">Where would you like to start?</div>
            <div className="grid gap-2">
              {paths.map((p) => (
                <button key={p.title} onClick={() => start(p.go)} className="group flex items-center gap-3 rounded-xl border p-3 text-left transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                  <div className="rounded-lg border bg-background p-2">
                    <p.icon className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium">{p.title}</div>
                    <div className="text-xs text-muted-foreground">{p.body}</div>
                  </div>
                  <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 border-t bg-muted/30 px-6 py-3 text-xs text-muted-foreground">
          <span className={cn("size-1.5 rounded-full", ai?.ai ? "bg-success" : daemon ? "bg-warning" : "bg-muted-foreground/40")} />
          <span className="min-w-0 flex-1 truncate">
            {ai?.ai ? `AI ready · ${ai.providers.find((p) => p.id === ai.active)?.label} · ${ai.model.split("/").pop()}` : daemon ? "No AI provider connected — Kivo uses offline templates" : "Daemon offline — Kivo works in simulation until it connects"}
          </span>
          <Button variant="ghost" size="sm" onClick={close}>
            <Compass /> Just look around
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function LevelPicker({ value, onChange, className }: { value: Level; onChange: (l: Level) => void; className?: string }) {
  return (
    <div role="radiogroup" className={cn("grid grid-cols-2 gap-1.5 sm:grid-cols-4", className)}>
      {LEVELS.map((l) => (
        <button
          key={l.id}
          role="radio"
          aria-checked={value === l.id}
          onClick={() => onChange(l.id)}
          data-active={value === l.id || undefined}
          className="rounded-lg border px-2.5 py-2 text-left transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none data-active:border-foreground data-active:bg-accent/40"
        >
          <div className="text-[13px] font-medium">{l.label}</div>
          <div className="text-[11px] leading-snug text-muted-foreground">{l.hint}</div>
        </button>
      ))}
    </div>
  )
}

// ─── Preferences ─────────────────────────────────────────────────────────────

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="space-y-3 border-b px-6 py-5 last:border-b-0">
      <div>
        <h3 className="text-[13px] font-medium">{title}</h3>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  )
}

function ToggleRow({ label, description, checked, onChange }: { label: string; description: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4">
      <div>
        <div className="text-[13px]">{label}</div>
        <div className="text-xs text-muted-foreground">{description}</div>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} className="mt-0.5" />
    </label>
  )
}

const DOT: Record<string, string> = { ok: "bg-success", unknown: "bg-info", unauthorized: "bg-destructive", unreachable: "bg-warning", unconfigured: "bg-muted-foreground/40" }
const STATUS: Record<string, string> = { ok: "Connected", unknown: "Configured", unauthorized: "Not authorized", unreachable: "Unreachable", unconfigured: "Not configured" }

function SettingsDialog() {
  const k = useKivo()
  const { theme, setTheme } = useTheme()
  const resetLayout = useUi((s) => s.resetLayout)
  const [checking, setChecking] = useState(false)

  return (
    <Dialog open={k.dialog === "settings"} onOpenChange={(v) => !v && k.setDialog(null)}>
      <DialogContent className="gap-0 p-0 sm:max-w-lg">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle>Preferences</DialogTitle>
          <DialogDescription>How Kivo looks, explains and behaves. Saved on this device.</DialogDescription>
        </DialogHeader>
        <div className="max-h-[min(70vh,640px)] overflow-y-auto overscroll-contain">
          <Section title="Appearance">
            <div className="grid grid-cols-3 gap-1.5">
              {(
                [
                  ["light", Sun, "Light"],
                  ["dark", Moon, "Dark"],
                  ["system", Monitor, "System"],
                ] as const
              ).map(([id, Icon, label]) => (
                <button
                  key={id}
                  onClick={() => setTheme(id)}
                  data-active={theme === id || undefined}
                  className="flex items-center justify-center gap-2 rounded-lg border py-2 text-[13px] transition-colors hover:bg-accent/60 data-active:border-foreground data-active:bg-accent/40"
                >
                  <Icon className="size-3.5" /> {label}
                </button>
              ))}
            </div>
          </Section>

          <Section title="Explanations" description="The depth Kivo uses everywhere: explanations, build steps, runtime narration and AI answers.">
            <LevelPicker value={k.level} onChange={k.setLevel} />
          </Section>

          <Section title="AI provider" description="Which model service Kivo uses. Keys stay in .env on your machine.">
            {!k.ai?.providers?.length && <p className="text-xs text-muted-foreground">{k.daemon ? "No providers reported." : "Connect the Kivo daemon to use AI."}</p>}
            <div className="space-y-1.5">
              {k.ai?.providers?.map((p) => {
                const usable = p.configured && p.status !== "unauthorized" && p.status !== "unreachable"
                const active = p.id === k.ai?.active
                return (
                  <div key={p.id} className="flex items-center gap-3 rounded-lg border px-3 py-2">
                    <span className={cn("size-2 shrink-0 rounded-full", DOT[p.status])} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-[13px]">
                        <span className="font-medium">{p.label}</span>
                        <span className="text-[11px] text-muted-foreground">{STATUS[p.status]}</span>
                      </div>
                      <div className="truncate text-[11px] text-muted-foreground">{p.message ?? (p.models.length ? p.models.join(" → ") : "")}</div>
                    </div>
                    {active ? (
                      <span className="text-[11px] font-medium">In use</span>
                    ) : usable ? (
                      <Button size="xs" variant="outline" onClick={() => switchProvider(p.id)}>
                        Use
                      </Button>
                    ) : (
                      <span className="text-[11px] text-muted-foreground">{p.configured ? "Unavailable" : "Add key in .env"}</span>
                    )}
                  </div>
                )
              })}
            </div>
            {k.daemon && (
              <Button
                variant="ghost"
                size="sm"
                className="-ml-2 text-muted-foreground"
                onClick={async () => {
                  setChecking(true)
                  await refreshProviders().finally(() => setChecking(false))
                }}
              >
                <RefreshCw className={cn(checking && "animate-spin")} /> Re-check connections
              </Button>
            )}
          </Section>

          <Section title="Workspace">
            <ToggleRow label="Focus mode for code" description="Fold the context panel away while you edit, and bring it back when you leave." checked={k.prefs.focusCode} onChange={(v) => k.setPref("focusCode", v)} />
            <ToggleRow label="AI edit on selection" description="Selecting code with the mouse opens the inline AI prompt. ⌘K works either way." checked={k.prefs.aiOnSelect} onChange={(v) => k.setPref("aiOnSelect", v)} />
            <ToggleRow label="AI autocomplete" description="Suggest code as dimmed ghost text while you type. Tab accepts, Esc dismisses." checked={k.prefs.autocomplete} onChange={(v) => k.setPref("autocomplete", v)} />
            <ToggleRow label="Explain & Capture toolbar" description="Show Explain · Why · Note · Save · Ask when you select text or objects." checked={k.prefs.captureToolbar} onChange={(v) => k.setPref("captureToolbar", v)} />
            <ToggleRow label="Build notifications" description="When a build finishes, show what happened and what you could do next." checked={k.prefs.buildNotify} onChange={(v) => k.setPref("buildNotify", v)} />
            <ToggleRow label="Demo traffic" description="Simulated requests for exploring Observe. Off by default so nothing looks live that isn't." checked={k.runtimeLive} onChange={() => k.toggleRuntime()} />
            <Button variant="outline" size="sm" onClick={resetLayout}>
              Reset panel layout
            </Button>
          </Section>

          <Section title="Memory & privacy" description="What Kivo may use to personalise answers.">
            <ToggleRow label="Use my library as context" description="Your notes and saved explanations shape how Kivo explains things to you." checked={k.personalContext} onChange={k.setPersonalContext} />
            <ToggleRow label="Remember runtime events" description="Let Kivo recall errors and incidents you've looked at before." checked={k.rememberRuntime} onChange={k.setRememberRuntime} />
          </Section>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ─── Shortcuts ───────────────────────────────────────────────────────────────

const SHORTCUTS: { group: string; items: [string[], string][] }[] = [
  {
    group: "Anywhere",
    items: [
      [["⌘", "K"], "Build, ask, or jump to anything"],
      [["⌘", "1–5"], "Switch mode"],
      [["⌘", "B"], "Toggle navigator"],
      [["⌘", "J"], "Toggle terminal panel"],
      [["⌘", "I"], "Toggle context panel"],
      [["⌘", ","], "Preferences"],
      [["?"], "This list"],
    ],
  },
  {
    group: "After selecting something",
    items: [
      [["E"], "Explain it"],
      [["W"], "Why is it here?"],
      [["N"], "Write a note"],
      [["S"], "Save to library"],
      [["A"], "Ask AI about it"],
      [["Esc"], "Dismiss"],
    ],
  },
  {
    group: "Code editor",
    items: [
      [["Select"], "Opens the AI prompt (mouse)"],
      [["⌘", "K"], "Edit selection or line with AI"],
      [["⌘", "E"], "Explain selection"],
      [["⌘", "S"], "Save file"],
      [["⌘", "↵"], "Accept AI edit"],
      [["Esc"], "Reject AI edit"],
    ],
  },
]

function ShortcutsDialog() {
  const { dialog, setDialog } = useKivo()
  return (
    <Dialog open={dialog === "shortcuts"} onOpenChange={(v) => !v && setDialog(null)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Everything is reachable from the keyboard.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {SHORTCUTS.map((g) => (
            <div key={g.group} className="space-y-1.5">
              <div className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{g.group}</div>
              {g.items.map(([keys, label]) => (
                <div key={label} className="flex items-center justify-between text-[13px]">
                  <span>{label}</span>
                  <span className="flex gap-1">
                    {keys.map((key) => (
                      <Kbd key={key}>{key}</Kbd>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
