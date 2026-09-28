import { parseIntent } from "@kivo/core/intent"
import { detectStack, frameworksFor, LANGUAGES } from "@kivo/core/stacks"
import type { Decision, Endpoint, ProjectAnalysis, ServiceSpec, StackChoice } from "@kivo/core/types"
import { HttpError } from "./errors"

/**
 * The Service IR at the daemon boundary. Everything arriving here — from the model or from the
 * browser — is untrusted: it is coerced into typed shapes and validated before it can touch the
 * filesystem or a prompt.
 */

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")

/** Service ids become directory names (services/<id>), so they are strictly slugs. */
const SERVICE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"])

/** Model output is untrusted: coerce anything into a display string. */
export const str = (v: unknown): string =>
  typeof v === "string"
    ? v
    : v && typeof v === "object"
      ? str((v as Record<string, unknown>).text ?? (v as Record<string, unknown>).question ?? (v as Record<string, unknown>).name ?? (v as Record<string, unknown>).title ?? JSON.stringify(v))
      : v == null
        ? ""
        : String(v)
const strs = (v: unknown) => (Array.isArray(v) ? v.map(str).filter(Boolean) : [])

/** A stack from the browser, reduced to known languages and frameworks. */
export function sanitizeStack(input: unknown): StackChoice {
  const s = (input && typeof input === "object" ? input : {}) as Partial<StackChoice>
  const language = LANGUAGES.some((l) => l.id === s.language) ? s.language! : "python"
  const frameworks = frameworksFor(language)
  const framework = frameworks.some((f) => f.id === s.framework) ? s.framework! : frameworks[0].id
  return { language, framework, database: typeof s.database === "string" ? s.database : "PostgreSQL", cache: typeof s.cache === "string" ? s.cache : "Redis" }
}

/** The request text names a language ("…in Java") → that wins over the picker. */
export function resolveStack(text: string, stack: StackChoice): StackChoice {
  const named = detectStack(text)
  return named ? { ...stack, ...named } : stack
}

export interface ServiceSummary {
  id: string
  name: string
  language: string
  framework: string
  endpoints: string[]
}

/** Grounding for the Intent Agent, built from what actually exists — never hard-coded. */
export function projectContext(a: ProjectAnalysis, services: ServiceSummary[]) {
  const list = services.length
    ? services.map((s) => `- ${s.name} (id: ${s.id}, ${s.language} · ${s.framework})${s.endpoints.length ? `: ${s.endpoints.slice(0, 6).join(", ")}` : ""}`).join("\n")
    : "- (none yet)"
  return `Detected: ${a.detections.map((d) => `${d.tech} (${d.category})`).join(", ") || "nothing yet"}.\nExisting services:\n${list}\nLanguages: ${a.languages.map((l) => `${l.name} ${l.share}%`).join(", ") || "unknown"}.`
}

export function parseServices(v: unknown): ServiceSummary[] {
  if (!Array.isArray(v)) return []
  return v.slice(0, 50).map((s) => ({
    id: str(s?.id).slice(0, 64),
    name: str(s?.name).slice(0, 80),
    language: str(s?.language).slice(0, 20),
    framework: str(s?.framework).slice(0, 30),
    endpoints: strs(s?.endpoints).slice(0, 20),
  }))
}

