import type { Experience, LibraryItem, SystemEdge, SystemNode } from "./types"

export const PROJECT_NAME = "tandem"

/** System Graph for the demo repo before anything is built. */
export const SEED_NODES: SystemNode[] = [
  { id: "mobile", label: "Mobile App", kind: "client", tech: "React Native · Expo", purpose: "The iOS/Android app people use.", concept: "react-native", status: "running", group: "Frontend" },
  { id: "gateway", label: "API Gateway", kind: "gateway", tech: "Traefik", purpose: "Routes requests to services and verifies tokens.", concept: "api-gateway", status: "running", group: "Infrastructure" },
  { id: "users", label: "User Management", kind: "service", tech: "Python · FastAPI", purpose: "Profiles and account settings.", concept: "fastapi", serviceId: "users", status: "running", group: "Backend" },
  { id: "notifications", label: "Notifications", kind: "service", tech: "Python · FastAPI", purpose: "Sends email and push messages in the background.", concept: "fastapi", serviceId: "notifications", status: "running", group: "Backend" },
  { id: "postgres", label: "PostgreSQL", kind: "database", tech: "PostgreSQL 16", purpose: "Permanent structured data.", concept: "postgresql", status: "running", group: "Data" },
  { id: "redis", label: "Redis", kind: "cache", tech: "Redis 7", purpose: "Cache, sessions, queues.", concept: "redis", status: "running", group: "Data" },
  { id: "docker", label: "Docker", kind: "infra", tech: "docker compose", purpose: "Runs every component in containers.", concept: "docker", status: "running", group: "Infrastructure" },
]

export const SEED_EDGES: SystemEdge[] = [
  { id: "e1", source: "mobile", target: "gateway", kind: "request", label: "HTTPS" },
  { id: "e2", source: "gateway", target: "users", kind: "request", label: "/users" },
  { id: "e3", source: "gateway", target: "notifications", kind: "request", label: "/notify" },
  { id: "e4", source: "users", target: "postgres", kind: "storage" },
  { id: "e5", source: "users", target: "redis", kind: "data", label: "cache" },
  { id: "e6", source: "notifications", target: "redis", kind: "event", label: "queue" },
]

/** Nodes/edges contributed when a service is built from the IR. */
export function nodesForService(id: string, name: string, tech: string, purpose: string, deps: string[], usesCache: boolean) {
  const node: SystemNode = { id, label: name, kind: "service", tech, purpose, concept: /fastapi/i.test(tech) ? "fastapi" : undefined, serviceId: id, status: "running", group: "Backend" }
  const edges: SystemEdge[] = [
    { id: `e-gw-${id}`, source: "gateway", target: id, kind: "request", label: `/${id === "authentication" ? "auth" : id}` },
    { id: `e-${id}-pg`, source: id, target: "postgres", kind: "storage" },
  ]
  if (usesCache) edges.push({ id: `e-${id}-redis`, source: id, target: "redis", kind: "data", label: "sessions" })
  for (const d of deps) edges.push({ id: `e-${id}-${d}`, source: id, target: d, kind: "event", label: "emails" })
  return { node, edges }
}

const day = 86_400_000
const now = Date.now()

export const SEED_LIBRARY: LibraryItem[] = [
  {
    id: "li-1",
    kind: "concept",
    title: "PostgreSQL",
    conceptId: "postgresql",
    systemExplanation: "A relational database for persistent data.",
    myUnderstanding: "PostgreSQL is basically the permanent memory of my application.",
    source: { mode: "learn", label: "Architecture · PostgreSQL", project: "ledger" },
    tags: ["database", "persistence"],
    createdAt: now - 21 * day,
    visibility: "private",
    useAsContext: true,
  },
  {
    id: "li-2",
    kind: "concept",
    title: "Redis TTL",
    conceptId: "redis",
    systemExplanation: "Keys can expire automatically after a time-to-live.",
    myUnderstanding: "Great for anything that should forget itself — sessions, rate limits, one-time codes.",
    source: { mode: "observe", label: "Runtime · SET session EX", project: "pulse" },
    tags: ["redis", "sessions", "ttl"],
    createdAt: now - 9 * day,
    visibility: "private",
    useAsContext: true,
  },
  {
    id: "li-3",
    kind: "decision",
    title: "Why cache-aside for profiles",
    conceptId: "caching",
    systemExplanation: "Read-through on miss, SETEX 60s, invalidate on write.",
    myUnderstanding: "60 seconds of staleness is fine for a profile. Not fine for a balance.",
    source: { mode: "build", label: "Decision · User Management", project: "tandem" },
    tags: ["caching", "redis"],
    createdAt: now - 3 * day,
    visibility: "shared",
    useAsContext: true,
  },
]

