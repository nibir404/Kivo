# Kivo — Architecture

> Build software by describing what you want. Understand it by watching how it works.

Kivo is an intent-driven engineering environment. The primary interface is **intent**, the primary abstraction is the **service**, and code is one inspectable layer among several. Everything the user sees is a view over three persistent graphs.

```
Describe → Understand → Plan → Build → Run → Observe → Learn → Capture → Reuse
```

---

## 1. System overview

```
                         USER
                          │
                   Intent Interface          ← composer, ⌘K, Ask AI, Explain & Capture
                          │
                    Context Engine           ← assembles grounded context per request
             ┌────────────┼────────────┐
       System Graph   User Profile   Knowledge Graph + Experience Graph
             └────────────┬────────────┘
                     Service IR              ← the stable contract
                          │
                       Planner               ← IR → ordered, typed steps (AI | deterministic)
                          │
                Implementation Layer         ← codegen agents + deterministic toolchain
                          │
                  Runtime / Sandbox          ← containers, processes, OpenTelemetry
             ┌────────────┼────────────┐
            Logs        Traces       Metrics
             └────────────┼────────────┘
                 Explanation Engine          ← level-adaptive, project-specific
                          │
                   Learning Engine           ← gap detection, level inference
                          │
                  Experience Memory          ← problem → decision → outcome → lesson
                          │
                     Personal AI             ← retrieval, never retraining
```

### Process topology (production)

| Process | Responsibility | Tech (proposed) |
|---|---|---|
| **Desktop shell** | UI, panels, command menu, local state | Tauri or Electron + React + shadcn/ui |
| **Kivo daemon** (local) | Graph store, file watching, detectors, process manager, git, sandbox control | Rust or Go single binary |
| **Graph store** | System / Knowledge / Experience graphs + embeddings | SQLite (+ sqlite-vec), one DB per user, per-project attach |
| **Sandbox** | Isolated execution of generated code and tests | Docker / Podman; Firecracker for remote |
| **Telemetry collector** | Receive OTel spans/logs/metrics from sandboxed processes | OpenTelemetry Collector (embedded) |
| **Agent runtime** | Model calls, tool use, orchestration | Claude via API; Opus 5.5 for planning, Sonnet 5 for generation, Haiku 4.5 for narration |

Local-first is deliberate: repository contents, runtime data and personal memory stay on the machine by default. Only the prompt context the user can see ("Context used · N items") is sent to the model.

---

## 2. The three-graph model

All four modes — Build, Observe, Learn, Library — are projections of the same data.

### System Graph — *what exists*

Nodes: `client · gateway · service · database · cache · queue · model · infra · external`
Edges: `request · dependency · data · event · auth · inference · storage`

Every node answers: what it is, why it exists, what it depends on, what depends on it, how it's implemented (IR + files), which APIs it exposes, what data it owns, which tests cover it, and which runtime spans belong to it.

Sources of truth, in precedence order:
1. **Service IR** (for Kivo-built services)
2. **Deterministic detectors** (manifests, lockfiles, compose files, k8s manifests)
3. **Runtime evidence** (OTel `service.name`, `peer.service`, `db.system` attributes create/confirm edges)
4. **AI inference** (only for labeling/purpose text; never for topology)

### Knowledge Graph — *what the user understands*

