# Kivo

**Build software by describing what you want. Understand it by watching how it works.**

One unified engineering environment. Any stack. Any discipline. Any level of expertise.

Kivo is an intent-driven engineering platform: you describe a service, review what Kivo understood as a structured specification, watch it get built with every step explained in real-time, then observe it running live — all while capturing what you learn into a persistent library that makes future workflows yours.

---

## Quick Start

### Prerequisites
- **Node.js**: 22.9+
- **Git**: 2.30+
- **Python**: 3.9+ (for verified Python/FastAPI service builds)

### 1. Install & Configure

```bash
git clone https://github.com/nibir404/Kivo.git
cd Kivo
npm install
cp .env.example .env   # add your GROQ_API_KEY to .env
```

### 2. Start Development

```bash
npm run dev            # daemon (127.0.0.1:5175) + Vite UI with hot reload (localhost:5174)
```

Open [http://localhost:5174](http://localhost:5174) in your browser.

### 3. Production Build (Single Process)

To run Kivo as a single background daemon that serves the production UI:

```bash
npm run build
npm start              # daemon serves the built UI → open http://localhost:5175
```

### 4. Tests & Quality Gates

```bash
npm test          # 158 tests across 34 suites (agent, SCM, projects, editor, toolchains)
npm run typecheck # TypeScript strict typecheck across client and server
npm run lint      # oxlint validation
npm run check     # full verification (typecheck + lint + tests)
```

---

## What's Real in Kivo

| Capability | How It Works |
|---|---|
| **Intent → Spec** | Groq (`openai/gpt-oss-120b`) transforms plain-English descriptions into a typed Service IR under a JSON schema contract with streaming reasoning. |
| **Deterministic & AI Build** | Domain code streams token-by-token into `.kivo-workspace/tandem/services/<id>/`. Infrastructure files (`db.py`, `outbox.py`, `kv.py`, `conftest.py`) use deterministic templates to eliminate boilerplates. |
| **Pipeline Verification** | Import detection → allowlisted `pip install` → `pyflakes` linting (+ deterministic import autofix) → `pytest` suite → up to 3 AI repair iterations using exact SEARCH/REPLACE blocks → `uvicorn` boot with `/health` polling. |
| **Radical Honesty** | A service is marked **running** only when lint is clean and 100% of tests pass. Failing services boot "for inspection" with live failure logs exposed. |
| **Git & Source Control (SCM)** | Complete in-app Git GUI powered by Git Porcelain v2: stage/unstage files, view unified and split diffs, generate AI commit messages grounded in staged diffs, switch/create branches, publish upstream, push, and pull. Safe discard sends files to OS Trash. |
| **Autonomous Coding Agent** | Multi-turn tool-calling loop (`list_files`, `read_file`, `search`, `edit_file`, `run_command` with user approval checkpoints). Path traversal protection, `.git` write guards, and inline ghost-text code autocomplete. |
| **Multi-Project Manager** | Open any local directory or clone external Git repositories into Kivo. Switch between the managed demo and real-world repositories with persistent recent history. |
| **Advanced Code Editor** | CodeMirror 6 with syntax support for Python, TS, TSX, JS, SQL, Markdown, YAML, and JSON. Multi-tab management, project-wide fast search (ripgrep / git grep / JS fallback), document symbol hierarchy, and inline ⌘K diff edits. |
| **Persistent Terminals** | Real login shells (`node-pty` over WebSocket). Terminal sessions live in the daemon, surviving browser refreshes and tab closures with scrollback replay. GPU-accelerated WebGL rendering. |
| **Interactive API Client** | Automatically parses OpenAPI schemas from running services, providing an in-app test bench with captured JWT session reuse. |
| **Evergreen Codebase Memory** | Persistent architectural memory (`docs/MEMORY.md`) maintained automatically via the `codebase-memory` skill before every git push. |

---

## 9 Domain Workspaces

One codebase, nine specialized engineering lenses. Switch anytime from the navigator or via `⌘K` → "workspace":

| Workspace | Focus & Sections | Derived from Project |
|---|---|---|
| **Software** | Intent → spec → build → inspect → run | Everything (full loop) |
| **Web & Mobile** | Screens · Components · API usage · Design tokens · Accessibility · Performance · Builds | Route files, component trees, API client endpoints, platform configs |
| **Data Engineering** | Sources · Schemas · Migrations · Pipelines · Lineage · Data quality · Freshness | Datastores, entities, `migrations/`, outbox tables, system graph |
| **AI / ML** | Datasets · Experiments · Training · Models · Evaluation · Compute · Notebooks | Dataset paths, `train*.py`, model weights, Jupyter notebooks, MLflow/WandB |
| **Reinforcement Learning** | Environment · Agent · Policy · Reward · Episodes · Training health · Sanity checks | `env*.py`, agent policies, Gymnasium / Stable-Baselines3 modules |
| **Cybersecurity** | Scope · Attack surface · Findings · Controls · Threat model (STRIDE) · Security tests | Route auth status, unauthenticated writes, missing rate limits, security headers |
| **DevOps / SRE** | Services · Containers · Deployments · Logs · Metrics · Incidents · SLOs · Runbooks | Container states, CI workflows, live daemon logs, incident triggers |
| **Embedded / IoT** | Devices · Firmware · Sensors & buses · Memory · Power · Serial monitor · Flash & OTA | `platformio.ini`, `sdkconfig`, firmware sources, sensor driver modules |
| **Game Development** | Scenes · Entities & scripts · Assets · Frame budget · Input map · Builds · Playtests | Engine configuration, scene hierarchies, script assets, texture registries |

Every section displays evidence badges: **From this project** (with clickable file links), **Example data** (clearly labeled mock data when not yet detected), or **Checklist** (interactive best-practice guides persisted locally).

---

## Language Toolchains

Name a language in your prompt (*"Create an invoice service in Spring Boot"*) and Kivo respects it; otherwise it defaults to the active project stack.

| Language / Framework | Plan & Review | Build · Test · Run |
|---|---|---|
| **Python (FastAPI)** | Supported | Fully verified automated pipeline (codegen, lint, pytest, uvicorn) |
| **Java / Kotlin (Spring, Quarkus)** | Supported | Preflight flags as unbuilt; offers Python pipeline or external build |
| **TypeScript / Node / Go / Rust** | Supported | Verified preflight detection; toolchains in active development |

Adding a language requires defining a toolchain in `src/core/stacks.ts`, preflight checks in `server/toolchains.ts`, and pipeline verification steps. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#toolchains).

---

## AI Providers & Failover

Configure your preferred providers in `.env` (see `.env.example`):

| Provider | Environment Variables | Capabilities |
|---|---|---|
| **Groq** (Default) | `GROQ_API_KEY` | `openai/gpt-oss-120b` (primary) with automatic failover to `openai/gpt-oss-20b` on rate limits. |
| **Puku** | `PUKU_API_KEY`, `PUKU_BASE_URL` | Integration endpoint (requires JWT authentication). |
| **OpenAI-Compatible** | `OPENAI_COMPAT_BASE_URL`, `OPENAI_COMPAT_API_KEY`, `OPENAI_COMPAT_MODELS` | Supports OpenRouter, vLLM, Ollama, LocalAI, or custom OpenAI proxies. |

- **Cross-Provider Failover**: When the active provider is rate-limited, requests automatically transition to alternative configured providers (`KIVO_CROSS_PROVIDER_FAILOVER=1`).
- **Live Health Status**: Top-bar chip monitors API latency, model authorization, and rate-limit cooldown timers.

---

## Security & Sandboxing

Kivo is designed with defense-in-depth security invariants:

1. **Loopback & Origin Protection**: The daemon binds strictly to `127.0.0.1` and drops any HTTP or WebSocket request from origins other than the Kivo UI (`localhost:5174`, `127.0.0.1:5174`, `localhost:4173`).
2. **DNS Rebinding Shield**: Only requests with loopback `Host` headers (`localhost`, `127.0.0.1`) are answered.
3. **Workspace Confinement**: All file reads, writes, and searches pass through `resolveIn()` / `safePath()`. Path traversal attempts (`../`), symlink escapes, and modifications to `.git/` are strictly blocked.
4. **Environment Isolation**: API keys exist only in daemon memory from `.env` (git-ignored) and are stripped from terminal shells and child processes. Code runs with an allowlisted environment to prevent exfiltration of `AWS_*`, `GITHUB_TOKEN`, or `SSH_AUTH_SOCK`.
5. **Supply Chain Safeguard**: Automated `pip install` only installs vetted packages. Unknown dependencies halt the build and require explicit approval in `KIVO_EXTRA_PACKAGES`.
6. **Destructive Action Protection**: Discarding files in SCM or deleting files in the explorer moves them to the operating system's Trash (`~/.Trash` on macOS, `.local/share/Trash` on Linux) rather than permanently deleting them.

---

## Codebase Memory System

Kivo includes a built-in context preservation workflow powered by the `codebase-memory` skill and [docs/MEMORY.md](docs/MEMORY.md):
- **Pre-Push Sync**: Run `./scripts/sync-memory.sh` before pushing code.
- **Continuous Documentation**: Captures architecture changes, toolchain updates, security boundaries, and decisions in version control.
- **Zero Context Loss**: Keeps AI agents, human developers, and new team members aligned with the current state of the repository.

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `⌘K` | Open Command Menu / Inline AI Edit (in editor) |
| `⌘1` – `⌘5` | Switch modes (Build, Code, Observe, Learn, Library) |
| `⌘B` | Toggle Navigator panel |
| `⌘J` | Toggle Terminal panel |
| `⌘I` | Toggle Context panel |
| `⌘S` | Save current file |
| `⌘P` | Quick Open file palette |
| `⌘,` | Open Preferences |
| `?` | Show all keyboard shortcuts |

---

## Stack

- **Frontend**: React 19 · TypeScript · Vite 8 · Tailwind CSS v4 · shadcn/ui (Radix) · CodeMirror 6 · xterm.js · React Flow · Zustand
- **Daemon / Backend**: Node.js 22 · `tsx` · `node-pty` · `ws` · Git Porcelain v2 · Groq API

---

## License

MIT © [Kivo Contributors](https://github.com/nibir404/Kivo)
