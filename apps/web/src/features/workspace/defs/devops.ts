import { Activity, BookOpenCheck, Boxes, Container, Gauge, Rocket, ScrollText, Server, Siren } from "lucide-react"
import { hasTech } from "../derive"
import { jitter, match, percentile, round, type Tone, type WorkspaceDef, type WsContext } from "../model"

const INFRA_FILE = /(Dockerfile[^/]*|docker-compose\.ya?ml|compose\.ya?ml|k8s\/.*\.ya?ml|Chart\.yaml|\.tf|\.github\/workflows\/.*\.ya?ml|Procfile|fly\.toml|render\.yaml)$/

const STATUS_TONE: Record<string, Tone> = { running: "good", ready: "good", building: "info", failed: "bad", planned: "neutral", draft: "neutral" }

function errorGroups(ctx: WsContext) {
  const groups = new Map<string, { count: number; last: number; message: string }>()
  for (const l of ctx.logs) {
    if (l.level !== "error") continue
    const g = groups.get(l.source) ?? { count: 0, last: 0, message: l.message }
    g.count++
    if (l.at >= g.last) {
      g.last = l.at
      g.message = l.message
    }
    groups.set(l.source, g)
  }
  return [...groups.entries()].map(([source, g]) => ({ source, ...g }))
}

