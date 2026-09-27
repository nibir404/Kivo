import type { ReactNode } from "react"
import { Boxes, Brain, Cloud, Container, Database, Layers, Network, Server, Smartphone, Zap } from "lucide-react"
import type { ServiceStatus, SystemNodeKind } from "@/core/types"
import { cn } from "@/lib/utils"

export function StatusDot({ status, className }: { status: ServiceStatus | "ok" | "error" | "slow"; className?: string }) {
  const color =
    status === "running" || status === "ready" || status === "ok"
      ? "bg-success"
      : status === "building"
        ? "bg-info kivo-pulse"
        : status === "failed" || status === "error"
          ? "bg-destructive"
          : status === "slow"
            ? "bg-warning"
            : "bg-muted-foreground/40"
  return <span className={cn("inline-block size-1.5 shrink-0 rounded-full", color, className)} />
}

export function SectionLabel({ children, className, action }: { children: ReactNode; className?: string; action?: ReactNode }) {
  return (
    <div className={cn("flex items-center justify-between px-1 pb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase", className)}>
      <span>{children}</span>
      {action}
    </div>
  )
}

export const KIND_ICON: Record<SystemNodeKind, typeof Server> = {
  client: Smartphone,
  gateway: Network,
  service: Server,
  database: Database,
  cache: Zap,
  queue: Layers,
  model: Brain,
  infra: Container,
  external: Cloud,
}

export function KindIcon({ kind, className }: { kind: SystemNodeKind; className?: string }) {
  const Icon = KIND_ICON[kind] ?? Boxes
  return <Icon className={cn("size-3.5 text-muted-foreground", className)} />
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("font-mono text-[12px]", className)}>{children}</span>
}

export function EmptyState({ icon: Icon, title, children }: { icon: typeof Server; title: string; children?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <div className="rounded-lg border p-2">
        <Icon className="size-4 text-muted-foreground" />
      </div>
      <div className="text-sm font-medium">{title}</div>
      {children && <div className="max-w-64 text-xs text-muted-foreground">{children}</div>}
    </div>
  )
}

export function Stat({ label, value, unit, tone }: { label: string; value: string | number; unit?: string; tone?: "warn" | "bad" }) {
  return (
    <div className="flex flex-col gap-0.5 px-4 py-3">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className={cn("font-mono text-lg tabular-nums", tone === "warn" && "text-warning", tone === "bad" && "text-destructive")}>
        {value}
        {unit && <span className="ml-0.5 text-xs text-muted-foreground">{unit}</span>}
      </span>
    </div>
  )
}
