import type { Decision, Endpoint, Entity, Requirement, ServiceSpec, StackChoice } from "./types"
import { frameworkName, languageName } from "./stacks"

/**
 * Intent Parser.
 *
 * Production: the Intent Agent produces a ServiceSpec under a strict JSON schema, grounded
 * in the Project Graph (existing stack, services, conventions). Anything ambiguous comes back
 * as an explicit question rather than a guess.
 *
 * Prototype: a deterministic template matcher with the same output contract, so every
 * downstream stage (planner, generator, runtime, explanation) is exercised end-to-end.
 */

interface Template {
  match: RegExp
  name: string
  purpose: string
  requirements: [string, string, string][]
  entities: Entity[]
  endpoints: Endpoint[]
  auth?: { strategy: string; reason: string }
  cache?: boolean
  dependsOn: string[]
  extraDecisions?: Decision[]
}

const TEMPLATES: Template[] = [
  {
    match: /auth|login|sign ?in|register|password/i,
    name: "Authentication",
    purpose: "Lets people create an account, prove who they are, and stay signed in securely.",
    requirements: [
      ["registration", "Registration", "Create an account with email and password"],
      ["email_verification", "Email verification", "Confirm ownership of the email address"],
      ["login", "Login", "Exchange credentials for a session"],
      ["session_refresh", "Session refresh", "Renew sessions without re-entering the password"],
      ["password_reset", "Password reset", "Recover access via a signed email link"],
    ],
    entities: [
      {
        name: "User",
        fields: [
          { name: "id", type: "uuid" },
          { name: "email", type: "citext", note: "unique, indexed" },
          { name: "password_hash", type: "text", note: "bcrypt, never the raw password" },
          { name: "email_verified_at", type: "timestamptz?" },
          { name: "created_at", type: "timestamptz" },
        ],
      },
      {
        name: "RefreshSession",
        fields: [
          { name: "id", type: "opaque token (hashed)" },
          { name: "user_id", type: "uuid" },
          { name: "family", type: "uuid", note: "for reuse detection" },
          { name: "expires_at", type: "ttl 14d" },
        ],
      },
    ],
    endpoints: [
      { method: "POST", path: "/auth/register", summary: "Create account", requirement: "registration", auth: false },
      { method: "POST", path: "/auth/verify-email", summary: "Confirm email token", requirement: "email_verification", auth: false },
      { method: "POST", path: "/auth/login", summary: "Issue access + refresh token", requirement: "login", auth: false },
      { method: "POST", path: "/auth/refresh", summary: "Rotate refresh token", requirement: "session_refresh", auth: false },
      { method: "POST", path: "/auth/password/forgot", summary: "Email reset link", requirement: "password_reset", auth: false },
      { method: "POST", path: "/auth/password/reset", summary: "Set new password", requirement: "password_reset", auth: false },
      { method: "GET", path: "/auth/me", summary: "Current user", requirement: "login", auth: true },
    ],
    auth: { strategy: "jwt + rotating refresh tokens", reason: "Stateless verification on every request, revocable long-lived sessions." },
    cache: true,
    dependsOn: ["notifications"],
    extraDecisions: [
      {
        topic: "Password storage",
        choice: "bcrypt (cost 12)",
        reason: "Irreversible, salted, deliberately slow to brute-force.",
        alternatives: ["argon2id", "scrypt"],
      },
    ],
  },
  {
    match: /pay|stripe|checkout|billing|subscription/i,
    name: "Payments",
    purpose: "Charges customers and keeps an auditable record of every payment.",
    requirements: [
      ["checkout", "Checkout", "Create a payment for an order"],
      ["webhooks", "Webhook handling", "Record results Stripe reports asynchronously"],
      ["refunds", "Refunds", "Return money for an order"],
      ["history", "Payment history", "List a user's payments"],
    ],
    entities: [
      {
        name: "Payment",
        fields: [
          { name: "id", type: "uuid" },
          { name: "user_id", type: "uuid" },
          { name: "amount_cents", type: "integer" },
          { name: "currency", type: "char(3)" },
          { name: "stripe_intent_id", type: "text", note: "unique" },
          { name: "status", type: "enum" },
        ],
      },
    ],
    endpoints: [
      { method: "POST", path: "/payments/intents", summary: "Create PaymentIntent", requirement: "checkout", auth: true },
      { method: "POST", path: "/payments/webhook", summary: "Stripe webhook (signed)", requirement: "webhooks", auth: false },
      { method: "POST", path: "/payments/{id}/refund", summary: "Refund", requirement: "refunds", auth: true },
      { method: "GET", path: "/payments", summary: "List payments", requirement: "history", auth: true },
    ],
    dependsOn: ["authentication"],
    extraDecisions: [
      {
        topic: "Card handling",
        choice: "Stripe PaymentIntents",
        reason: "Card data never touches our servers, so PCI scope stays minimal.",
        alternatives: ["Adyen", "Braintree"],
      },
    ],
  },
  {
    match: /notif|email|push|sms|alert/i,
    name: "Notifications",
    purpose: "Delivers email and push messages reliably without slowing down user requests.",
    requirements: [
      ["enqueue", "Enqueue", "Accept a message and return immediately"],
      ["deliver", "Deliver", "Send via email or push with retries"],
      ["preferences", "Preferences", "Respect user opt-outs"],
    ],
    entities: [
      {
        name: "Notification",
        fields: [
          { name: "id", type: "uuid" },
          { name: "user_id", type: "uuid" },
          { name: "channel", type: "enum(email, push)" },
          { name: "status", type: "enum" },
        ],
      },
    ],
    endpoints: [
      { method: "POST", path: "/notify", summary: "Enqueue a notification", requirement: "enqueue", auth: true },
      { method: "GET", path: "/notify/preferences", summary: "Get preferences", requirement: "preferences", auth: true },
    ],
    cache: true,
    dependsOn: [],
  },
]

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")

