import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { analyzeRepository, SAMPLE_REPO, type RepoFile } from "@kivo/core/detect"
import { SEED_EDGES, SEED_NODES } from "@kivo/core/seed"
import type { ServiceSpec } from "@kivo/core/types"
import type { WsContext } from "../src/features/workspace/model"
import { WORKSPACES } from "../src/features/workspace/registry"

const service = (over: Partial<ServiceSpec>): ServiceSpec => ({
  id: "auth",
  name: "Authentication",
  purpose: "Accounts and sessions",
  intent: "",
  requirements: [],
  entities: [{ name: "User", fields: [{ name: "id", type: "uuid" }, { name: "email", type: "str" }, { name: "created_at", type: "datetime" }, { name: "team_id", type: "uuid" }] }],
  storage: { type: "PostgreSQL", reason: "" },
  api: {
    style: "rest",
    endpoints: [
      { method: "POST", path: "/auth/login", summary: "Log in", requirement: "r1", auth: false },
      { method: "GET", path: "/users/me", summary: "Current user", requirement: "r2", auth: true },
      { method: "DELETE", path: "/users/{id}", summary: "Delete a user", requirement: "r3", auth: false },
    ],
  },
  authentication: { strategy: "JWT access + refresh tokens", reason: "" },
  implementation: { language: "python", framework: "fastapi" },
  dependsOn: [],
  decisions: [],
  status: "running",
  files: [],
  tests: [],
  ...over,
})

function ctxFor(files: RepoFile[], services: ServiceSpec[] = []): WsContext {
  return {
    project: "test",
    files: files.map((f) => f.path),
    analysis: analyzeRepository(files),
    services,
    nodes: SEED_NODES,
    edges: SEED_EDGES,
    traces: [],
    logs: [{ id: "l1", at: Date.now(), level: "error", source: "auth", message: "boom" }],
    runtimeLive: false,
  }
}

const RICH: RepoFile[] = [
  { path: "requirements.txt", content: "torch\ngymnasium\nstable-baselines3\npandas\napache-airflow\nmlflow" },
  { path: "data/tickets.csv" },
  { path: "train.py" },
  { path: "models/router.onnx" },
  { path: "notebooks/explore.ipynb" },
  { path: "envs/warehouse_env.py" },
  { path: "agents/ppo_agent.py" },
  { path: "dags/daily_signups.py", content: "from airflow import DAG" },
  { path: "dbt_project.yml" },
  { path: "firmware/platformio.ini" },
  { path: "firmware/src/main.cpp" },
  { path: "firmware/src/bme280.cpp" },
  { path: "game/project.godot" },
  { path: "game/scenes/Level_01.tscn" },
  { path: "game/scripts/player.gd" },
  { path: "game/assets/coin.png" },
  { path: "web/package.json", content: '{"dependencies":{"next":"15","react":"19"}}' },
  { path: "web/app/settings/page.tsx" },
  { path: "web/app/[team]/page.tsx" },
  { path: "web/components/Button.tsx" },
  { path: "k8s/api.yaml", content: "kind: Deployment" },
  { path: ".github/workflows/ci.yml" },
  { path: ".semgrep.yml" },
]

