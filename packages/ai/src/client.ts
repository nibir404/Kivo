/**
 * Kivo AI layer — multiple OpenAI-compatible providers behind one streaming interface.
 *
 * Providers are configured by the host (`configure`: the daemon from its environment, the browser
 * from the user's own settings), checked
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

/** What a host (the daemon from its environment, the browser from its settings) says about one provider. */
export interface ProviderConfig {
  id: string
  label: string
  baseUrl: string
  key?: string
  /** Header used to send the key; "authorization" (the default) means `Authorization: Bearer <key>`. */
  authHeader?: string
  models: string[]
  reasoningEffort?: boolean
  jsonMode?: boolean
  tokenBudget?: number
}

export const GROQ_DEFAULTS = { id: "groq", label: "Groq", baseUrl: "https://api.groq.com/openai/v1", models: ["openai/gpt-oss-120b", "openai/gpt-oss-20b"], reasoningEffort: true, jsonMode: true, tokenBudget: 8000 } satisfies ProviderConfig

let providers: Provider[] = []
let activeId = "groq"
let crossProvider = true

/**
 * Set the providers this process can use. Called once at startup by the daemon, and by the browser
 * whenever the user changes their key. Statuses start "unknown" until `checkAll` runs.
 */
export function configure(defs: ProviderConfig[], opts: { active?: string; crossProvider?: boolean } = {}) {
  providers = defs.map((d) => ({
    id: d.id,
    label: d.label,
    baseUrl: d.baseUrl.replace(/\/+$/, ""),
    key: d.key || undefined,
    authHeader: (d.authHeader ?? "authorization").toLowerCase(),
    models: d.models,
    reasoningEffort: d.reasoningEffort ?? false,
    jsonMode: d.jsonMode ?? true,
    tokenBudget: d.tokenBudget ?? 32000,
    status: "unknown",
  }))
  activeId = opts.active ?? providers[0]?.id ?? "groq"
  crossProvider = opts.crossProvider ?? true
  limitedUntil.clear()
}

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
  const a = active()
  if ((!a || !usable(a)) && providers.some(usable)) activeId = providers.find(usable)!.id
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

const active = (): Provider | undefined => providers.find((p) => p.id === activeId) ?? providers[0]

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
    model: active()?.models[0] ?? "",
    providers: providers.map((p) => ({ id: p.id, label: p.label, status: p.status, message: p.message, models: p.models, configured: configured(p), baseUrl: p.baseUrl })),
  }
}

export const aiAvailable = () => providers.some(usable)
export const currentModel = () => active()?.models[0] ?? "none"

/** Rough token estimate (≈3 chars/token for code + English). */
export const estimateTokens = (msgs: Msg[]) => Math.ceil(msgs.reduce((a, m) => a + m.content.length, 0) / 3) + 40

interface Target {
  provider: Provider
  model: string
  key: string
}

/** Active provider first, then (optionally) other healthy providers. */
function pool(): Target[] {
  const a = active()
  if (!a) return []
  const order = [a, ...(crossProvider ? providers.filter((p) => p !== a) : [])].filter(usable)
  return order.flatMap((p) => p.models.map((model) => ({ provider: p, model, key: `${p.id}:${model}` })))
}

const limitedUntil = new Map<string, number>()