function genericTemplate(text: string): Template {
  const words = text.replace(/^(create|add|build|make)\s+(an?\s+)?/i, "").split(/\s+/).slice(0, 3).join(" ")
  const name = words.replace(/\b(service|system)\b/gi, "").trim().replace(/^\w/, (c) => c.toUpperCase()) || "New Service"
  return {
    match: /.*/,
    name,
    purpose: `Implements: "${text.trim()}"`,
    requirements: [["core", "Core behaviour", text.trim()]],
    entities: [{ name: name.replace(/\s+/g, ""), fields: [{ name: "id", type: "uuid" }, { name: "created_at", type: "timestamptz" }] }],
    endpoints: [
      { method: "GET", path: `/${slug(name)}`, summary: "List", requirement: "core", auth: true },
      { method: "POST", path: `/${slug(name)}`, summary: "Create", requirement: "core", auth: true },
    ],
    dependsOn: ["authentication"],
  }
}

export function parseIntent(text: string, stack: StackChoice): ServiceSpec {
  const t = TEMPLATES.find((x) => x.match.test(text)) ?? genericTemplate(text)
  const requirements: Requirement[] = t.requirements.map(([id, title, description]) => ({ id, title, description }))
  const lang = languageName(stack.language)
  const fw = frameworkName(stack.language, stack.framework)
  const db = stack.database ?? "PostgreSQL"
  const cache = t.cache && stack.cache && stack.cache !== "None" ? stack.cache : undefined

  const decisions: Decision[] = [
    {
      topic: "Language & framework",
      choice: `${lang} · ${fw}`,
      reason: "Matches the existing backend detected in this repository — one runtime, shared conventions.",
      alternatives: ["TypeScript · Express", "Go · Chi"].filter((a) => !a.startsWith(lang)),
    },
    {
      topic: "Storage",
      choice: db,
      reason: `${t.name} owns structured records that must persist and stay consistent.`,
      alternatives: ["MySQL", "SQLite (dev only)"],
    },
    ...(cache
      ? [{ topic: "Cache", choice: cache, reason: "Short-lived, frequently read data (sessions, counters).", alternatives: ["In-process LRU", "Memcached"] }]
      : []),
    ...(t.extraDecisions ?? []),
  ]

  return {
    id: slug(t.name),
    name: t.name,
    purpose: t.purpose,
    intent: text.trim(),
    requirements,
    entities: t.entities,
    storage: { type: db, reason: `persistent structured ${t.name.toLowerCase()} data` },
    cache: cache ? { type: cache, reason: "sessions, rate limits, hot reads" } : undefined,
    api: { style: "rest", endpoints: t.endpoints },
    authentication: t.auth,
    implementation: { ...stack, cache },
    dependsOn: t.dependsOn,
    decisions,
    status: "draft",
    files: [],
    tests: [],
  }
}

/** Serialise a spec to the YAML shown in the Spec tab. */
export function specToYaml(s: ServiceSpec): string {
  const lines: string[] = []
  lines.push("service:", `  name: ${s.id}`, `  purpose: "${s.purpose}"`, "")
  lines.push("requirements:", ...s.requirements.map((r) => `  - ${r.id}`), "")
  lines.push("entities:")
  for (const e of s.entities) {
    lines.push(`  - name: ${e.name}`, "    fields:")
    for (const f of e.fields) lines.push(`      ${f.name}: ${f.type}${f.note ? `  # ${f.note}` : ""}`)
  }
  lines.push("", "storage:", `  type: ${s.storage.type.toLowerCase()}`)
  if (s.cache) lines.push("", "cache:", `  type: ${s.cache.type.toLowerCase()}`)
  lines.push("", "api:", `  style: ${s.api.style}`, "  endpoints:")
  for (const ep of s.api.endpoints) lines.push(`    - ${ep.method} ${ep.path}${ep.auth ? "  # auth" : ""}`)
  if (s.authentication) lines.push("", "authentication:", `  strategy: ${s.authentication.strategy}`)
  lines.push("", "implementation:", `  language: ${s.implementation.language}`, `  framework: ${s.implementation.framework}`)
  if (s.dependsOn.length) lines.push("", "depends_on:", ...s.dependsOn.map((d) => `  - ${d}`))
  return lines.join("\n")
}
