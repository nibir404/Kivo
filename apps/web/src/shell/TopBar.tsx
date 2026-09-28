import { useState } from "react"
import { useTheme } from "next-themes"
import { ChevronsUpDown, Folder, FolderGit2, FolderOpen, FolderTree, GitBranch, Keyboard, Library, X, Monitor, Moon, Network, PanelLeft, PanelRight, RefreshCw, RotateCcw, Search, Settings, Sparkles, SquareTerminal, Sun } from "lucide-react"
import { toast } from "sonner"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { Level, Mode } from "@kivo/core/types"
import { cn } from "@/lib/utils"
import { api } from "@/lib/api"
import { inBrowser } from "@/lib/transport"
import { refreshFiles, reloadCurrentProject, switchToProject } from "@/state/runners"
import { useKivo } from "@/state/store"
import { workspace } from "@/features/workspace/registry"
import { useUi } from "./capture"
import { ProviderMenu } from "./ProviderMenu"
import { shortPath, useRecentProjects } from "./projects/ProjectDialogs"

export const MODES: { id: Mode; label: string; key: string; hint: string }[] = [
  { id: "build", label: "Build", key: "1", hint: "Describe and build services" },
  { id: "code", label: "Code", key: "2", hint: "Edit files with inline AI" },
  { id: "observe", label: "Observe", key: "3", hint: "Watch requests flow" },
  { id: "learn", label: "Learn", key: "4", hint: "Architecture and concepts" },
  { id: "library", label: "Library", key: "5", hint: "Your notes and experience" },
]

export const LEVELS: { id: Level; label: string; hint: string }[] = [
  { id: "beginner", label: "Beginner", hint: "Plain language, no jargon" },
  { id: "intermediate", label: "Intermediate", hint: "How the pieces connect" },
  { id: "advanced", label: "Advanced", hint: "Implementation detail" },
  { id: "expert", label: "Expert", hint: "Architecture & trade-offs" },
]

export function KivoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn("size-5", className)} aria-hidden>
      <rect x="1" y="1" width="22" height="22" rx="6" className="fill-foreground" />
      <path d="M8 6.5v11M8 12l6.5-5.5M10.2 10.2 16 17.5" className="stroke-background" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  )
}

export function TopBar({ compact = false, onToggleLeft, onToggleRight }: { compact?: boolean; onToggleLeft?: () => void; onToggleRight?: () => void }) {
  const { mode, setMode, setCommandOpen, discipline } = useKivo()
  // The first mode speaks the workspace's language: Build, Train, Assess, Operate…
  const primary = workspace(discipline).primaryMode

  const modeTabs = (
    <nav className={cn("flex items-center gap-0.5", compact ? "min-w-0 flex-1 overflow-x-auto [scrollbar-width:none]" : "ml-1")} aria-label="Modes">
      {MODES.map((m) => (
        <Tooltip key={m.id} delayDuration={500}>
          <TooltipTrigger asChild>
            <button
              onClick={() => setMode(m.id)}
              data-active={mode === m.id || undefined}
              aria-current={mode === m.id ? "page" : undefined}
              className="relative h-11 shrink-0 px-2.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground data-active:text-foreground"
            >
              {m.id === "build" ? primary : m.label}
              <span className={cn("absolute inset-x-2.5 -bottom-px h-px origin-center bg-foreground transition-transform duration-200", mode === m.id ? "scale-x-100" : "scale-x-0")} />
            </button>
          </TooltipTrigger>
          <TooltipContent className="flex items-center gap-2">
            {m.hint}
            <KbdGroup>
              <Kbd>⌘</Kbd>
              <Kbd>{m.key}</Kbd>
            </KbdGroup>
          </TooltipContent>
        </Tooltip>
      ))}
    </nav>
  )

  if (compact) {
    return (
      <header className="flex h-11 shrink-0 items-center gap-1 border-b px-2">
        <Button variant="ghost" size="icon-sm" onClick={onToggleLeft} aria-label="Open navigator">
          <PanelLeft />
        </Button>
        <KivoMark className="mx-1 shrink-0" />
        {modeTabs}
        <Button variant="ghost" size="icon-sm" onClick={() => setCommandOpen(true)} aria-label="Command menu">
          <Search />
        </Button>
        <ProviderMenu compactTrigger />
        <Button variant="ghost" size="icon-sm" onClick={onToggleRight} aria-label="Open context panel">
          <PanelRight />
        </Button>
        <AccountMenu />
      </header>
    )
  }

  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
      <div className="flex shrink-0 items-center gap-2 pr-1">
        <KivoMark />
        <span className="text-sm font-semibold tracking-tight">Kivo</span>
      </div>
      <span className="text-muted-foreground/50">/</span>
      <ProjectMenu />
      {modeTabs}

      <div className="ml-auto flex items-center gap-1.5">
        <Button variant="outline" size="sm" className="w-40 justify-start gap-2 font-normal text-muted-foreground lg:w-56 xl:w-72" onClick={() => setCommandOpen(true)}>
          <Search />
          <span className="truncate">Build, ask, or jump to…</span>
          <KbdGroup className="ml-auto">
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd>
          </KbdGroup>
        </Button>
        <ProviderMenu />
        <ThemeToggle />
        <AccountMenu />
      </div>
    </header>
  )
}