/** Merge the model's JSON into a complete ServiceSpec, using the deterministic parse as defaults. */
export function normalizeSpec(ai: Record<string, unknown>, text: string, stack: StackChoice): ServiceSpec {
  const base = parseIntent(text, stack)
  const name = str(ai.name).trim() ? str(ai.name).trim().replace(/\s+service$/i, "") : base.name
  const reqs =
    Array.isArray(ai.requirements) && ai.requirements.length
      ? (ai.requirements as Record<string, unknown>[]).map((r) => ({ id: slug(str(r.id ?? r.title)).replace(/-/g, "_") || "core", title: str(r.title ?? r.id), description: str(r.description) }))
      : base.requirements
  const endpoints =
    Array.isArray(ai.endpoints) && ai.endpoints.length
      ? (ai.endpoints as Record<string, unknown>[])
          .map((e) => ({ method: str(e.method).toUpperCase() as Endpoint["method"], path: str(e.path), summary: str(e.summary), requirement: str(e.requirement), auth: Boolean(e.auth) }))
          .filter((e) => METHODS.has(e.method) && e.path.startsWith("/"))
      : base.api.endpoints
  const entities =
    Array.isArray(ai.entities) && ai.entities.length
      ? (ai.entities as Record<string, unknown>[]).map((e) => ({ name: str(e.name), fields: (Array.isArray(e.fields) ? e.fields : []).map((f: Record<string, unknown>) => ({ name: str(f.name), type: str(f.type), note: f.note ? str(f.note) : undefined })) }))
      : base.entities
  const aiDecisions: Decision[] = Array.isArray(ai.decisions) ? (ai.decisions as Record<string, unknown>[]).map((d) => ({ topic: str(d.topic), choice: str(d.choice), reason: str(d.reason), alternatives: strs(d.alternatives) })) : []
  const usesCache = ai.uses_cache === true && stack.cache && stack.cache !== "None"
  const auth = ai.authentication && typeof ai.authentication === "object" ? { strategy: str((ai.authentication as Record<string, unknown>).strategy), reason: str((ai.authentication as Record<string, unknown>).reason) } : undefined
  const reserved = ["Language & framework", "Storage", "Cache"]
  return {
    ...base,
    id: slug(name).slice(0, 63) || base.id,
    name,
    purpose: str(ai.purpose) || base.purpose,
    requirements: reqs,
    entities,
    api: { style: "rest", endpoints: endpoints.length ? endpoints : base.api.endpoints },
    authentication: auth,
    cache: usesCache ? { type: stack.cache!, reason: "sessions, rate limits, hot reads" } : undefined,
    // The language is the user's choice (named in the request or picked in the UI), never the model's.
    implementation: { ...stack, cache: usesCache ? stack.cache : undefined },
    dependsOn: Array.isArray(ai.depends_on) ? strs(ai.depends_on).map((d) => slug(d)) : base.dependsOn,
    decisions: [...base.decisions.filter((d) => d.topic === "Language & framework" || d.topic === "Storage" || (d.topic === "Cache" && usesCache)), ...aiDecisions.filter((d) => !reserved.includes(d.topic))],
    questions: strs(ai.questions),
  }
}

/** A spec arriving at /api/build. Rejects anything that could escape services/<id> or break the pipeline. */
export function validateBuildSpec(input: unknown): ServiceSpec {
  if (!input || typeof input !== "object") throw new HttpError(400, '"spec" must be an object')
  const spec = input as ServiceSpec
  if (typeof spec.id !== "string" || !SERVICE_ID.test(spec.id)) throw new HttpError(400, "Invalid service id — use lowercase letters, digits and dashes")
  if (typeof spec.name !== "string" || !spec.name.trim()) throw new HttpError(400, "Service name is missing")
  if (!Array.isArray(spec.requirements) || !spec.requirements.length) throw new HttpError(400, "A service needs at least one requirement")
  if (!spec.api || !Array.isArray(spec.api.endpoints)) throw new HttpError(400, "Service API is missing")
  if (!Array.isArray(spec.entities)) throw new HttpError(400, "Service entities are missing")
  if (!spec.storage || typeof spec.storage.type !== "string") throw new HttpError(400, "Service storage is missing")
  for (const r of spec.requirements) if (typeof r?.id !== "string" || !/^[a-z0-9_]{1,64}$/.test(r.id)) throw new HttpError(400, `Invalid requirement id: ${String(r?.id)}`)
  const cache = typeof spec.implementation?.cache === "string" ? spec.implementation.cache : undefined
  return { ...spec, implementation: { ...sanitizeStack(spec.implementation), cache }, dependsOn: Array.isArray(spec.dependsOn) ? spec.dependsOn : [], decisions: Array.isArray(spec.decisions) ? spec.decisions : [] }
}