class RateLimited extends Error {
  waitMs: number
  requested?: number
  limit?: number
  constructor(waitMs: number, requested?: number, limit?: number) {
    super("rate limited")
    this.waitMs = waitMs
    this.requested = requested
    this.limit = limit
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
  return failover(opts, (t, cap) => guarded(t, opts, (signal, bump) => onceInner(t, messages, onDelta, { ...opts, maxTokens: cap }, signal, bump)))
}

/**
 * The shared retry loop: picks the first model in the pool that isn't cooling down, waits out
 * 429s (or fails over to the next model/provider), shrinks the answer budget when the prompt is
 * close to the per-minute limit, and drops providers whose credentials are rejected.
 */
async function failover<T>(opts: StreamOpts, attempt: (t: Target, cap: number) => Promise<T>): Promise<T> {
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
      return await attempt(target, cap)
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
        // Already at the smallest answer budget: the prompt itself is over the limit, so retrying can't help.
        if (cap <= 1024)
          throw new Error(`This request is too large for ${label(target)} (${err.requested} tokens against a limit of ${err.limit} per minute). Shorten it, or use a provider with a higher limit.`)
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

/** No response headers, or no streamed bytes, for this long means the provider has stalled. */
const STALL_MS = 90_000

/** Runs one request with the caller's abort signal plus a stall watchdog, so a hung provider can't hang a build. */
async function guarded<T>(t: Target, opts: StreamOpts, fn: (signal: AbortSignal, bump: () => void) => Promise<T>): Promise<T> {
  const p = t.provider
  if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError")
  const ac = new AbortController()
  const forward = () => ac.abort()
  opts.signal?.addEventListener("abort", forward, { once: true })
  let stalled = false
  let watchdog: ReturnType<typeof setTimeout> | undefined
  const bump = () => {
    clearTimeout(watchdog)
    watchdog = setTimeout(() => {
      stalled = true
      ac.abort()
    }, STALL_MS)
  }
  bump()
  try {
    return await fn(ac.signal, bump)
  } catch (err) {
    if (stalled) throw new Error(`${p.label} stopped responding (nothing received for ${STALL_MS / 1000}s)`)
    throw err
  } finally {
    clearTimeout(watchdog)
    opts.signal?.removeEventListener("abort", forward)
  }
}

/** Turn a non-OK provider response into the error type the failover loop understands. */
async function failure(p: Provider, res: Response): Promise<never> {
  const text = await res.text()
  if (res.status === 429 || res.status === 413) {
    const requested = Number(text.match(/Requested (\d+)/)?.[1]) || undefined
    const limit = Number(text.match(/Limit (\d+)/)?.[1]) || undefined
    throw new RateLimited(parseWait(res, text), requested, limit)
  }
  if (res.status === 401 || res.status === 403) throw new Unauthorized(errorMessage(text) ?? `HTTP ${res.status}`)
  throw new ProviderError(res.status, `${p.label} ${res.status}: ${(errorMessage(text) ?? text).slice(0, 300)}`, text)
}

/** A 4xx/5xx from the provider that isn't a rate limit or an auth failure (e.g. a malformed tool call). */
export class ProviderError extends Error {
  status: number
  body: string
  constructor(status: number, message: string, body: string) {
    super(message)
    this.status = status
    this.body = body
  }
}

async function onceInner(t: Target, messages: Msg[], onDelta: (d: Delta) => void, opts: StreamOpts, signal: AbortSignal, bump: () => void) {
  const p = t.provider
  const budget = p.tokenBudget - 200 - estimateTokens(messages)
  const res = await fetch(`${p.baseUrl}/chat/completions`, {
    method: "POST",
    headers: headers(p),
    signal,
    body: JSON.stringify({
      model: t.model,
      messages,
      stream: true,
      max_tokens: Math.max(1024, Math.min(opts.maxTokens ?? 4096, budget)),
      ...(p.reasoningEffort ? { reasoning_effort: opts.effort ?? "low" } : {}),
      ...(opts.json && p.jsonMode ? { response_format: { type: "json_object" } } : {}),
    }),
  })
  if (!res.ok || !res.body) return failure(p, res)
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
    bump()
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

// ─── Tool calling (agent) ─────────────────────────────────────────────────────

export interface ToolCall {
  id: string
  name: string
  /** Raw JSON arguments as the model produced them (may be malformed — the caller validates). */
  arguments: string
}

/** OpenAI-compatible chat message, including assistant tool calls and tool results. */
export type ChatMsg =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string }

export interface ToolDef {
  type: "function"
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export interface ToolTurn {
  content: string
  toolCalls: ToolCall[]
  finish: string
  model: string
  /** Prompt + completion tokens, from the provider's usage report when it sends one, else estimated. */
  tokens: number
}

/** Per-minute token budget of the provider that will answer next — the agent sizes its context to it. */
export const tokenBudget = () => (pool()[0]?.provider ?? active())?.tokenBudget ?? 8000

export const estimateChars = (chars: number) => Math.ceil(chars / 3)

/**
 * One assistant turn with tools available. Streams text deltas (and reasoning) as they arrive and
 * accumulates streamed tool-call fragments; shares the failover/429 logic with `stream`.
 */
export async function chatWithTools(messages: ChatMsg[], tools: ToolDef[], onDelta: (d: Delta) => void, opts: StreamOpts = {}): Promise<ToolTurn> {
  return failover(opts, (t, cap) => guarded(t, opts, (signal, bump) => toolsInner(t, messages, tools, onDelta, { ...opts, maxTokens: cap }, signal, bump)))
}

async function toolsInner(t: Target, messages: ChatMsg[], tools: ToolDef[], onDelta: (d: Delta) => void, opts: StreamOpts, signal: AbortSignal, bump: () => void): Promise<ToolTurn> {
  const p = t.provider
  const promptTokens = estimateChars(JSON.stringify(messages).length + JSON.stringify(tools).length)
  const room = p.tokenBudget - 200 - promptTokens
  const res = await fetch(`${p.baseUrl}/chat/completions`, {
    method: "POST",
    headers: headers(p),
    signal,
    body: JSON.stringify({
      model: t.model,
      messages,
      tools,
      tool_choice: "auto",
      stream: true,
      max_tokens: Math.max(512, Math.min(opts.maxTokens ?? 2048, room)),
      ...(p.reasoningEffort ? { reasoning_effort: opts.effort ?? "low" } : {}),
    }),
  })
  if (!res.ok || !res.body) return failure(p, res)
  const calls: { id: string; name: string; arguments: string }[] = []
  let content = ""
  let finish = "stop"
  let usage = 0
  const handle = (parsed: Record<string, unknown>) => {
    const err = parsed.error as { message?: string } | undefined
    if (err) throw new Error(err.message ?? String(err))
    const u = (parsed.usage ?? (parsed.x_groq as { usage?: unknown } | undefined)?.usage) as { total_tokens?: number } | undefined
    if (u?.total_tokens) usage = u.total_tokens
    const choice = (parsed.choices as Record<string, unknown>[] | undefined)?.[0]
    if (!choice) return
    if (choice.finish_reason) finish = String(choice.finish_reason)
    // Streamed chunks carry `delta`; a non-streamed reply (some gateways ignore stream:true) carries `message`.
    const delta = (choice.delta ?? choice.message ?? {}) as Record<string, unknown>
    const reasoning = (delta.reasoning ?? delta.reasoning_content) as string | undefined
    if (reasoning) onDelta({ channel: "reasoning", text: reasoning })
    if (typeof delta.content === "string" && delta.content) {
      content += delta.content
      onDelta({ channel: "content", text: delta.content })
    }
    for (const [n, tc] of ((delta.tool_calls as Record<string, unknown>[] | undefined) ?? []).entries()) {
      const i = typeof tc.index === "number" ? tc.index : n
      const fn = (tc.function ?? {}) as { name?: string; arguments?: string }
      const c = (calls[i] ??= { id: "", name: "", arguments: "" })
      if (tc.id) c.id = String(tc.id)
      if (fn.name) c.name += fn.name
      if (fn.arguments) c.arguments += fn.arguments
    }
  }
  if (!(res.headers.get("content-type") ?? "").includes("event-stream")) {
    handle((await res.json()) as Record<string, unknown>)
  } else {
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ""
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bump()
      buf += dec.decode(value, { stream: true })
      let i: number
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line.startsWith("data:")) continue
        const data = line.slice(5).trim()
        if (data === "[DONE]") continue
        let parsed: Record<string, unknown>
        try {
          parsed = JSON.parse(data)
        } catch {
          continue
        }
        handle(parsed)
      }
    }
  }
  if (p.status !== "ok") {
    p.status = "ok"
    p.message = undefined
  }
  const toolCalls = calls.filter((c) => c?.name).map((c, i) => ({ id: c.id || `call_${Date.now().toString(36)}_${i}`, name: c.name, arguments: c.arguments || "{}" }))
  opts.onFinish?.(finish, `${p.id}:${t.model}`)
  return { content, toolCalls, finish, model: label(t), tokens: usage || promptTokens + estimateChars(content.length + JSON.stringify(toolCalls).length) }
}

