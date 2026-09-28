import type { HttpMethod, Level, LogLine, RuntimeSpan, Trace } from "./types"

/**
 * Runtime simulator. In production these traces arrive from OpenTelemetry collectors
 * attached to sandboxed processes; the Runtime Agent maps span attributes back to
 * System Graph nodes and IR requirement ids so every event is explainable.
 */

interface SpanTemplate {
  nodeId: string
  name: string
  base: number
  jitter: number
  concept?: string
  narration: Record<Level, string>
}

interface RouteTemplate {
  method: HttpMethod
  route: string
  requires?: string
  weight: number
  spans: SpanTemplate[]
}

const n = (beginner: string, intermediate: string, advanced: string, expert: string) => ({ beginner, intermediate, advanced, expert })

const ROUTES: RouteTemplate[] = [
  {
    method: "POST",
    route: "/auth/login",
    requires: "authentication",
    weight: 3,
    spans: [
      { nodeId: "gateway", name: "API request received", base: 0.8, jitter: 0.4, concept: "api-gateway", narration: n("The app's login request reached the server.", "Gateway matched prefix /auth → authentication:8000", "Traefik router `auth@docker`, traceparent injected", "Extra hop ≈0.8ms; TLS terminated upstream, HTTP/1.1 keep-alive to service") },
      { nodeId: "authentication", name: "Request validated", base: 0.6, jitter: 0.3, concept: "pydantic", narration: n("The server checked the email and password were filled in properly.", "LoginRequest schema validated", "Pydantic v2 model_validate on EmailStr + constr", "Rust-core validation ≈0.3ms; negligible vs I/O") },
      { nodeId: "redis", name: "Rate limit checked", base: 0.4, jitter: 0.3, concept: "rate-limiting", narration: n("The server made sure nobody is guessing passwords too fast.", "INCR rl:login:<ip> → 1/5", "redis.asyncio pipeline INCR+EXPIRE", "Fixed window; single RTT via pipelining") },
      { nodeId: "postgres", name: "Database query executed", base: 4.2, jitter: 2, concept: "postgresql", narration: n("The server looked up the account.", "SELECT user by email (index scan)", "asyncpg: SELECT … WHERE lower(email)=$1 using users_email_key", "Index scan, 1 buffer hit; pool wait 0ms (3/10 in use)") },
      { nodeId: "authentication", name: "Password verification", base: 71, jitter: 8, concept: "password-hashing", narration: n("The password was checked against its secure fingerprint.", "bcrypt.verify(password, hash)", "passlib bcrypt cost=12 in threadpool executor", "CPU-bound ≈71ms — dominant span. Tune cost factor or isolate workers under load") },
      { nodeId: "authentication", name: "JWT generated", base: 0.3, jitter: 0.1, concept: "jwt", narration: n("A login token was created for the app.", "Access token issued (15 min)", "PyJWT HS256 sign, claims sub/exp/jti", "HMAC-SHA256 ≈0.05ms") },
      { nodeId: "redis", name: "Refresh session stored", base: 0.5, jitter: 0.3, concept: "refresh-tokens", narration: n("The server remembered the login so the app can stay signed in.", "SET session:<id> EX 14d", "Hashed opaque token, family id for reuse detection", "Single SET; volatile by design") },
      { nodeId: "mobile", name: "Response returned", base: 1.2, jitter: 0.5, concept: "rest", narration: n("The app received the token and opened the home screen.", "HTTP 200 TokenPair", "orjson serialization, expo-secure-store write", "Payload 612B; client total dominated by network RTT") },
    ],
  },
  {
    method: "GET",
    route: "/users/me",
    weight: 4,
    spans: [
      { nodeId: "gateway", name: "API request received", base: 0.7, jitter: 0.3, concept: "api-gateway", narration: n("The app asked for the user's profile.", "Gateway → users:8000", "Traefik router `users@docker`", "JWT verified at edge") },
      { nodeId: "users", name: "Token verified", base: 0.2, jitter: 0.1, concept: "jwt", narration: n("The server checked the login token is genuine.", "JWT signature + exp checked", "Depends(current_user) → PyJWT decode", "Stateless — no DB hit") },
      { nodeId: "redis", name: "Cache lookup", base: 0.4, jitter: 0.2, concept: "caching", narration: n("The server checked for a saved copy of the profile.", "GET profile:<id>", "cache-aside read", "Hit ratio 92% (last 5 min)") },
      { nodeId: "postgres", name: "Database query executed", base: 3.1, jitter: 1.5, concept: "postgresql", narration: n("The profile was loaded from the database.", "SELECT profile by id", "asyncpg PK lookup", "Only on cache miss") },
      { nodeId: "mobile", name: "Response returned", base: 1, jitter: 0.4, concept: "rest", narration: n("The profile appeared on screen.", "HTTP 200", "TanStack Query cache updated", "Stale-while-revalidate 30s") },
    ],
  },
  {
    method: "POST",
    route: "/notify",
    weight: 1,
    spans: [
      { nodeId: "gateway", name: "API request received", base: 0.7, jitter: 0.3, concept: "api-gateway", narration: n("A request to send a message arrived.", "Gateway → notifications", "Traefik router", "—") },
      { nodeId: "notifications", name: "Message enqueued", base: 1.1, jitter: 0.5, concept: "redis", narration: n("The message was put in line to be sent.", "LPUSH notify:queue", "Redis list as work queue", "At-least-once; idempotency key on consumer") },
      { nodeId: "mobile", name: "Response returned", base: 0.8, jitter: 0.3, concept: "rest", narration: n("The server replied right away; sending happens in the background.", "HTTP 202 Accepted", "Async handoff", "Keeps p99 low") },
    ],
  },
]

