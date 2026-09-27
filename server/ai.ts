/**
 * Kivo AI layer — multiple OpenAI-compatible providers behind one streaming interface.
 *
 * Providers are configured from environment variables (keys never leave the daemon), checked
 * live, and combined into one model pool: the active provider's models come first, and other
 * healthy providers take over when it is rate-limited. A provider that can't authenticate is
 * reported as such and simply never used — nothing breaks.
 */

export interface Msg {
  role: "system" | "user" | "assistant"
  content: string
}

export interface Delta {
  channel: "reasoning" | "content"
  text: string
}

export interface StreamOpts {
  json?: boolean
  effort?: "low" | "medium" | "high"
  maxTokens?: number
  signal?: AbortSignal
  /** Called when rate-limited: which model, and how long until retry (ms, 0 = switching model). */
  onRateLimit?: (info: { model: string; waitMs: number; next: string }) => void
  /** Prefer the first model of the active provider (fall back only if its cooldown is long). */
  primaryOnly?: boolean
  /** Receives the finish reason ("stop", "length", …) and the model that answered. */
  onFinish?: (reason: string, model?: string) => void
}

export type ProviderStatus = "ok" | "unauthorized" | "unreachable" | "unconfigured" | "unknown"

interface Provider {
  id: string
  label: string
  baseUrl: string
  key?: string
  /** Header used to send the key; "authorization" means `Authorization: Bearer <key>`. */
  authHeader: string
  models: string[]
  /** Model-specific extras (Groq's gpt-oss accepts reasoning_effort; others may reject it). */
  reasoningEffort: boolean
  jsonMode: boolean
  /** Per-minute token budget to size requests against (free tiers are small). */
  tokenBudget: number
  status: ProviderStatus
  message?: string
  checkedAt?: number
}

const list = (v: string | undefined, fallback: string[]) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : fallback)

const providers: Provider[] = [
  {
    id: "groq",
    label: "Groq",
    baseUrl: process.env.GROQ_BASE_URL ?? "https://api.groq.com/openai/v1",
    key: process.env.GROQ_API_KEY,
    authHeader: "authorization",
    models: list([process.env.GROQ_MODEL, process.env.GROQ_FALLBACK_MODELS].filter(Boolean).join(",") || undefined, ["openai/gpt-oss-120b", "openai/gpt-oss-20b"]),
    reasoningEffort: true,
    jsonMode: true,
    tokenBudget: Number(process.env.GROQ_TPM ?? 8000),
    status: "unknown",
  },
  {
    id: "puku",
    label: "Puku",
    baseUrl: process.env.PUKU_BASE_URL ?? "https://api.puku.sh/v1",
    key: process.env.PUKU_API_KEY,
    authHeader: (process.env.PUKU_AUTH_HEADER ?? "authorization").toLowerCase(),
    models: list(process.env.PUKU_MODELS, ["puku-default", "puku-fast"]),
    reasoningEffort: false,
    jsonMode: process.env.PUKU_JSON_MODE === "1",
    tokenBudget: Number(process.env.PUKU_TPM ?? 32000),
    status: "unknown",
  },
  {
    id: "custom",
    label: process.env.OPENAI_COMPAT_LABEL ?? "OpenAI-compatible",
    baseUrl: process.env.OPENAI_COMPAT_BASE_URL ?? "",
    key: process.env.OPENAI_COMPAT_API_KEY,
    authHeader: "authorization",
    models: list(process.env.OPENAI_COMPAT_MODELS, []),
    reasoningEffort: false,
    jsonMode: process.env.OPENAI_COMPAT_JSON_MODE !== "0",
    tokenBudget: Number(process.env.OPENAI_COMPAT_TPM ?? 32000),
    status: "unknown",
  },
]

/** Env vars holding provider secrets — stripped from every child process Kivo starts. */
export const SECRET_ENV = ["GROQ_API_KEY", "PUKU_API_KEY", "OPENAI_COMPAT_API_KEY"]

let activeId = process.env.KIVO_PROVIDER ?? "groq"
const crossProvider = process.env.KIVO_CROSS_PROVIDER_FAILOVER !== "0"

const configured = (p: Provider) => Boolean(p.key && p.baseUrl && p.models.length)
const usable = (p: Provider) => configured(p) && p.status !== "unauthorized" && p.status !== "unreachable"

function headers(p: Provider): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" }
  if (p.key) {
    if (p.authHeader === "authorization") h.Authorization = `Bearer ${p.key}`
    else h[p.authHeader] = p.key
  }
  return h
}