// ─── Fast completion (editor ghost text) ─────────────────────────────────────

export class CompletionRateLimited extends Error {
  waitMs: number
  constructor(waitMs: number) {
    super("rate limited")
    this.waitMs = waitMs
  }
}

/**
 * Single-shot, non-streamed completion for editor autocomplete. Prefers the smallest model (the last
 * one listed for the active provider) so it doesn't eat the main model's per-minute budget, never
 * waits on a 429 — it reports the cooldown so the editor can back off — and tries at most two models.
 */
export async function quickComplete(messages: Msg[], opts: { signal?: AbortSignal; maxTokens?: number } = {}): Promise<{ text: string; model: string }> {
  const all = pool()
  if (!all.length) throw new Error("No AI provider is available")
  const own = all.filter((t) => t.provider === all[0].provider)
  // The main model stays reserved for chat and the agent whenever a smaller one exists.
  const order = [...(own.length > 1 ? own.slice(1).reverse() : own), ...all.filter((t) => t.provider !== all[0].provider)]
  const now = Date.now()
  const ready = order.filter((t) => (limitedUntil.get(t.key) ?? 0) <= now).slice(0, 2)
  if (!ready.length) throw new CompletionRateLimited(Math.max(1000, Math.min(...order.map((t) => (limitedUntil.get(t.key) ?? now) - now))))
  let lastWait = 0
  for (const t of ready) {
    const p = t.provider
    const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000)
    const res = await fetch(`${p.baseUrl}/chat/completions`, {
      method: "POST",
      headers: headers(p),
      signal,
      body: JSON.stringify({
        model: t.model,
        messages,
        stream: false,
        temperature: 0.1,
        // Reasoning models spend part of this on thinking even at "low"; the answer itself is trimmed later.
        max_tokens: opts.maxTokens ?? 512,
        ...(p.reasoningEffort ? { reasoning_effort: "low" } : {}),
      }),
    })
    if (res.ok) {
      const j = (await res.json()) as { choices?: { message?: { content?: string } }[] }
      return { text: j.choices?.[0]?.message?.content ?? "", model: t.model }
    }
    try {
      await failure(p, res)
    } catch (err) {
      if (err instanceof RateLimited) {
        limitedUntil.set(t.key, Date.now() + err.waitMs)
        lastWait = err.waitMs
        continue
      }
      if (err instanceof Unauthorized) {
        p.status = "unauthorized"
        p.message = err.message
        continue
      }
      throw err
    }
  }
  throw new CompletionRateLimited(lastWait || 5000)
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
    if (signal?.aborted) return reject(new Error("aborted"))
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
