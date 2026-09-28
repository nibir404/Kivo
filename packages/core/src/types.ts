/**
 * Kivo core types.
 *
 * Everything in the product is a view over three graphs:
 *   System Graph     — what exists (services, APIs, stores, infra, runtime)
 *   Knowledge Graph  — what the user understands (concepts, notes)
 *   Experience Graph — what the user has lived through (problems, decisions, outcomes)
 *
 * The Service IR is the stable bridge between intent, reasoning, code and runtime.
 */

// ─── Service Intermediate Representation ──────────────────────────────────────

/** "generated": the code is written but hasn't been installed, tested or started (a build in the browser). */
export type ServiceStatus = "draft" | "planned" | "building" | "generated" | "ready" | "running" | "failed"

export interface Requirement {
  id: string
  title: string
  description: string
}

export interface EntityField {
  name: string
  type: string
  note?: string
}

export interface Entity {
  name: string
  fields: EntityField[]
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"

export interface Endpoint {
  method: HttpMethod
  path: string
  summary: string
  requirement: string
  auth: boolean
}

export interface StackChoice {
  language: string
  framework: string
  database?: string
  cache?: string
}

export interface Decision {
  topic: string
  choice: string
  reason: string
  alternatives: string[]
}

export interface ServiceSpec {
  id: string
  name: string
  purpose: string
  intent: string
  requirements: Requirement[]
  entities: Entity[]
  storage: { type: string; reason: string }
  cache?: { type: string; reason: string }
  api: { style: "rest" | "graphql" | "grpc"; endpoints: Endpoint[] }
  authentication?: { strategy: string; reason: string }
  implementation: StackChoice
  dependsOn: string[]
  decisions: Decision[]
  status: ServiceStatus
  files: string[]
  tests: { name: string; status: "pass" | "fail" | "pending" }[]
  /** Set when an existing (detected) service already uses this name; the new one is kept separate. */
  sameNameAs?: string
  /** Open questions the Intent Agent could not resolve on its own. */
  questions?: string[]
}

// ─── Planner ──────────────────────────────────────────────────────────────────

/** Who performs a step. Deterministic engines never rely on model output. */
export type Executor = "ai" | "deterministic"

export interface PlanStep {
  id: string
  title: string
  executor: Executor
  engine: string
  what: string
  why: string
  tech: string
  alternatives: string[]
  consequences: string
  concept?: string
  artifacts: string[]
  durationMs: number
}

// ─── System Graph ─────────────────────────────────────────────────────────────

export type SystemNodeKind =
  | "client"
  | "gateway"
  | "service"
  | "database"
  | "cache"
  | "queue"
  | "model"
  | "infra"
  | "external"

export type SystemEdgeKind =
  | "request"
  | "dependency"
  | "data"
  | "event"
  | "auth"
  | "inference"
  | "storage"

export interface SystemNode {
  id: string
  label: string
  kind: SystemNodeKind
  tech: string
  purpose: string
  concept?: string
  serviceId?: string
  status: ServiceStatus
  group: "Frontend" | "Backend" | "Data" | "Infrastructure" | "AI / ML" | "External"
}

export interface SystemEdge {
  id: string
  source: string
  target: string
  kind: SystemEdgeKind
  label?: string
}

// ─── Project Intelligence ─────────────────────────────────────────────────────

export type TechCategory =
  | "Frontend"
  | "Mobile"
  | "Backend"
  | "Database"
  | "Cache"
  | "Infrastructure"
  | "AI / ML"
  | "Data"
  | "Embedded"
  | "Game"
  | "Security"
  | "Testing"
  | "Tooling"

export interface Detection {
  tech: string
  category: TechCategory
  evidence: string
  confidence: number
}

export type Discipline = "software" | "frontend" | "data" | "ml" | "rl" | "security" | "devops" | "embedded" | "game"

export interface ProjectAnalysis {
  detections: Detection[]
  languages: { name: string; share: number }[]
  recommended: Discipline[]
  summary: string
}

// ─── Runtime ──────────────────────────────────────────────────────────────────

export type Level = "beginner" | "intermediate" | "advanced" | "expert"

export interface RuntimeSpan {
  id: string
  traceId: string
  nodeId: string
  name: string
  durationMs: number
  offsetMs: number
  status: "ok" | "error" | "slow"
  concept?: string
  narration: Record<Level, string>
}

export interface Trace {
  id: string
  route: string
  method: HttpMethod
  status: number
  totalMs: number
  at: number
  spans: RuntimeSpan[]
}

export interface LogLine {
  id: string
  at: number
  level: "info" | "warn" | "error" | "debug"
  source: string
  message: string
}

// ─── Knowledge & Experience ───────────────────────────────────────────────────

export interface Concept {
  id: string
  name: string
  category: string
  what: string
  /** Project-specific: why THIS project uses it. */
  whyHere: string
  usedIn: string[]
  related: string[]
  subtopics: string[]
  /** Progressive disclosure, level 1 → 5. */
  layers: {
    happened: string
    how: string
    why: string
    impl: string
    tradeoffs: string
  }
}

export type Visibility = "private" | "shared"

export interface LibraryItem {
  id: string
  kind: "concept" | "note" | "decision" | "snippet" | "event"
  title: string
  conceptId?: string
  systemExplanation: string
  myUnderstanding: string
  source: { mode: Mode; label: string; project: string }
  tags: string[]
  createdAt: number
  visibility: Visibility
  useAsContext: boolean
}

export interface Experience {
  id: string
  number: number
  title: string
  problem: string
  context: string
  investigation: string
  decision: string
  implementation: string
  outcome: string
  metric?: { label: string; before: string; after: string }
  lesson: string
  concepts: string[]
  project: string
  createdAt: number
  visibility: Visibility
  useAsContext: boolean
}

// ─── Interaction ──────────────────────────────────────────────────────────────

export type Mode = "build" | "code" | "observe" | "learn" | "library"

export type RefKind =
  | "service"
  | "concept"
  | "node"
  | "span"
  | "step"
  | "endpoint"
  | "entity"
  | "code"
  | "log"
  | "text"
  | "experience"

/** A pointer to anything selectable. The Explain & Capture toolbar operates on refs. */
export interface KivoRef {
  kind: RefKind
  id: string
  label: string
  conceptId?: string
  detail?: string
}

export interface ContextItem {
  source: "project" | "knowledge" | "experience" | "intent"
  label: string
  detail: string
  score: number
}