/** Live check: list models (cheap, no tokens). Returns a human-readable reason on failure. */
export async function checkProvider(p: Provider) {
  if (!configured(p)) {
    p.status = "unconfigured"
    p.message = !p.key ? "No API key set" : !p.baseUrl ? "No base URL set" : "No models configured"
    return p
  }
  try {
    const res = await fetch(`${p.baseUrl}/models`, { headers: headers(p), signal: AbortSignal.timeout(10_000) })
    const text = await res.text()
    if (res.ok) {
      p.status = "ok"
      p.message = undefined
    } else if (res.status === 401 || res.status === 403) {
      p.status = "unauthorized"
      p.message = errorMessage(text) ?? `HTTP ${res.status}`
    } else if (res.status === 404) {
      // Some gateways don't expose /models; don't condemn them for it.
      p.status = "unknown"
      p.message = "Provider has no /models endpoint — will be verified on first use"
    } else {
      p.status = "unreachable"
      p.message = errorMessage(text) ?? `HTTP ${res.status}`
    }
  } catch (err) {
    p.status = "unreachable"
    p.message = (err as Error).message
  }
  p.checkedAt = Date.now()
  return p
}

export async function checkAll() {
  await Promise.all(providers.map(checkProvider))
  // If the chosen provider can't be used, fall back to the first one that can — and say so.
  if (!usable(active()) && providers.some(usable)) activeId = providers.find(usable)!.id
  return describe()
}

function errorMessage(text: string) {
  try {
    const j = JSON.parse(text)
    return j.error?.message ?? j.message ?? (typeof j.error === "string" ? j.error : undefined)
  } catch {
    return text.slice(0, 200) || undefined
  }
}

const active = () => providers.find((p) => p.id === activeId) ?? providers[0]

export function setActive(id: string) {
  const p = providers.find((x) => x.id === id)
  if (!p) throw new Error(`Unknown provider ${id}`)
  if (!configured(p)) throw new Error(`${p.label} is not configured`)
  if (!usable(p)) throw new Error(`${p.label} isn't available: ${p.message ?? p.status}`)
  activeId = id
  return describe()
}

export function describe() {
  return {
    active: activeId,
    model: active().models[0] ? `${active().models[0]}` : "",
    providers: providers.map((p) => ({ id: p.id, label: p.label, status: p.status, message: p.message, models: p.models, configured: configured(p), baseUrl: p.baseUrl })),
  }
}

export const aiAvailable = () => providers.some(usable)
export const currentModel = () => active().models[0] ?? "none"

/** Rough token estimate (≈3 chars/token for code + English). */
export const estimateTokens = (msgs: Msg[]) => Math.ceil(msgs.reduce((a, m) => a + m.content.length, 0) / 3) + 40

interface Target {
  provider: Provider
  model: string
  key: string
}

/** Active provider first, then (optionally) other healthy providers. */
function pool(): Target[] {
  const order = [active(), ...(crossProvider ? providers.filter((p) => p !== active()) : [])].filter(usable)
  return order.flatMap((p) => p.models.map((model) => ({ provider: p, model, key: `${p.id}:${model}` })))
}

const limitedUntil = new Map<string, number>()

class RateLimited extends Error {
  constructor(
    public waitMs: number,
    public requested?: number,
    public limit?: number,
  ) {
    super("rate limited")
  }
}

class Unauthorized extends Error {}

function parseWait(res: Response, body: string) {
  const header = Number(res.headers.get("retry-after"))
  const m = body.match(/try again in (?:(\d+)m)?([\d.]+)s/)
  const fromBody = m ? (Number(m[1] ?? 0) * 60 + Number(m[2])) * 1000 : NaN
  return Math.ceil((Number.isFinite(fromBody) ? fromBody : header > 0 ? header * 1000 : 10_000) + 250)
}

const label = (t: Target) => (pool().length && t.provider.id !== activeId ? `${t.provider.label} · ${t.model}` : t.model)