let seq = 0
const id = (p: string) => `${p}_${(++seq).toString(36)}`

export function nextTrace(running: Set<string>): Trace {
  const eligible = ROUTES.filter((r) => !r.requires || running.has(r.requires))
  const total = eligible.reduce((a, r) => a + r.weight, 0)
  let pick = Math.random() * total
  const route = eligible.find((r) => (pick -= r.weight) < 0) ?? eligible[0]
  const traceId = id("tr")

  // Occasionally fail a login (wrong password) or slow a query, so Observe has something to explain.
  const failLogin = route.route === "/auth/login" && Math.random() < 0.12
  const slowQuery = Math.random() < 0.06

  let offset = 0
  const spans: RuntimeSpan[] = []
  for (const s of route.spans) {
    if (failLogin && s.name === "JWT generated") break
    let dur = Math.max(0.1, s.base + (Math.random() - 0.5) * 2 * s.jitter)
    let status: RuntimeSpan["status"] = "ok"
    if (slowQuery && s.nodeId === "postgres") {
      dur *= 9
      status = "slow"
    }
    if (failLogin && s.name === "Password verification") status = "error"
    spans.push({ id: id("sp"), traceId, nodeId: s.nodeId, name: s.name, durationMs: round(dur), offsetMs: round(offset), status, concept: s.concept, narration: s.narration })
    offset += dur
  }
  if (failLogin) {
    spans.push({
      id: id("sp"),
      traceId,
      nodeId: "mobile",
      name: "Response returned",
      durationMs: 1,
      offsetMs: round(offset),
      status: "error",
      concept: "rest",
      narration: n(
        "The password didn't match, so the app showed 'Invalid credentials'.",
        "HTTP 401 Invalid credentials",
        "HTTPException(401) raised after bcrypt mismatch",
        "Constant-time compare; same latency as success to avoid user enumeration",
      ),
    })
  }
  return {
    id: traceId,
    route: route.route,
    method: route.method,
    status: failLogin ? 401 : route.route === "/notify" ? 202 : 200,
    totalMs: round(offset + (failLogin ? 1 : 0)),
    at: Date.now(),
    spans,
  }
}

export function logsFor(trace: Trace): LogLine[] {
  const src = trace.route.startsWith("/auth") ? "authentication" : trace.route.startsWith("/users") ? "users" : "notifications"
  const lines: LogLine[] = [
    { id: id("lg"), at: trace.at, level: trace.status >= 400 ? "warn" : "info", source: src, message: `${trace.method} ${trace.route} ${trace.status} ${trace.totalMs}ms trace=${trace.id}` },
  ]
  const slow = trace.spans.find((s) => s.status === "slow")
  if (slow) lines.push({ id: id("lg"), at: trace.at, level: "warn", source: "postgres", message: `slow query ${slow.durationMs}ms (threshold 20ms) — seq scan suspected` })
  return lines
}

const round = (x: number) => Math.round(x * 10) / 10
