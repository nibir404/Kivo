import { useEffect, useRef, useState } from "react"
import { GitBranch } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import { api } from "@/lib/api"
import { useKivo } from "@/state/store"
import { Terminal as Shell } from "./Terminal"
import { StatusDot } from "./bits"
import { Capturable, CaptureScope } from "./capture"

export function BottomPanel() {
  const { bottomTab, setBottomTab, logs } = useKivo()
  const problems = logs.filter((l) => l.level === "warn" || l.level === "error").length
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center border-b px-2">
        <Tabs value={bottomTab} onValueChange={(v) => setBottomTab(v as typeof bottomTab)}>
          <TabsList variant="line" className="h-7">
            {(["terminal", "output", "runtime", "logs", "problems", "git"] as const).map((t) => (
              <TabsTrigger key={t} value={t} className="px-2 text-xs capitalize">
                {t}
                {t === "problems" && problems > 0 && (
                  <Badge variant="secondary" className="h-4 px-1 font-mono text-[10px]">
                    {problems}
                  </Badge>
                )}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>
      <div className="min-h-0 flex-1">
        {/* The shell stays mounted so the session survives tab switches. */}
        <div className={cn("h-full", bottomTab !== "terminal" && "hidden")}>
          <Shell visible={bottomTab === "terminal"} />
        </div>
        {bottomTab === "output" && <Output />}
        {bottomTab === "runtime" && <RuntimeStream />}
        {bottomTab === "logs" && <Logs filter={() => true} />}
        {bottomTab === "problems" && <Logs filter={(l) => l !== "info" && l !== "debug"} />}
        {bottomTab === "git" && <Git />}
      </div>
    </div>
  )
}

function useStickToBottom(dep: unknown) {
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" })
  }, [dep])
  return end
}

function Output() {
  const terminal = useKivo((s) => s.output)
  const end = useStickToBottom(terminal.length)
  return (
    <ScrollArea className="h-full">
      <CaptureScope source="log" className="p-3 font-mono text-[12px] leading-5">
        {terminal.map((l, i) => (
          <div
            key={i}
            className={cn(
              "whitespace-pre-wrap",
              l.startsWith("$") || l.startsWith("▸") ? "text-foreground" : "text-muted-foreground",
              (l.startsWith("✓") || l.trimStart().startsWith("✓")) && "text-success",
              (l.includes("✗") || /FAILED|Error/.test(l)) && "text-destructive",
              (l.startsWith("⏳") || l.startsWith("↻") || l.startsWith("!")) && "text-warning",
            )}
          >
            {l}
          </div>
        ))}
        <div ref={end} />
      </CaptureScope>
    </ScrollArea>
  )
}

function RuntimeStream() {
  const { traces, level, selectTrace, setMode } = useKivo()
  const events = traces.slice(0, 6).flatMap((t) => t.spans.map((s) => ({ t, s }))).slice(0, 40)
  return (
    <ScrollArea className="h-full">
      <div className="p-2 font-mono text-[12px]">
        {events.length === 0 && <div className="p-2 text-muted-foreground">No traffic yet. Turn on demo traffic from the status bar, or call a service from its API tab.</div>}
        {events.map(({ t, s }) => (
          <Capturable
            key={s.id}
            refObj={{ kind: "span", id: s.id, label: s.name, conceptId: s.concept, detail: s.narration[level] }}
            onSelect={() => {
              selectTrace(t.id)
              setMode("observe")
            }}
            className="flex items-center gap-2 px-2 py-0.5 hover:bg-accent"
          >
            <StatusDot status={s.status} />
            <span className="w-40 truncate">{s.name}</span>
            <span className="w-16 text-right text-muted-foreground tabular-nums">{s.durationMs}ms</span>
            <span className="w-28 truncate text-muted-foreground">
              {t.method} {t.route}
            </span>
            <span className="truncate font-sans text-muted-foreground">{s.narration[level]}</span>
          </Capturable>
        ))}
      </div>
    </ScrollArea>
  )
}

function Logs({ filter }: { filter: (level: string) => boolean }) {
  const logs = useKivo((s) => s.logs).filter((l) => filter(l.level))
  const end = useStickToBottom(logs.length)
  return (
    <ScrollArea className="h-full">
      <CaptureScope source="log" className="p-3 font-mono text-[12px] leading-5">
        {logs.length === 0 && <div className="text-muted-foreground">No entries.</div>}
        {logs.slice(-200).map((l) => (
          <div key={l.id} className="flex gap-3">
            <span className="text-muted-foreground tabular-nums">{new Date(l.at).toLocaleTimeString([], { hour12: false })}</span>
            <span className={cn("w-10", l.level === "warn" && "text-warning", l.level === "error" && "text-destructive", l.level === "info" && "text-info")}>{l.level}</span>
            <span className="w-24 truncate text-muted-foreground">{l.source}</span>
            <span>{l.message}</span>
          </div>
        ))}
        <div ref={end} />
      </CaptureScope>
    </ScrollArea>
  )
}

function Git() {
  const daemon = useKivo((s) => s.daemon)
  const buildDone = useKivo((s) => s.build?.finished)
  const [log, setLog] = useState("")
  useEffect(() => {
    if (daemon) api.gitLog().then((r) => setLog(r.log)).catch(() => setLog(""))
  }, [daemon, buildDone])
  if (!daemon) return <div className="p-3 font-mono text-[12px] text-muted-foreground">Git history needs the Kivo daemon.</div>
  return (
    <ScrollArea className="h-full">
      <div className="space-y-0.5 p-3 font-mono text-[12px]">
        <div className="flex items-center gap-2 pb-1 text-muted-foreground">
          <GitBranch className="size-3.5" /> main · every build is a commit you can inspect or roll back from the Terminal
        </div>
        {log.split("\n").map((l, i) => {
          const [hash, subject, when] = l.split("\t")
          if (when !== undefined)
            return (
              <div key={i} className="flex gap-2 pt-2">
                <span className="text-warning">{hash}</span>
                <span className={cn(subject.startsWith("wip") && "text-muted-foreground")}>{subject}</span>
                <span className="ml-auto text-muted-foreground">{when}</span>
              </div>
            )
          if (!l.trim()) return null
          return (
            <div key={i} className={cn("pl-4 whitespace-pre text-muted-foreground", l.includes("+") && "text-success/90")}>
              {l.trim()}
            </div>
          )
        })}
      </div>
    </ScrollArea>
  )
}