/** Streams reasoning + content deltas. Resolves with the full content. */
export async function stream(messages: Msg[], onDelta: (d: Delta) => void, opts: StreamOpts = {}): Promise<string> {
  const deadline = Date.now() + 180_000
  let cap = opts.maxTokens ?? 4096
  while (Date.now() < deadline) {
    const now = Date.now()
    const all = pool()
    if (!all.length) throw new Error("No AI provider is available — check the provider status in Kivo's top bar.")
    // "Primary only" is a preference: if the primary model's cooldown is long, fall back rather than stall.
    const candidates = opts.primaryOnly && (limitedUntil.get(all[0].key) ?? 0) - now < 30_000 ? [all[0]] : all
    const target = candidates.find((t) => (limitedUntil.get(t.key) ?? 0) <= now)
    if (!target) {
      const soonest = Math.min(...candidates.map((t) => limitedUntil.get(t.key) ?? now))
      const wait = Math.max(500, soonest - now)
      opts.onRateLimit?.({ model: label(candidates[0]), waitMs: wait, next: label(candidates[0]) })
      await sleep(wait, opts.signal)
      continue
    }
    try {
      return await once(target, messages, onDelta, { ...opts, maxTokens: cap })
    } catch (err) {
      if (err instanceof Unauthorized) {
        // Credential rejected mid-session: take the provider out of rotation and carry on with the rest.
        target.provider.status = "unauthorized"
        target.provider.message = err.message
        if (target.provider.id === activeId && providers.some(usable)) activeId = providers.find(usable)!.id
        continue
      }
      if (!(err instanceof RateLimited)) throw err
      if (err.requested && err.limit && err.requested > err.limit * 0.95) {
        cap = Math.max(1024, cap - (err.requested - Math.floor(err.limit * 0.9)))
        continue
      }
      limitedUntil.set(target.key, Date.now() + err.waitMs)
      const next = pool().find((t) => (limitedUntil.get(t.key) ?? 0) <= Date.now())
      opts.onRateLimit?.({ model: label(target), waitMs: next ? 0 : err.waitMs, next: next ? label(next) : label(target) })
    }
  }
  throw new Error("AI providers still rate-limited after 3 minutes of retries")
}

async function once(t: Target, messages: Msg[], onDelta: (d: Delta) => void, opts: StreamOpts) {
  const p = t.provider
  const budget = p.tokenBudget - 200 - estimateTokens(messages)
  const res = await fetch(`${p.baseUrl}/chat/completions`, {
    method: "POST",
    headers: headers(p),
    signal: opts.signal,
    body: JSON.stringify({
      model: t.model,
      messages,
      stream: true,
      max_tokens: Math.max(1024, Math.min(opts.maxTokens ?? 4096, budget)),
      ...(p.reasoningEffort ? { reasoning_effort: opts.effort ?? "low" } : {}),
      ...(opts.json && p.jsonMode ? { response_format: { type: "json_object" } } : {}),
    }),
  })
  if (res.status === 429 || res.status === 413) {
    const text = await res.text()
    const requested = Number(text.match(/Requested (\d+)/)?.[1]) || undefined
    const limit = Number(text.match(/Limit (\d+)/)?.[1]) || undefined
    throw new RateLimited(parseWait(res, text), requested, limit)
  }
  if (res.status === 401 || res.status === 403) throw new Unauthorized(errorMessage(await res.text()) ?? `HTTP ${res.status}`)
  if (!res.ok || !res.body) throw new Error(`${p.label} ${res.status}: ${(await res.text()).slice(0, 300)}`)
  if (p.status !== "ok") {
    p.status = "ok"
    p.message = undefined
  }

  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ""
  let content = ""
  let finish = "stop"
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i: number
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line.startsWith("data:")) continue
      const data = line.slice(5).trim()
      if (data === "[DONE]") continue
      try {
        const parsed = JSON.parse(data)
        if (parsed.error) throw new Error(parsed.error.message ?? String(parsed.error))
        if (parsed.choices?.[0]?.finish_reason) finish = parsed.choices[0].finish_reason
        const delta = parsed.choices?.[0]?.delta ?? {}
        const reasoning = delta.reasoning ?? delta.reasoning_content
        if (reasoning) onDelta({ channel: "reasoning", text: reasoning })
        if (delta.content) {
          content += delta.content
          onDelta({ channel: "content", text: delta.content })
        }
      } catch (e) {
        if (e instanceof Error && !(e instanceof SyntaxError)) throw e
      }
    }
  }
  opts.onFinish?.(finish, `${p.id}:${t.model}`)
  return content
}

/** Models without JSON mode may wrap JSON in prose or fences — pull out the first object. */
export function parseJsonLoose<T>(text: string): T {
  try {
    return JSON.parse(text) as T
  } catch {
    const start = text.indexOf("{")
    const end = text.lastIndexOf("}")
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1)) as T
    throw new Error("The model did not return JSON")
  }
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t)
        reject(new Error("aborted"))
      },
      { once: true },
    )
  })
}