const ago = (t: number) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000))
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`
}

export const devops: WorkspaceDef = {
  id: "devops",
  label: "DevOps / SRE",
  icon: Server,
  hue: 150,
  tagline: "Keep it running: deploys, health, logs and incidents.",
  primaryMode: "Operate",
  hero: { title: "What do you need to ship or keep running?", body: "Describe a deployment, an alert or an outage. Kivo works from the services, containers and live logs in this project." },
  placeholder: "e.g. Deploy both services to a single VM with Docker Compose, with health checks and automatic restarts",
  examples: [
    { icon: Rocket, label: "CI/CD pipeline", text: "Set up a GitHub Actions pipeline for this project: run the tests for every service, build the Docker images, and deploy on merge to main." },
    { icon: Gauge, label: "SLOs & alerts", text: "Define SLOs for the authentication service (availability and p95 latency) and the alerts that should page someone." },
    { icon: Boxes, label: "Kubernetes manifests", text: "Write Kubernetes manifests for the services in this project, with readiness probes, resource limits and a Postgres connection secret." },
  ],
  looksFor: ["Dockerfile, docker-compose.yml", "k8s/*.yaml, Chart.yaml (Helm)", "*.tf (Terraform)", ".github/workflows/*.yml", "running services and their logs"],
  relevant: (_t, cat) => cat === "Infrastructure",
  stats: (ctx) => {
    const running = ctx.services.filter((s) => s.status === "running").length
    const errors = ctx.logs.filter((l) => l.level === "error").length
    return [
      { label: "Services running", value: `${running}/${ctx.services.length}`, tone: running === ctx.services.length ? "good" : "warn" },
      { label: "Infra files", value: String(match(ctx.files, INFRA_FILE).length) },
      { label: "Errors in logs", value: String(errors), tone: errors ? "bad" : "good" },
      { label: "Open incidents", value: String(errorGroups(ctx).length), tone: errorGroups(ctx).length ? "bad" : "good" },
    ]
  },
  sections: [
    {
      id: "services",
      label: "Services",
      icon: Server,
      blurb: "What's deployed, its state and its stack.",
      build: (ctx) => ({
        source: ctx.services.length ? "project" : "example",
        count: ctx.services.length,
        panels: [
          {
            kind: "table",
            columns: [
              { key: "name", label: "Service" },
              { key: "status", label: "State" },
              { key: "stack", label: "Stack" },
              { key: "endpoints", label: "Endpoints", align: "right" },
              { key: "deps", label: "Depends on" },
            ],
            rows: ctx.services.map((s) => ({
              name: s.name,
              status: { text: s.status, tone: STATUS_TONE[s.status] ?? "neutral" },
              stack: `${s.implementation.language} · ${s.implementation.framework}`,
              endpoints: s.api.endpoints.length,
              deps: [s.storage.type, s.cache?.type, ...s.dependsOn].filter(Boolean).join(", "),
            })),
            empty: "No services yet.",
          },
        ],
      }),
    },
    {
      id: "containers",
      label: "Containers",
      icon: Container,
      blurb: "Infrastructure components and the files that define them.",
      build: (ctx) => {
        const infra = ctx.nodes.filter((n) => n.kind !== "service" && n.kind !== "client")
        const files = match(ctx.files, INFRA_FILE)
        return {
          source: infra.length || files.length ? "project" : "example",
          evidence: files,
          count: infra.length,
          panels: [
            {
              kind: "table",
              columns: [
                { key: "name", label: "Component" },
                { key: "image", label: "Image / tech", mono: true },
                { key: "role", label: "Role" },
                { key: "state", label: "State" },
              ],
              rows: infra.map((n) => ({ name: n.label, image: { text: n.tech, mono: true }, role: n.purpose, state: { text: n.status, tone: STATUS_TONE[n.status] ?? "neutral" } })),
            },
          ],
        }
      },
    },
    {
      id: "deploys",
      label: "Deployments",
      icon: Rocket,
      blurb: "How changes reach production.",
      setup: "Set up deployments for this project: a CI pipeline that tests every service, builds images and deploys on merge.",
      build: (ctx) => {
        const workflows = match(ctx.files, /\.github\/workflows\/.*\.ya?ml$/)
        if (workflows.length)
          return { source: "project", evidence: workflows, count: workflows.length, panels: [{ kind: "table", columns: [{ key: "file", label: "Workflow", mono: true }], rows: workflows.map((f) => ({ file: { text: f, mono: true } })) }] }
        return {
          source: "example",
          note: hasTech(ctx, "Docker") ? "Docker is set up, but no CI/CD workflow deploys it yet." : "No CI/CD workflow yet.",
          panels: [
            {
              kind: "timeline",
              events: [
                { at: "14:02", title: "Deploy #42 to production", detail: "auth 1.4.0 · 3m 12s", tone: "good" },
                { at: "13:40", title: "Deploy #41 rolled back", detail: "p95 latency above SLO after 4 min", tone: "bad" },
                { at: "11:15", title: "Deploy #40 to staging", detail: "notification-system 0.9.2", tone: "good" },
              ],
            },
          ],
        }
      },
    },
    {
      id: "logs",
      label: "Logs",
      icon: ScrollText,
      blurb: "The latest lines from services Kivo is running.",
      build: (ctx) => {
        const lines = ctx.logs.slice(-60).reverse()
        return {
          source: "project",
          count: ctx.logs.length,
          note: lines.length ? "Live — the Logs tab in the bottom panel streams everything." : "No log lines yet. Start a service (or build one) and its output streams here.",
          panels: [
            {
              kind: "table",
              columns: [
                { key: "at", label: "Time", mono: true },
                { key: "level", label: "Level" },
                { key: "source", label: "Source" },
                { key: "message", label: "Message", mono: true },
              ],
              rows: lines.map((l) => ({
                at: { text: new Date(l.at).toLocaleTimeString([], { hour12: false }), mono: true },
                level: { text: l.level, tone: l.level === "error" ? "bad" : l.level === "warn" ? "warn" : "neutral" },
                source: l.source,
                message: { text: l.message, mono: true },
              })),
            },
          ],
        }
      },
    },
    {
      id: "metrics",
      label: "Metrics",
      icon: Activity,
      blurb: "Latency, throughput and errors.",
      build: (ctx) => {
        const traces = [...ctx.traces].reverse()
        if (traces.length >= 4) {
          const lat = traces.map((t) => t.totalMs)
          const errors = traces.filter((t) => t.status >= 500).length
          return {
            source: "example",
            count: traces.length,
            note: "From Kivo's demo traffic (simulated), not real users. It shows what production metrics will look like.",
            panels: [
              {
                kind: "metrics",
                tiles: [
                  { label: "Requests", value: String(traces.length) },
                  { label: "p50 latency", value: `${percentile(lat, 50)} ms` },
                  { label: "p95 latency", value: `${percentile(lat, 95)} ms`, tone: percentile(lat, 95) > 300 ? "warn" : "good" },
                  { label: "Error rate", value: `${round((errors / traces.length) * 100, 1)} %`, tone: errors ? "bad" : "good" },
                ],
                charts: [{ title: "Request latency", unit: "ms", x: "request", series: [{ name: "latency", points: lat.slice(-60) }], target: { value: 300, label: "SLO 300 ms" } }],
              },
            ],
          }
        }
        return {
          source: "example",
          note: "No traffic yet. Turn on demo traffic from the status bar, or call a service from its API tab.",
          panels: [
            {
              kind: "metrics",
              tiles: [
                { label: "p95 latency", value: "184 ms", tone: "good" },
                { label: "Error rate", value: "0.4 %", tone: "good" },
                { label: "Throughput", value: "38 req/s" },
              ],
              charts: [{ title: "p95 latency", unit: "ms", x: "min", series: [{ name: "p95", points: jitter("devops-p95", 40, 180, 30, 0.04) }], target: { value: 300, label: "SLO 300 ms" } }],
            },
          ],
        }
      },
    },
    {
      id: "incidents",
      label: "Incidents",
      icon: Siren,
      blurb: "Problems raised from real errors in the logs.",
      build: (ctx) => {
        const g = errorGroups(ctx)
        return {
          source: "project",
          count: g.length,
          note: g.length ? "Each source that logged an error opens an incident." : "Nothing is on fire. Errors in service logs open incidents here.",
          panels: [
            {
              kind: "board",
              columns: [
                { title: "Open", tone: "bad", cards: g.map((x) => ({ title: `${x.source}: ${x.count} error${x.count > 1 ? "s" : ""}`, meta: `${ago(x.last)} — ${x.message.slice(0, 140)}`, tone: "bad" })) },
                { title: "Investigating", tone: "warn", cards: [] },
                { title: "Resolved", tone: "good", cards: [] },
              ],
            },
          ],
        }
      },
    },
    {
      id: "slos",
      label: "SLOs",
      icon: Gauge,
      blurb: "Targets for reliability, and how much error budget is left.",
      setup: "Define SLOs for each service in this project (availability and latency), with the error budget and alerting policy.",
      build: (ctx) => ({
        source: "example",
        note: "No SLOs defined yet. Example targets for the services you have.",
        panels: [
          {
            kind: "table",
            columns: [
              { key: "service", label: "Service" },
              { key: "slo", label: "Objective" },
              { key: "current", label: "Last 28 days", align: "right" },
              { key: "budget", label: "Budget left", align: "right" },
            ],
            rows: (ctx.services.length ? ctx.services.map((s) => s.name) : ["api"]).flatMap((name, i) => [
              { service: name, slo: "99.9 % of requests succeed", current: `${(99.95 - i * 0.04).toFixed(2)} %`, budget: { text: `${72 - i * 25} %`, tone: 72 - i * 25 < 30 ? "warn" : "good" } },
              { service: name, slo: "p95 latency under 300 ms", current: `${210 + i * 40} ms`, budget: { text: `${60 - i * 18} %`, tone: 60 - i * 18 < 30 ? "warn" : "good" } },
            ]),
          },
        ],
      }),
    },
    {
      id: "runbooks",
      label: "Runbooks",
      icon: BookOpenCheck,
      blurb: "What every service needs before it's on call.",
      build: (ctx) => ({
        source: "guide",
        panels: [
          {
            kind: "checklist",
            items: [
              { id: "health", title: "Every service exposes /health and it's checked", detail: ctx.services.length ? `${ctx.services.length} services to cover.` : undefined },
              { id: "restart", title: "Containers restart automatically when they crash" },
              { id: "limits", title: "CPU and memory limits are set" },
              { id: "backup", title: "Database backups run daily and a restore has been tested" },
              { id: "alerts", title: "Alerts page a human only for user-facing impact" },
              { id: "rollback", title: "A deploy can be rolled back in one step" },
              { id: "secrets", title: "Secrets come from the environment or a vault, never the image" },
            ],
          },
        ],
      }),
    },
  ],
}