`Concept` nodes (shared catalog, e.g. PostgreSQL, JWT) linked to `LibraryItem`s (the user's notes). Each item stores the **system explanation** and the **user's own interpretation** side by side. Concepts have `subtopics` used for learning-gap detection.

### Experience Graph — *what the user has lived through*

`Experience` = problem · context · investigation · decision · implementation · outcome · metric · lesson, linked to concepts and projects. Experiences can be captured manually or suggested from runtime evidence (e.g. a slow-query span).

See `src/core/types.ts` for the exact shapes.

---

## 3. Service IR

Natural language is never compiled straight to code.

```
Natural language → Intent Parser → ServiceSpec (IR) → Architecture Planner → Plan → Codegen → Build + Test → Runtime
```

The IR (`ServiceSpec`) holds: requirements (with stable ids), entities, storage, cache, API contract, authentication strategy, implementation stack, dependencies, and **design decisions with reasons and alternatives**. It is serialized as `services/<id>/kivo.service.yaml` and committed with the code.

Why an IR:

- **Reviewable** — the user approves "I understand this as…" before anything is generated.
- **Traceable** — requirement ids flow into test names (`test_password_reset`), span attributes (`kivo.requirement`), and explanations.
- **Diffable** — "Add rate limiting" becomes an IR diff, then a plan, then a code diff.
- **Stack-independent** — switching FastAPI → Express regenerates from the same spec.

The Intent Agent emits the IR under a strict JSON schema, grounded in the System Graph (existing stack and conventions). Ambiguity is returned as explicit questions, not guesses. The prototype uses a deterministic template matcher with the same output contract (`src/core/intent.ts`).

---

## 4. Planner and execution

`planFor(spec)` (`src/core/plan.ts`) produces ordered `PlanStep`s. Each step declares:

| Field | Purpose |
|---|---|
| `executor` | `ai` or `deterministic` |
| `engine` | Which agent or tool runs it (e.g. *Implementation Agent*, *uv*, *pytest*) |
| `what / why / tech / alternatives / consequences` | Feeds the realtime explanation |
| `concept` | Links to the Knowledge Graph for Explain & Capture |
| `artifacts` | Files touched |

### AI vs deterministic responsibilities

| AI handles | Deterministic systems handle |
|---|---|
| Intent parsing, ambiguity, clarifying questions | Project detection |
| Architecture proposals and trade-offs | Dependency resolution, lockfiles, installs |
| Code generation and repair | Builds, linting, formatting, typechecking |
| Explanation and narration | Test execution |
| Orchestration and retrieval ranking | Filesystem and git operations, checkpoints, rollback |
| | Process, port, env and container management |
| | Runtime execution and telemetry |

**Validation rule:** a service is only marked `running` after deterministic steps pass (install → tests against real containers → boot → `/health` → telemetry attached). Test failures are fed back to the Implementation Agent with exact output, up to N repair attempts, then surfaced to the user honestly.

### Toolchains

A **toolchain** is what it takes to turn a language's source into a verified running service: install, lint, test, boot. The pipeline is only allowed to report success through a toolchain it can actually run.

| Layer | File | Responsibility |
|---|---|---|
| Facts (shared) | `src/core/stacks.ts` → `TOOLCHAINS` | Extension, installer, test runner, runtime, and `buildable` per language. The planner and UI read this; nothing assumes "not Python ⇒ TypeScript". |
| Detection (shared) | `src/core/stacks.ts` → `detectStack` | Deterministic: a language/framework named in the request beats the picker. |
| Preflight (daemon) | `server/toolchains.ts` | Probes the machine (e.g. `python3 --version`, ≥ 3.9), cached 60 s, exposed on `/api/health`. A build that can't finish is refused **before any AI call**. |
| Execution (daemon) | `server/pipeline.ts` | The step implementations. Python: pip → pyflakes → pytest (+ repair) → uvicorn `/health`. |

Only Python is `buildable` today. Other languages are planned and reviewed normally; the review screen explains the limit and offers a buildable language. Adding one = a `TOOLCHAINS` entry with `buildable: true`, a preflight check, and install/test/boot steps in the pipeline.

### Daemon boundary

Everything entering the daemon is untrusted and validated in `server/spec.ts` / `server/http.ts`: JSON bodies are size-limited and parsed with 4xx errors, service ids are slugs (`services/<id>` can't escape), stacks are reduced to known languages, and the Intent Agent is grounded in the *actual* service list sent by the UI — never hard-coded names. New services that share a name with a detected service get their own id and directory instead of replacing it.

### Agents

| Agent | Input | Output |
|---|---|---|
| Intent | prompt + System Graph | `ServiceSpec` or questions |
| Project Analysis | detector output | summary + recommended workspace |
| Architecture | IR + System Graph | decisions, API contract, graph delta |
| Implementation | plan step + IR + repo | patch |
| Testing | IR requirements | test files |
| Runtime | spans/logs | node mapping, anomalies, insights |
| Explanation | ref + level + graphs | layered explanation |
| Learning | user activity + graphs | level inference, gap insights |
| Knowledge | selection | concept linking, experience suggestions |

Agents communicate only through the graphs and the IR — never free-form chat with each other — which keeps every intermediate state inspectable.

---

## 5. Project intelligence

`analyzeRepository(files)` (`src/core/detect.ts`) runs rule-based detectors over manifests and config: languages (by line share), frameworks, package managers, databases, caches, infra (Docker, Kubernetes), AI/ML (PyTorch, CUDA, Gymnasium), test frameworks. Output is a list of `Detection { tech, category, evidence, confidence }`. The evidence path is always shown so the user can verify the claim.

The detected disciplines drive the **adaptive workspace**: Software, AI/ML, RL, Security, DevOps are lenses over the same engine, not separate products.

---

## 6. Runtime and observability

Generated services run in containers with OpenTelemetry auto-instrumentation. The Runtime Agent maps spans to System Graph nodes and requirement ids, so every span is a first-class selectable object.

Each span carries narrations at four expertise levels:

| Level | Example (`bcrypt verify`) |
|---|---|
| Beginner | "The password was checked against its secure fingerprint." |
| Intermediate | `bcrypt.verify(password, hash)` |
| Advanced | `passlib bcrypt cost=12 in threadpool executor` |
| Expert | `CPU-bound ≈71ms — dominant span. Tune cost factor or isolate workers under load` |

Production narration: template per span kind + Haiku-class model for attribute-specific phrasing, cached by (span name, attribute shape, level).

---

## 7. Explanation engine

Two orthogonal axes:

- **Expertise level** (beginner → expert): phrasing and default depth.
- **Progressive disclosure** (5 layers): *What happened? → How does it work? → Why was it designed this way? → Implementation details → Architectural trade-offs.*

Level determines how many layers open by default (1 / 2 / 4 / 5). Explanations are **project-specific first**: every concept has a generic `what` and a project-bound `whyHere` + `usedIn`, generated from the System Graph.

**Level inference** is transparent: when the user repeatedly opens layers deeper than their level, Kivo *suggests* switching, with one click to accept. It never changes silently.

---

## 8. Explain & Capture

The signature interaction. Any object is a `KivoRef { kind, id, label, conceptId?, detail? }`. Clicking a `Capturable`, or highlighting text inside a `CaptureScope` (code, logs, explanations, AI output), raises a floating toolbar:

```
Explain · Why? · Note · Save · Ask AI        (keys: E W N S A)
```

- **Explain / Why?** → Context Panel, scrolled to the relevant section
- **Note** → dialog showing the system explanation next to "My understanding"
- **Save** → `LibraryItem` with source mode, project and concept link
- **Ask AI** → contextual conversation with the ref attached

Implementation: `src/shell/capture.tsx`.

---

## 9. Personal AI — context, not retraining

```
Foundation model + Project context + System Graph + Personal knowledge + Experiences + Intent
```

`assembleContext` (`src/core/context.ts`):

1. Resolve the selection and question into **primary** concepts; expand to **related** concepts at reduced weight.
2. Retrieve project facts from the System Graph and IR.
3. Retrieve library items by concept/tag weight × recency.
4. Retrieve experiences **only if they share a primary concept** — no loosely-related war stories.
5. Exclude anything with `useAsContext: false`.
6. Show the ranked list under every answer ("Context used · N items").

Production adds embedding similarity (sqlite-vec) as a secondary signal to concept anchoring.

### User controls

| Control | Scope |
|---|---|
| Personal context on/off | global |
| Remember runtime discoveries | global |
| Use as AI context | per item |
| Private / shared | per item |
| Export memory (JSON) | global |
| Delete all personal memory | global, confirmed |

---

## 10. Learning engine

Tracks concept encounters across projects and which subtopics the user has explored. Produces optional, dismissible insights ("You've worked with Redis 7 times. Not yet explored: eviction policies, replication, clustering"). Clicking an unexplored subtopic opens a project-grounded AI conversation. No streaks, no quizzes, no nagging.

---

## 11. Interface

### Layout

```
┌──────────────────────────────────────────────────────────────────────┐
│ Kivo / project │ Build Observe Learn Library │ ⌘K │ Explain as │ Run │ ◐ │ IA │
├────────────┬───────────────────────────────────────┬─────────────────┤
│ Workspace  │                                       │ Explanation     │
│ Services   │          Main workspace               │ Knowledge       │
│ System     │   (mode-specific view)                │ AI              │
│ Files      │                                       │                 │
├────────────┴───────────────────────────────────────┴─────────────────┤
│ Terminal · Runtime · Logs · Problems · Git                            │
├──────────────────────────────────────────────────────────────────────┤
│ status bar · panel toggles (⌘B ⌘J ⌘I)                                 │
└──────────────────────────────────────────────────────────────────────┘
```

All panels are resizable and collapsible (`react-resizable-panels` via shadcn `Resizable`).

### Modes

| Mode | Main view |
|---|---|
| **Build** | Intent composer + project analysis → "I understand this as" review (requirements, stack, decisions, API, data, IR) → build progress with per-step explanations → service workspace (Overview, Spec, API, Data, Code, Tests, Runtime) |
| **Observe** | Throughput / p50 / p95 / errors / slow queries, live request list, request-flow diagram, span waterfall, level-aware narration, runtime insight with "Capture as experience" |
| **Learn** | Live architecture graph (edges animate with real requests), Intent → Service → Architecture → Implementation → Runtime drill-down, learning insights, project concepts |
| **Library** | Knowledge (system vs. my understanding), Experiences, Personal Knowledge Graph, Memory & privacy |

### Visual system

- shadcn/ui (Radix, Nova preset) for every primitive: Button, Badge, Card, Command, Dialog, DropdownMenu, Select, Tabs, Tooltip, Popover, Sheet, Resizable, ScrollArea, Switch, Table, Collapsible, Progress, Kbd, Sonner.
- Monochrome-first tokens in OKLCH on `:root` / `.dark`; the only hues are semantic (`--success`, `--warning`, `--info`, `--destructive`) and appear as small status dots or text, never fills.
- Geist + Geist Mono. Typography carries hierarchy; borders are 1px `--border`; no gradients, glow or glass.
- Light and dark themes via `next-themes`; React Flow is themed through CSS variables so graphs follow the theme.

### Command interface

⌘K accepts commands *and* natural language. Any input longer than a few characters offers **Build: …** (creates an IR draft) and **Ask Kivo: …** alongside matching commands, services and concepts.

---

## 12. Safety

- Generated code only executes in the sandbox; network egress is deny-by-default with per-service allowlists.
- The Cybersecurity workspace operates only on assets the user explicitly declares in scope, inside the sandbox.
- Every build is a git branch + checkpoint; rollback is one action.
- Secrets live in the OS keychain and are injected as env vars at process start — never written into generated code or model context.
- Model context is always visible to the user before/after use.

---

## 13. MVP scope and roadmap

**MVP (this prototype demonstrates the full loop):**
Repository analysis · Project Graph · NL service creation · Service IR · stack selection · AI implementation plan · build/test validation gates · runtime execution · realtime explanation · architecture visualization · Explain & Capture · Personal Library · Personal Knowledge Graph · Experience Memory · light/dark themes · adaptive workspace · shadcn UI.

Initial stacks: React / React Native + TypeScript; Node.js/TypeScript, Python/FastAPI; PostgreSQL, Redis; Docker.

| Phase | Adds |
|---|---|
| 1 — MVP | Real daemon + sandbox; Claude-backed Intent/Implementation/Explanation agents; OTel collector; SQLite graph store |
| 2 — Breadth | Go, Rust, Java/Kotlin generators; Kubernetes; IR diffs for edits to existing services; team-shared libraries |
| 3 — Disciplines | AI/ML workspace (datasets, experiments, GPU metrics), RL workspace (env/agent/reward/episodes), DevOps incidents |
| 4 — Security | Scoped threat modelling, sandboxed security tests, findings → remediation IR diffs |

---

## 14. Prototype map

```
src/
  core/                 framework-free domain logic
    types.ts            IR, graphs, runtime, knowledge, experience, refs
    intent.ts           intent → ServiceSpec, IR → YAML
    plan.ts             ServiceSpec → PlanStep[] (+ code preview)
    detect.ts           deterministic repository analysis
    runtime.ts          trace simulator with 4-level narration
    concepts.ts         concept catalog (5-layer disclosure)
    context.ts          personal-context retrieval, answers, learning insights
    stacks.ts           language → framework catalog
    seed.ts             demo project, notes, experiences
  state/store.ts        zustand store (persisted: level, library, experiences, privacy)
  shell/                layout, top bar, navigator, context panel, bottom panel,
                        ⌘K, Explain & Capture, dialogs
  features/{build,observe,learn,library}/
  components/ui/        shadcn components
```

The `core/` modules have the same inputs and outputs the production agents and services will have, so they can be swapped one at a time (e.g. replace `parseIntent` with an Intent Agent call) without touching the UI.

---

## 15. Local daemon (implemented)

```
Browser UI ──/api (HTTP+SSE)──▶ Kivo daemon (127.0.0.1:5175) ──▶ Groq (gpt-oss-120b ⇄ gpt-oss-20b)
           ──/ws/terminal────▶   ├─ pty login shell in the workspace
                                 ├─ workspace fs (confined) + git
                                 └─ build pipeline ──▶ pip · pyflakes · pytest · uvicorn
```

```
server/
  index.ts      routes, origin checks, intent normalization, pty terminal
  groq.ts       streaming client, model pool failover, rate-limit waits, adaptive output caps
  pipeline.ts   plan execution: codegen → install → lint/autofix → test → repair → boot → commit
  prompts.ts    Intent / Implementation / Repair agent prompts and conventions
  scaffold.ts   deterministic infrastructure templates (db, outbox, kv, test fixtures)
  workspace.ts  project workspace, safe paths, detection over real files, git
```

Lessons from running it against a free-tier model, now built into the pipeline:

- **Template the infrastructure, generate the domain.** Most failures came from fixed-shape plumbing (SQLite `:memory:` fixtures, stale outbox state, Redis connections). Templating these removed that whole class of failure.
- **Deterministic gates before model repairs.** pyflakes catches undefined names in milliseconds, and the missing-import autofix resolves most of them with no model call.
- **Repairs are edits, not rewrites.** SEARCH/REPLACE blocks fit the token budget and can't clobber working files. The model only edits files it has seen verbatim.
- **Model output is untrusted input.** JSON is coerced field by field; truncated file blocks are discarded rather than half-written.
- **Be honest about state.** "Running" requires clean lint, passing tests and a healthy process. Anything less boots "for inspection" with the real failure output.
