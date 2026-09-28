import { useEffect, useMemo, useState } from "react"
import { KeyRound, Loader2, Send, X } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { CaptureScope } from "@/shell/capture"
import { SectionLabel } from "@/shell/bits"
import { apiFetch } from "@/lib/transport"

/**
 * In-app API client for services Kivo is running. Endpoints and example bodies come from the
 * service's own live OpenAPI schema; requests go through the daemon (which only reaches
 * Kivo-launched services). Tokens returned by the API are captured and reused automatically.
 */

interface Op {
  method: string
  path: string
  summary: string
  body?: string
  query: string[]
  secured: boolean
}

interface Result {
  status: number
  statusText: string
  ms: number
  body: string
}

type Schema = { $ref?: string; type?: string; format?: string; properties?: Record<string, Schema>; items?: Schema; anyOf?: Schema[]; allOf?: Schema[]; enum?: unknown[]; default?: unknown; example?: unknown }

async function proxy(service: string, method: string, path: string, body?: string, token?: string): Promise<Result> {
  const res = await apiFetch("/api/proxy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ service, method, path, body, headers: token ? { Authorization: `Bearer ${token}` } : {} }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
  return data
}

export function ApiClient({ service }: { service: string }) {
  const [ops, setOps] = useState<Op[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sel, setSel] = useState(0)
  const [path, setPath] = useState("")
  const [body, setBody] = useState("")
  const [token, setToken] = useState<string | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const [sending, setSending] = useState(false)
  const [captured, setCaptured] = useState<string[]>([])

  useEffect(() => {
    proxy(service, "GET", "/openapi.json")
      .then((r) => setOps(parseOpenApi(JSON.parse(r.body))))
      .catch((e) => setError(String(e.message)))
  }, [service])

  const op = ops?.[sel]
  useEffect(() => {
    if (!op) return
    setPath(op.path + (op.query.length ? "?" + op.query.map((q) => `${q}=`).join("&") : ""))
    setBody(op.body ?? "")
    setResult(null)
  }, [op])

  const send = async () => {
    if (!op) return
    setSending(true)
    try {
      const r = await proxy(service, op.method, path, op.method === "GET" ? undefined : body || undefined, token ?? undefined)
      setResult(r)
      // Capture tokens the API hands back, so the next authenticated call just works.
      try {
        const data = JSON.parse(r.body)
        const found = Object.entries(data ?? {}).filter(([k, v]) => typeof v === "string" && /token/i.test(k) && !/type/i.test(k) && v.length > 20) as [string, string][]
        const access = found.find(([k]) => /access/i.test(k)) ?? found.find(([k]) => !/refresh/i.test(k))
        if (access) setToken(access[1])
        if (found.length) setCaptured(found.map(([k]) => k))
      } catch {
        // non-JSON response
      }
    } catch (e) {
      toast.error("Request failed", { description: String((e as Error).message) })
    } finally {
      setSending(false)
    }
  }

  const pretty = useMemo(() => {
    if (!result) return ""
    try {
      return JSON.stringify(JSON.parse(result.body), null, 2)
    } catch {
      return result.body
    }
  }, [result])

  if (error) return <p className="text-[13px] text-destructive">Couldn't reach the service: {error}</p>
  if (!ops)
    return (
      <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" /> Reading the live API schema…
      </div>
    )

  return (
    <div className="grid gap-4 md:grid-cols-[220px_minmax(0,1fr)]">
      <div className="space-y-px">
        <SectionLabel>Endpoints</SectionLabel>
        {ops.map((o, i) => (
          <button
            key={o.method + o.path}
            onClick={() => setSel(i)}
            data-active={i === sel || undefined}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent data-active:bg-accent"
          >
            <Method m={o.method} />
            <span className="truncate font-mono text-[12px]">{o.path}</span>
          </button>
        ))}
      </div>

      {op && (
        <div className="min-w-0 space-y-3">
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              send()
            }}
          >
            <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border px-2 focus-within:ring-1 focus-within:ring-ring">
              <Method m={op.method} />
              <input value={path} onChange={(e) => setPath(e.target.value)} className="h-8 min-w-0 flex-1 bg-transparent font-mono text-[12px] outline-none" />
            </div>
            <Button type="submit" size="sm" disabled={sending}>
              {sending ? <Loader2 className="animate-spin" /> : <Send />} Send
            </Button>
          </form>
          {op.summary && <p className="text-[12px] text-muted-foreground">{op.summary}</p>}

          <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
            <KeyRound className="size-3.5" />
            {token ? (
              <>
                <span>
                  Bearer token {captured.length ? `captured from ${captured.join(", ")}` : "set"}
                  {op.secured ? " — sent with this request" : ""}
                </span>
                <span className="truncate font-mono text-[11px]">{token.slice(0, 18)}…</span>
                <button aria-label="Clear token" className="rounded p-0.5 hover:bg-accent" onClick={() => setToken(null)}>
                  <X className="size-3" />
                </button>
              </>
            ) : (
              <span>{op.secured ? "Requires a token — call a login endpoint first and Kivo will capture it." : "No token needed"}</span>
            )}
          </div>

          {op.method !== "GET" && (
            <div className="space-y-1">
              <div className="text-[11px] font-medium text-muted-foreground">Body</div>
              <Textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault()
                    send()
                  }
                }}
                spellCheck={false}
                className="min-h-28 font-mono text-[12px]"
                placeholder="{}"
              />
              <div className="text-[11px] text-muted-foreground">
                <Kbd>⌘↵</Kbd> send
              </div>
            </div>
          )}

          {result && (
            <div className="kivo-in space-y-1">
              <div className="flex items-center gap-2 text-[12px]">
                <span className={cn("rounded px-1.5 py-0.5 font-mono font-medium", result.status < 300 ? "bg-success/15 text-success" : result.status < 500 ? "bg-warning/15 text-warning" : "bg-destructive/15 text-destructive")}>
                  {result.status} {result.statusText}
                </span>
                <span className="font-mono text-muted-foreground">{result.ms}ms</span>
                <span className="ml-auto text-[11px] text-muted-foreground">Highlight any part to explain it</span>
              </div>
              <CaptureScope source="log">
                <pre className="max-h-80 overflow-auto rounded-lg border bg-muted/30 p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap">{pretty || "(empty body)"}</pre>
              </CaptureScope>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Method({ m }: { m: string }) {
  return <span className={cn("w-11 shrink-0 font-mono text-[10px] font-semibold", m === "GET" ? "text-info" : m === "DELETE" ? "text-destructive" : m === "POST" ? "text-success" : "text-warning")}>{m}</span>
}

// ─── OpenAPI → runnable operations ───────────────────────────────────────────

function parseOpenApi(doc: { paths?: Record<string, Record<string, Record<string, unknown>>>; components?: { schemas?: Record<string, Schema> } }): Op[] {
  const schemas = doc.components?.schemas ?? {}
  const resolve = (s?: Schema): Schema | undefined => (s?.$ref ? schemas[s.$ref.split("/").pop()!] : s)
  const sample = (s: Schema | undefined, name = "", depth = 0): unknown => {
    s = resolve(s)
    if (!s || depth > 4) return null
    if (s.example !== undefined) return s.example
    if (s.default !== undefined) return s.default
    if (s.enum?.length) return s.enum[0]
    if (s.allOf?.length) return sample(s.allOf[0], name, depth + 1)
    if (s.anyOf?.length) return sample(s.anyOf.find((x) => resolve(x)?.type !== "null"), name, depth + 1)
    if (s.type === "object" || s.properties) return Object.fromEntries(Object.entries(s.properties ?? {}).map(([k, v]) => [k, sample(v, k, depth + 1)]))
    if (s.type === "array") return [sample(s.items, name, depth + 1)]
    if (s.type === "integer" || s.type === "number") return 1
    if (s.type === "boolean") return true
    const n = name.toLowerCase()
    if (s.format === "email" || n.includes("email")) return "ada@tandem.app"
    if (n.includes("password")) return "CorrectHorse9!"
    if (n.includes("token")) return ""
    if (n.includes("name")) return "Ada Lovelace"
    if (s.format === "date-time") return new Date().toISOString()
    return "string"
  }

  const out: Op[] = []
  for (const [path, methods] of Object.entries(doc.paths ?? {})) {
    for (const [method, raw] of Object.entries(methods)) {
      const op = raw as { summary?: string; requestBody?: { content?: Record<string, { schema?: Schema }> }; parameters?: { in: string; name: string }[]; security?: unknown[] }
      const schema = op.requestBody?.content?.["application/json"]?.schema
      out.push({
        method: method.toUpperCase(),
        path,
        summary: op.summary ?? "",
        body: schema ? JSON.stringify(sample(schema), null, 2) : undefined,
        query: (op.parameters ?? []).filter((p) => p.in === "query").map((p) => p.name),
        secured: Boolean(op.security?.length) || (op.parameters ?? []).some((p) => p.in === "header" && /authorization/i.test(p.name)),
      })
    }
  }
  return out.filter((o) => o.path !== "/health").concat(out.filter((o) => o.path === "/health"))
}