describe("workspaces", () => {
  test("there are nine, each with its own vocabulary, accent and sections", () => {
    assert.equal(WORKSPACES.length, 9)
    assert.equal(new Set(WORKSPACES.map((w) => w.id)).size, 9)
    assert.equal(new Set(WORKSPACES.map((w) => w.hue)).size, 9, "every workspace has a distinct accent")
    for (const w of WORKSPACES.filter((w) => w.id !== "software")) {
      assert.ok(w.sections.length >= 6, `${w.id} has at least 6 sections`)
      assert.ok(w.examples.length >= 3, `${w.id} has example prompts`)
      assert.equal(new Set(w.sections.map((s) => s.id)).size, w.sections.length, `${w.id} section ids are unique`)
    }
  })

  for (const [name, ctx] of [
    ["the demo project", ctxFor(SAMPLE_REPO)],
    ["a project with a service", ctxFor(SAMPLE_REPO, [service({})])],
    ["a repo with every kind of file", ctxFor(RICH, [service({})])],
    ["an empty repo", ctxFor([])],
  ] as const) {
    test(`every section builds for ${name}`, () => {
      for (const w of WORKSPACES) {
        for (const s of w.sections) {
          const data = s.build(ctx)
          assert.ok(["project", "example", "guide"].includes(data.source), `${w.id}/${s.id} source`)
          for (const p of data.panels) if (p.kind === "metrics") for (const c of p.charts) for (const ser of c.series) assert.ok(ser.points.every(Number.isFinite), `${w.id}/${s.id} chart is finite`)
        }
        assert.doesNotThrow(() => w.stats(ctx), `${w.id} stats`)
      }
    })
  }

  test("a repo with ML, RL, IoT, game and data files fills those workspaces from the project", () => {
    const ctx = ctxFor(RICH, [service({})])
    const source = (ws: string, sec: string) => WORKSPACES.find((w) => w.id === ws)!.sections.find((s) => s.id === sec)!.build(ctx).source
    assert.equal(source("ml", "datasets"), "project")
    assert.equal(source("ml", "models"), "project")
    assert.equal(source("rl", "environment"), "project")
    assert.equal(source("embedded", "firmware"), "project")
    assert.equal(source("embedded", "peripherals"), "project")
    assert.equal(source("game", "scenes"), "project")
    assert.equal(source("data", "pipelines"), "project")
    assert.equal(source("frontend", "components"), "project")
    assert.equal(source("devops", "deploys"), "project")
    for (const d of ["ml", "rl", "data", "frontend", "devops", "embedded", "game", "security"]) assert.ok(ctx.analysis.recommended.includes(d as never), `${d} is recommended`)
  })

  test("nothing is passed off as real in an empty repo", () => {
    const ctx = ctxFor([])
    for (const id of ["ml", "rl", "embedded", "game"]) {
      const w = WORKSPACES.find((x) => x.id === id)!
      assert.ok(w.sections.every((s) => s.build(ctx).source !== "project"), `${id} shows only examples and guides`)
    }
  })

  test("routes are derived from file-based routers", () => {
    const ctx = ctxFor(RICH)
    const screens = WORKSPACES.find((w) => w.id === "frontend")!.sections[0].build(ctx)
    const table = screens.panels[0]
    assert.equal(table.kind, "table")
    const routes = table.kind === "table" ? table.rows.map((r) => r.route) : []
    assert.deepEqual(routes.sort(), ["/:team", "/settings"])
  })

  test("security flags an unauthenticated delete, but not public-by-design login", () => {
    const ctx = ctxFor(SAMPLE_REPO, [service({})])
    const findings = WORKSPACES.find((w) => w.id === "security")!.sections.find((s) => s.id === "findings")!.build(ctx)
    const board = findings.panels[0]
    assert.equal(board.kind, "board")
    if (board.kind !== "board") return
    const high = board.columns.find((c) => c.title === "High")!.cards.map((c) => c.title)
    assert.ok(high.some((t) => t.includes("DELETE /users/{id}")))
    assert.ok(!high.some((t) => t.includes("/auth/login")))
  })

  test("DevOps opens an incident for a source that logged errors", () => {
    const ctx = ctxFor(SAMPLE_REPO)
    const inc = WORKSPACES.find((w) => w.id === "devops")!.sections.find((s) => s.id === "incidents")!.build(ctx)
    const board = inc.panels[0]
    assert.ok(board.kind === "board" && board.columns[0].cards[0].title.startsWith("auth: 1 error"))
  })

  test("data quality rules come from entity fields", () => {
    const ctx = ctxFor(SAMPLE_REPO, [service({})])
    const q = WORKSPACES.find((w) => w.id === "data")!.sections.find((s) => s.id === "quality")!.build(ctx)
    const list = q.panels[0]
    assert.ok(list.kind === "checklist")
    const titles = list.kind === "checklist" ? list.items.map((i) => i.title) : []
    assert.ok(titles.some((t) => t.includes("User.email")))
    assert.ok(titles.some((t) => t.includes("User.created_at")))
    assert.ok(titles.some((t) => t.includes("User.team_id")))
  })
})
