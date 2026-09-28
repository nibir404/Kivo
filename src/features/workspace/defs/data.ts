import { CalendarClock, Database, GitBranch, ListChecks, Table2, Timer, Waypoints, Workflow } from "lucide-react"
import { datastores, usedBy } from "../derive"
import { jitter, match, stem, type WorkspaceDef, type WsContext } from "../model"

const MIGRATION = /(^|\/)migrations?\/.*\.(sql|py)$/
const PIPELINE = /((^|\/)(dags|pipelines|jobs|etl|flows|workers?)\/.*\.py$|(^|\/)(worker|outbox|consumer|producer|etl|pipeline)\.py$|(^|\/)models\/.*\.sql$)/

function pipelineKind(f: string) {
  if (/dags\//.test(f)) return "Airflow DAG"
  if (/outbox/.test(f)) return "Transactional outbox"
  if (/worker|consumer/.test(f)) return "Queue worker"
  if (/producer/.test(f)) return "Event producer"
  if (/models\/.*\.sql$/.test(f)) return "dbt model"
  return "Batch job"
}

function entities(ctx: WsContext) {
  return ctx.services.flatMap((s) => s.entities.map((e) => ({ ...e, service: s })))
}

export const data: WorkspaceDef = {
  id: "data",
  label: "Data Engineering",
  icon: Database,
  hue: 200,
  tagline: "Where data comes from, how it moves, and whether it can be trusted.",
  primaryMode: "Pipelines",
  hero: { title: "What data do you need to move or shape?", body: "Describe a pipeline, a model or a quality rule. Kivo plans it against the stores and schemas this project already has." },
  placeholder: "e.g. Copy new sign-ups from Postgres into a daily analytics table, and alert if a day has zero rows",
  examples: [
    { icon: Workflow, label: "Daily sign-ups job", text: "Build a daily job that copies new users from PostgreSQL into an analytics table with sign-up counts per day, and alerts if a day has no rows." },
    { icon: ListChecks, label: "Quality checks", text: "Add data-quality checks for the users table: emails are unique and valid, created_at is never in the future, no orphaned rows." },
    { icon: Waypoints, label: "Event stream", text: "Stream notification events from the outbox into a queue so analytics can consume them." },
  ],
  looksFor: ["migrations/*.sql", "dags/ (Airflow)", "dbt_project.yml and models/*.sql", "workers, outboxes, ETL scripts", "pandas / pyspark in requirements"],
  relevant: (_t, cat) => cat === "Data" || cat === "Database" || cat === "Cache",
  stats: (ctx) => [
    { label: "Stores", value: String(datastores(ctx).length) },
    { label: "Entities", value: String(entities(ctx).length) },
    { label: "Migrations", value: String(match(ctx.files, MIGRATION).length) },
    { label: "Pipelines", value: String(match(ctx.files, PIPELINE).length) },
  ],
  sections: [
    {
      id: "sources",
      label: "Sources & stores",
      icon: Database,
      blurb: "Every database, cache and queue, and which services use it.",
      build: (ctx) => {
        const stores = datastores(ctx)
        return {
          source: stores.length ? "project" : "example",
          count: stores.length,
          evidence: ctx.analysis.detections.filter((d) => d.category === "Database" || d.category === "Cache").map((d) => d.evidence),
          panels: [
            {
              kind: "table",
              columns: [
                { key: "name", label: "Store" },
                { key: "tech", label: "Technology" },
                { key: "role", label: "Holds" },
                { key: "users", label: "Used by" },
              ],
              rows: stores.map((n) => ({ name: n.label, tech: n.tech, role: n.purpose, users: usedBy(ctx, n.id).join(", ") || "—" })),
              empty: "No databases detected. Add one to docker-compose.yml and it appears here.",
            },
          ],
        }
      },
    },
    {
      id: "schemas",
      label: "Schemas",
      icon: Table2,
      blurb: "The tables your services define, field by field.",
      build: (ctx) => {
        const ents = entities(ctx)
        return {
          source: ents.length ? "project" : "example",
          count: ents.length,
          evidence: ctx.services.map((s) => `services/${s.id}/kivo.service.yaml`).filter((f) => ctx.files.includes(f)),
          panels: [
            {
              kind: "table",
              columns: [
                { key: "entity", label: "Entity", mono: true },
                { key: "fields", label: "Fields", mono: true },
                { key: "service", label: "Owned by" },
                { key: "store", label: "Store" },
              ],
              rows: ents.map((e) => ({
                entity: { text: e.name, mono: true },
                fields: { text: e.fields.map((f) => `${f.name}: ${f.type}`).join(", "), mono: true },
                service: e.service.name,
                store: e.service.storage.type,
              })),
              empty: "Services built in Kivo record their entities here.",
            },
          ],
        }
      },
    },
    {
      id: "migrations",
      label: "Migrations",
      icon: CalendarClock,
      blurb: "The order schema changes are applied in.",
      build: (ctx) => {
        const files = match(ctx.files, MIGRATION).sort((a, b) => stem(a).localeCompare(stem(b)))
        return {
          source: files.length ? "project" : "example",
          evidence: files,
          count: files.length,
          panels: [
            {
              kind: "timeline",
              events: files.length
                ? files.map((f) => ({ at: stem(f).match(/^\d+/)?.[0] ?? "—", title: stem(f).replace(/^\d+[_-]?/, "").replace(/[-_]/g, " ") || stem(f), detail: f }))
                : [
                    { at: "0001", title: "init", detail: "Create users table" },
                    { at: "0002", title: "add email index", detail: "Unique index on users.email" },
                  ],
            },
          ],
        }
      },
    },
    {
      id: "pipelines",
      label: "Pipelines",
      icon: Workflow,
      blurb: "Jobs, workers and event flows that move data between stores.",
      setup: "Plan a first data pipeline for this project: what it reads, what it writes, how often, and how failures are retried.",
      build: (ctx) => {
        const files = match(ctx.files, PIPELINE)
        if (!files.length)
          return {
            source: "example",
            note: "No DAGs, workers or ETL scripts yet.",
            panels: [{ kind: "table", columns: [{ key: "name", label: "Pipeline" }, { key: "kind", label: "Kind" }, { key: "schedule", label: "Runs" }], rows: [{ name: "daily_signups", kind: "Batch job", schedule: "Every day 02:00" }] }],
          }
        return {
          source: "project",
          evidence: files,
          count: files.length,
          panels: [
            {
              kind: "table",
              columns: [
                { key: "name", label: "Pipeline" },
                { key: "kind", label: "Kind" },
                { key: "file", label: "File", mono: true },
              ],
              rows: files.map((f) => ({ name: f.split("/").slice(-3, -1).join("/") || stem(f), kind: pipelineKind(f), file: { text: f, mono: true } })),
            },
          ],
        }
      },
    },
    {
      id: "lineage",
      label: "Lineage",
      icon: GitBranch,
      blurb: "How data flows from where it's produced to where it's stored.",
      build: (ctx) => {
        const flows = ctx.edges.filter((e) => e.kind === "storage" || e.kind === "data" || e.kind === "event")
        const name = (id: string) => ctx.nodes.find((n) => n.id === id)?.label ?? id
        const how = { storage: "writes rows", data: "reads & caches", event: "publishes events" } as Record<string, string>
        return {
          source: flows.length ? "project" : "example",
          count: flows.length,
          panels: [
            {
              kind: "table",
              columns: [
                { key: "from", label: "From" },
                { key: "how", label: "" },
                { key: "to", label: "To" },
                { key: "label", label: "Channel", mono: true },
              ],
              rows: flows.map((e) => ({ from: name(e.source), how: { text: `→ ${how[e.kind]}`, tone: "neutral" }, to: name(e.target), label: e.label ?? "—" })),
              empty: "No data flows in the system graph yet.",
            },
          ],
        }
      },
    },
    {
      id: "quality",
      label: "Data quality",
      icon: ListChecks,
      blurb: "Rules your data should always satisfy, derived from its fields.",
      build: (ctx) => {
        const items = entities(ctx).flatMap((e) =>
          e.fields.flatMap((f) => {
            const id = `${e.service.id}.${e.name}.${f.name}`
            const out: { id: string; title: string; detail?: string; group: string }[] = []
            if (/^id$|_id$/.test(f.name) && f.name === "id") out.push({ id: `${id}.pk`, group: e.name, title: `${e.name}.id is never null and never repeats` })
            if (/email/i.test(f.name)) out.push({ id: `${id}.email`, group: e.name, title: `${e.name}.${f.name} is a valid, unique address`, detail: "Lower-case before comparing." })
            if (/_at$|date|time/i.test(f.name)) out.push({ id: `${id}.time`, group: e.name, title: `${e.name}.${f.name} is never in the future` })
            if (/_id$/.test(f.name)) out.push({ id: `${id}.fk`, group: e.name, title: `Every ${e.name}.${f.name} points at a row that exists` })
            if (/status|state|kind|type/i.test(f.name)) out.push({ id: `${id}.enum`, group: e.name, title: `${e.name}.${f.name} only takes known values` })
            return out
          }),
        )
        return {
          source: items.length ? "project" : "guide",
          count: items.length || undefined,
          note: items.length ? "Suggested from your entity fields — tick each one off once a check enforces it." : undefined,
          panels: [
            {
              kind: "checklist",
              items: items.length
                ? items
                : [
                    { id: "fresh", title: "Every table has a freshness expectation" },
                    { id: "unique", title: "Natural keys are unique" },
                    { id: "nulls", title: "Required columns are never null" },
                  ],
            },
          ],
        }
      },
    },
    {
      id: "freshness",
      label: "Freshness & volume",
      icon: Timer,
      blurb: "How current each dataset is and how many rows arrive.",
      setup: "Add freshness and row-count monitoring for this project's tables, with alerts when data is late or a load is empty.",
      build: () => ({
        source: "example",
        note: "Nothing measures freshness yet. Example numbers show what you'd watch.",
        panels: [
          {
            kind: "metrics",
            tiles: [
              { label: "Rows loaded today", value: "12,480", tone: "good" },
              { label: "Freshest table lag", value: "4 min", tone: "good" },
              { label: "Stalest table lag", value: "26 h", tone: "warn", hint: "notifications_archive" },
            ],
            charts: [{ title: "Rows loaded per day", x: "day", series: [{ name: "rows", points: jitter("data-rows", 21, 12000, 1800, 0.05).map(Math.round) }] }],
          },
        ],
      }),
    },
  ],
}