function ProjectMenu() {
  const { project, projectInfo, analysis, setMode, daemon, files } = useKivo()
  const runInTerminal = useUi((s) => s.runInTerminal)
  const setProjectDialog = useUi((s) => s.setProjectDialog)
  const [open, setOpen] = useState(false)
  const [recent, setRecent] = useRecentProjects(open)
  const others = recent.filter((p) => p.id !== projectInfo?.id).slice(0, 8)
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-1.5 font-normal" title={projectInfo?.dir}>
          <span className="font-medium">{project}</span>
          <span className="hidden text-muted-foreground xl:inline">{analysis.summary}</span>
          <ChevronsUpDown className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80">
        <DropdownMenuLabel className="font-normal">
          <div className="flex items-center gap-1.5 text-sm font-medium">
            {project}
            {projectInfo?.kind === "demo" && <span className="rounded border px-1 text-[10px] font-normal text-muted-foreground">demo</span>}
          </div>
          {projectInfo && <div className="truncate font-mono text-[11px] text-muted-foreground">{shortPath(projectInfo.dir)}</div>}
          <div className="text-xs text-muted-foreground">
            {analysis.summary} · {files.length} files{projectInfo?.remote ? ` · ${projectInfo.remote.replace(/^https:\/\/|\.git$/g, "")}` : ""}
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={!daemon} onSelect={() => setProjectDialog("open")}>
          <FolderOpen /> Open folder…
          <DropdownMenuShortcut>⌘O</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!daemon} onSelect={() => setProjectDialog("clone")}>
          <GitBranch /> {inBrowser ? "Import from GitHub…" : "Clone repository…"}
        </DropdownMenuItem>
        {others.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">Recent</DropdownMenuLabel>
            {others.map((p) => (
              <DropdownMenuItem key={p.id} onSelect={() => switchToProject(p.id)} className="group">
                {p.kind === "git" ? <FolderGit2 /> : <Folder />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{p.name}</span>
                  <span className="block truncate font-mono text-[10.5px] text-muted-foreground">{p.kind === "demo" ? "Kivo demo project" : shortPath(p.dir)}</span>
                </span>
                {p.kind !== "demo" && (
                  <button
                    aria-label={`Remove ${p.name} from recent projects`}
                    title="Remove from list (the folder stays on disk)"
                    className="rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-background"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      api
                        .forgetProject(p.id)
                        .then(() => setRecent((l) => l.filter((x) => x.id !== p.id)))
                        .catch((err) => toast.error(String(err.message)))
                    }}
                  >
                    <X className="size-3" />
                  </button>
                )}
              </DropdownMenuItem>
            ))}
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => setMode("learn")}>
          <Network /> Architecture
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setMode("code")}>
          <FolderTree /> Browse files
        </DropdownMenuItem>
        {inBrowser ? (
          projectInfo?.kind === "demo" && (
            <DropdownMenuItem
              onSelect={() =>
                api
                  .resetDemo()
                  .then(() => reloadCurrentProject())
                  .then(() => toast.success("Demo project reset"))
                  .catch((err) => toast.error(String(err.message)))
              }
            >
              <RotateCcw /> Reset demo project
            </DropdownMenuItem>
          )
        ) : (
          <DropdownMenuItem disabled={!daemon} onSelect={() => runInTerminal("git status")}>
            <SquareTerminal /> Git status in terminal
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          disabled={!daemon}
          onSelect={() =>
            refreshFiles()
              .then(() => toast.success("Files refreshed"))
              .catch(() => toast.error("Couldn't refresh files"))
          }
        >
          <RefreshCw /> Refresh files
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Toggle theme" onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}>
          <Sun className="dark:hidden" />
          <Moon className="hidden dark:block" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{resolvedTheme === "dark" ? "Light theme" : "Dark theme"}</TooltipContent>
    </Tooltip>
  )
}

/** Everything personal in one place: how Kivo explains, how it looks, and how it behaves. */
export function AccountMenu() {
  const { level, setLevel, setMode, setDialog } = useKivo()
  const { theme, setTheme } = useTheme()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="Account and preferences">
          <Avatar className="size-7">
            <AvatarFallback className="text-[11px]">IA</AvatarFallback>
          </Avatar>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="font-normal">
          <div className="text-sm font-medium">Imtiaz Ahmed</div>
          <div className="text-xs text-muted-foreground">Explaining at {LEVELS.find((l) => l.id === level)?.label.toLowerCase()} level</div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Sparkles /> Explain as
            <span className="ml-auto text-xs text-muted-foreground">{LEVELS.find((l) => l.id === level)?.label}</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-56">
            <DropdownMenuRadioGroup value={level} onValueChange={(v) => setLevel(v as Level)}>
              {LEVELS.map((l) => (
                <DropdownMenuRadioItem key={l.id} value={l.id} className="flex-col items-start gap-0">
                  <span>{l.label}</span>
                  <span className="text-xs text-muted-foreground">{l.hint}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Monitor /> Theme
            <span className="ml-auto text-xs text-muted-foreground capitalize">{theme}</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
              <DropdownMenuRadioItem value="light">
                <Sun /> Light
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">
                <Moon /> Dark
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system">
                <Monitor /> System
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => setMode("library")}>
          <Library /> Personal library
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setDialog("settings")}>
          <Settings /> Preferences
          <DropdownMenuShortcut>⌘,</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setDialog("shortcuts")}>
          <Keyboard /> Keyboard shortcuts
          <DropdownMenuShortcut>?</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setDialog("welcome")}>
          <Sparkles /> Getting started
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
