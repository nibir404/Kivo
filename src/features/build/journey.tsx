import { Check } from "lucide-react"
import type { PlanStep } from "@/core/types"
import { cn } from "@/lib/utils"
import { useKivo } from "@/state/store"

/**
 * Plain-language layer for the build flow. Everyone sees the human version first; the technical
 * version (engine, tools, file names) is one click away, and open by default at Advanced/Expert.
 */

/** Advanced and Expert users see technical names up front; everyone else sees plain words. */
export function useTechnical() {
  const level = useKivo((s) => s.level)
  return level === "advanced" || level === "expert"
}

// ─── Journey: Describe → Review → Build → Use ─────────────────────────────────

const JOURNEY = ["Describe", "Review", "Build", "Use"] as const
export type JourneyStage = (typeof JOURNEY)[number]

export function Journey({ stage, className }: { stage: JourneyStage; className?: string }) {
  const at = JOURNEY.indexOf(stage)
  return (
    <ol aria-label="Progress" className={cn("flex items-center gap-2 text-[12px]", className)}>
      {JOURNEY.map((name, i) => (
        <li key={name} className="flex items-center gap-2" aria-current={i === at ? "step" : undefined}>
          <span
            className={cn(
              "flex size-5 items-center justify-center rounded-full border text-[10px] tabular-nums transition-colors",
              i < at && "border-transparent bg-foreground text-background",
              i === at && "border-foreground text-foreground",
              i > at && "text-muted-foreground",
            )}
          >
            {i < at ? <Check className="size-3" /> : i + 1}
          </span>
          <span className={cn(i === at ? "font-medium text-foreground" : "text-muted-foreground", i !== at && "hidden sm:inline")}>{name}</span>
          {i < JOURNEY.length - 1 && <span className={cn("h-px w-4 sm:w-8", i < at ? "bg-foreground/40" : "bg-border")} />}
        </li>
      ))}
    </ol>
  )
}

// ─── Steps in plain words ──────────────────────────────────────────────────────

export const PHASES = ["Plan", "Write", "Test", "Launch"] as const
export type Phase = (typeof PHASES)[number]

const PLAIN: Record<string, { title: string; doing: string; phase: Phase }> = {
  understand: { title: "Understanding your request", doing: "Turning your description into a clear checklist", phase: "Plan" },
  api: { title: "Planning how apps connect", doing: "Deciding exactly how apps will talk to this service", phase: "Plan" },
  model: { title: "Designing how data is stored", doing: "Deciding what information to keep and how", phase: "Write" },
  storage: { title: "Connecting the database", doing: "Linking the service to where data is saved", phase: "Write" },
  hashing: { title: "Protecting passwords", doing: "Making sure passwords are never stored readable", phase: "Write" },
  jwt: { title: "Keeping people signed in", doing: "Setting up secure, expiring sign-in sessions", phase: "Write" },
  ratelimit: { title: "Blocking password guessing", doing: "Limiting how often someone can try to log in", phase: "Write" },
  handlers: { title: "Writing the features", doing: "Writing the code for each feature you asked for", phase: "Write" },
  install: { title: "Gathering building blocks", doing: "Installing the tools the code relies on", phase: "Test" },
  tests: { title: "Checking every feature works", doing: "Running an automatic check for each feature", phase: "Test" },
  boot: { title: "Starting it up", doing: "Turning the service on and making sure it responds", phase: "Launch" },
}

export function plain(step: PlanStep) {
  return PLAIN[step.id] ?? { title: step.title, doing: step.what, phase: step.executor === "ai" ? "Write" : "Test" }
}

/** The step title to lead with, for this user's level. */
export function stepTitle(step: PlanStep, technical: boolean) {
  return technical ? step.title : plain(step).title
}
