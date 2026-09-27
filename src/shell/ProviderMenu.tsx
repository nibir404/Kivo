import { Check, RefreshCw } from "lucide-react"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import type { ProviderInfo } from "@/lib/api"
import { cn } from "@/lib/utils"
import { refreshProviders, switchProvider } from "@/state/runners"
import { useKivo } from "@/state/store"

const DOT: Record<ProviderInfo["status"], string> = {
  ok: "bg-success",
  unknown: "bg-info",
  unauthorized: "bg-destructive",
  unreachable: "bg-warning",
  unconfigured: "bg-muted-foreground/40",
}

const STATUS: Record<ProviderInfo["status"], string> = {
  ok: "Connected",
  unknown: "Configured — verified on first use",
  unauthorized: "Not authorized",
  unreachable: "Unreachable",
  unconfigured: "Not configured",
}

/** The AI status chip: which provider/model Kivo is using, every provider's live status, and a switcher. */
export function ProviderMenu({ compactTrigger = false }: { compactTrigger?: boolean }) {
  const ai = useKivo((s) => s.ai)
  const daemon = useKivo((s) => s.daemon)
  const [checking, setChecking] = useState(false)
  const active = ai?.providers?.find((p) => p.id === ai.active)
  const ok = !!ai?.ai

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {compactTrigger ? (
          <Button variant="ghost" size="icon-sm" aria-label="AI provider">
            <span className={cn("size-2 rounded-full", ok ? "bg-success" : daemon ? "bg-warning" : "bg-muted-foreground/40")} />
          </Button>
        ) : (
          <button className="flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground">
            <span className={cn("size-1.5 rounded-full", ok ? "bg-success" : daemon ? "bg-warning" : "bg-muted-foreground/40")} />
            {ok && active ? `${active.label} · ${ai!.model.split("/").pop()}` : daemon ? "no AI provider" : "offline"}
          </button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel className="flex items-center justify-between">
          <span>AI providers</span>
          <button
            className="flex items-center gap-1 text-[11px] font-normal text-muted-foreground hover:text-foreground"
            onClick={async (e) => {
              e.preventDefault()
              setChecking(true)
              await refreshProviders().finally(() => setChecking(false))
            }}
          >
            <RefreshCw className={cn("size-3", checking && "animate-spin")} /> Re-check
          </button>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {!daemon && <div className="px-2 py-3 text-xs text-muted-foreground">The Kivo daemon isn't running, so AI features use offline templates.</div>}
        {ai?.providers?.map((p) => (
          <DropdownMenuItem
            key={p.id}
            disabled={!p.configured || p.status === "unauthorized" || p.status === "unreachable"}
            onSelect={(e) => {
              if (p.id === ai.active) return e.preventDefault()
              switchProvider(p.id)
            }}
            className="flex items-start gap-2.5 py-2"
          >
            <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", DOT[p.status])} />
            <div className="min-w-0 flex-1 space-y-0.5">
              <div className="flex items-center gap-2">
                <span className="font-medium">{p.label}</span>
                <span className="text-[11px] text-muted-foreground">{STATUS[p.status]}</span>
              </div>
              {p.models.length > 0 && <div className="truncate font-mono text-[11px] text-muted-foreground">{p.models.join(" → ")}</div>}
              {p.message && <div className="line-clamp-2 text-[11px] text-muted-foreground">{p.message}</div>}
            </div>
            {p.id === ai.active && <Check className="mt-1 size-3.5 shrink-0" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <div className="px-2 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
          Keys live in <span className="font-mono">.env</span> and never reach the browser. When the active provider is rate-limited, other connected providers take over.
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