export const SEED_EXPERIENCES: Experience[] = [
  {
    id: "ex-42",
    number: 42,
    title: "API became slow",
    problem: "p95 latency on /feed crept from 90ms to 180ms after launch.",
    context: "FastAPI + PostgreSQL, ~40 rps",
    investigation: "Traces showed the same profile query repeated 6× per request (N+1 through a serializer).",
    decision: "Batch the lookup and cache profiles in Redis rather than add a read replica.",
    implementation: "selectinload for relations; cache-aside with 60s TTL on profile reads.",
    outcome: "Average latency dropped and DB CPU halved.",
    metric: { label: "Average latency", before: "180ms", after: "42ms" },
    lesson: "Cache expensive repeated reads.",
    concepts: ["redis", "caching", "postgresql"],
    project: "pulse",
    createdAt: now - 40 * day,
    visibility: "private",
    useAsContext: true,
  },
  {
    id: "ex-37",
    number: 37,
    title: "Users logged out every morning",
    problem: "Mobile users had to sign in again daily.",
    context: "Express + JWT only, 24h tokens",
    investigation: "No refresh flow — tokens simply expired. Longer tokens would be unrevocable.",
    decision: "Short access tokens + rotating refresh tokens stored in Redis.",
    implementation: "15-min JWT, 14-day refresh with family-based reuse detection.",
    outcome: "Complaints stopped; stolen-token window shrank from 24h to 15min.",
    lesson: "Separate 'proving who you are' from 'staying signed in'.",
    concepts: ["jwt", "refresh-tokens", "redis"],
    project: "ledger",
    createdAt: now - 75 * day,
    visibility: "private",
    useAsContext: true,
  },
]

/** How often each concept has shown up across the user's projects (for learning-gap detection). */
export const CONCEPT_ENCOUNTERS: Record<string, { count: number; explored: string[] }> = {
  redis: { count: 7, explored: ["caching", "sessions", "ttl", "pub/sub"] },
  postgresql: { count: 9, explored: ["queries", "indexes", "migrations"] },
  jwt: { count: 4, explored: ["claims", "signing", "expiry"] },
}

/**
 * A starting System Graph for a project Kivo didn't create: one node per detected client,
 * backend, store and piece of infrastructure, with the evidence file as its purpose. Edges are
 * left out — Kivo only draws connections it has actually seen.
 */
export function nodesFromAnalysis(analysis: import("./types").ProjectAnalysis): SystemNode[] {
  const kind: Record<string, SystemNode["kind"]> = { Frontend: "client", Mobile: "client", Backend: "service", Database: "database", Cache: "cache", Infrastructure: "infra", "AI / ML": "model", Data: "queue" }
  const group: Record<string, SystemNode["group"]> = { Frontend: "Frontend", Mobile: "Frontend", Backend: "Backend", Database: "Data", Cache: "Data", Infrastructure: "Infrastructure", "AI / ML": "AI / ML", Data: "Data" }
  return analysis.detections
    .filter((d) => kind[d.category])
    .map((d) => ({
      id: `det-${d.tech.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      label: d.tech,
      kind: kind[d.category],
      tech: d.tech,
      purpose: `Detected from ${d.evidence}`,
      status: "ready" as const,
      group: group[d.category],
    }))
}
