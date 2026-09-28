# Kivo — Persistent Codebase Memory

> **Last Updated**: 2026-09-28  
> **Status**: Active & Evergreen  
> **Maintained by**: `codebase-memory` skill before every git push.

---

## 1. Project Identity & Philosophy

- **Name**: Kivo
- **Core Premise**: Build software by describing what you want. Understand it by watching how it works.
- **Key Characteristics**:
  - Intent-driven engineering environment spanning 9 domain workspaces.
  - Three-graph foundation: **System Graph**, **Knowledge Graph**, and **Experience Graph**.
  - Local-first architecture: Code, database, git, terminal shells, and memory stay local.
  - Radical honesty: Zero fake statuses. A service is only marked "running" if tests pass and lint is clean.

---

## 2. Process Topology & Runtime Ports

| Component | Technology | Default Port / Binding | Role |
|---|---|---|---|
| **Kivo Daemon** | Node.js 22 + `tsx watch` + `ws` + `node-pty` | `http://127.0.0.1:5175` | Local API, WebSocket terminal server, build pipeline, git/SCM engine, file system sandbox, AI orchestration |
| **Kivo UI** | Vite 8 + React 19 + Tailwind v4 + shadcn/ui | `http://localhost:5174` | Desktop web interface, CodeMirror 6 editor, xterm.js terminal, React Flow graphs |
| **Unified Production** | Daemon single-port serving | `http://localhost:5175` | Daemon serves the production build (`dist/`) directly on port 5175 via `npm start` |
| **Vite Proxy** | Configured in `vite.config.ts` | `/api` and `/ws` → `5175` | Development proxy enabling hot module reloading without cross-origin issues |

---

## 3. Core Subsystems & Architecture

### A. Intent, Spec & Build Pipeline (`server/pipeline.ts`, `server/spec.ts`, `server/prompts.ts`)
- **Intent Analysis**: Streams user requirements through LLM (Groq default `gpt-oss-120b`), generating a structured Service IR (`ServiceSpec`).
- **Validation & Preflight**: Strict boundary checks (`server/toolchains.ts`). Language toolchains must be validated before file writes or model calls.
- **Code Generation**: Implementation Agent writes domain code into `.kivo-workspace/tandem/services/<id>/`. Infrastructure files (`db.py`, `outbox.py`, `kv.py`, `conftest.py`) are deterministically templated to prevent hallucinated boilerplates.
- **Verification Loop**: 
  1. `pip install` from detected imports (only against allowlisted packages; unknown packages halted).
  2. Deterministic `pyflakes` linting with automated import fixer.
  3. `pytest` test suite execution.
  4. Up to 3 AI repair iterations using targeted SEARCH/REPLACE blocks.
  5. `uvicorn` process launch with `/health` polling.

### B. In-App Source Control / Git Integration (`server/scm.ts`, `src/features/scm/`)
- Full Git client integrated in the IDE powered by Git Porcelain v2.
- Supports: Staging, unstaging, line-level / file-level discard (untracked files sent safely to OS Trash, never hard deleted).
- Diff visualizer: Side-by-side and unified diffs with syntax highlighting.
- AI Commit Messages: Grounded specifically on staged diff context.
- Remote management: Branch creation, checkout, tracking upstreams, push, pull with conflict detection.

### C. Autonomous AI Coding Agent (`server/agent.ts`, `src/features/agent/`)
- Multi-turn tool-calling loop equipped with:
  - `list_files`: Glob / regex pattern directory listing.
  - `read_file`: Line-ranged safe text reading.
  - `search`: Fast text search across files.
  - `edit_file`: SEARCH/REPLACE blocks or full file creation.
  - `run_command`: Terminal command execution with mandatory user approval gates.
- Sandbox security: All paths resolved via `resolveIn()`. Traversal, symlink escaping, and `.git` writes are strictly prevented.
- Autocomplete engine: Fill-in-the-middle (FIM) ghost text completion in the editor with debouncing and LRU cache.

### D. Multi-Project Management (`server/projects.ts`, `src/shell/projects/`)
- Allows opening any local folder or cloning Git repositories directly into Kivo.
- Maintains recent project history, persistent project settings, and project-scoped sandboxes.
- Seamless toggle between managed demo workspace and custom user projects.

### E. Advanced Code Editor (`server/editor.ts`, `src/features/editor/`, `src/features/code/`)
- Built on CodeMirror 6 with support for Python, TypeScript, TSX, JS, SQL, Markdown, YAML, and JSON.
- Multi-tab management: Pinning, reordering, dirty state tracking, and tab actions.
- Project-wide search: Hybrid engine with ripgrep JSON, `git grep`, and pure JavaScript fallback.
- Document symbol outline and breadcrumb navigation.
- Inline AI edits (⌘K): Selection-based or whole-file diff streaming with Accept/Reject controls.

### F. Persistent Terminal Multiplexer (`server/terminals.ts`, `src/shell/terminal/`)
- `node-pty` instances running in daemon background over WebSockets.
- Sessions persist across page refreshes and browser tab closes.
- Automatic reconnect with scrollback replay buffers.
- GPU-accelerated rendering with WebGL fallback to DOM.

### G. Domain Workspaces (`src/features/workspace/`)
Nine specialized engineering perspectives over the same codebase:
1. **Software**: End-to-end service generation, spec planning, and live API observation.
2. **Web & Mobile**: Component hierarchies, route inspection, accessibility audits, and design tokens.
3. **Data Engineering**: Data pipelines, schema migrations, outbox patterns, and entity lineage.
4. **AI / ML**: Model artifacts, training logs, evaluation benchmarks, and notebooks.
5. **Reinforcement Learning**: Gymnasium/SB3 environments, reward functions, and policy metrics.
6. **Cybersecurity**: Threat modeling (STRIDE), attack surface inspection, and auth route scanning.
7. **DevOps / SRE**: Container health, service logs, incident trackers, and SLO monitors.
8. **Embedded / IoT**: PlatformIO config, firmware size, memory mapping, and serial monitors.
9. **Game Development**: Scene trees, asset registries, input mappings, and frame budget audits.

---

## 4. Security & Safety Invariants

1. **Loopback & Origin Protection**: Daemon binds only to `127.0.0.1`. All HTTP requests and WebSocket connections reject non-whitelisted origins (blocking cross-site attacks).
2. **DNS Rebinding Guard**: Only `Host: localhost` or `127.0.0.1` are answered.
3. **Path Traversal Shield**: Every filesystem path is resolved through `safePath()` / `resolveIn()`. Symlinks escaping the workspace root are refused. Writing inside `.git` is banned.
4. **Environment Isolation**:
   - AI provider keys (`GROQ_API_KEY`, etc.) live only in daemon `.env` and are stripped from child processes, terminal shells, and client bundles.
   - Generated code / tests execute with allowlisted environment variables to prevent leaking credentials (`AWS_*`, `GITHUB_TOKEN`, `SSH_AUTH_SOCK`).
5. **PyPI Package Safeguard**:
   - Automatic `pip install` only installs known, verified packages.
   - Unknown packages halt the build and require explicit entry into `KIVO_EXTRA_PACKAGES`.
6. **Trash Over Deletion**: File discard moves files to system Trash (`~/.Trash` on macOS, `.local/share/Trash` on Linux) to prevent accidental data destruction.

---

## 5. AI Providers & Failover Strategy

- **Groq** (`GROQ_API_KEY`): Primary default provider.
  - Primary model: `openai/gpt-oss-120b`
  - Fallback model: `openai/gpt-oss-20b` (triggered automatically upon rate limits)
- **Puku** (`PUKU_API_KEY`): Integrated endpoint. (Currently requires JWT session auth).
- **Custom / OpenAI-Compatible**: Configurable via `OPENAI_COMPAT_BASE_URL` and `OPENAI_COMPAT_API_KEY`.
- Cross-provider failover enabled by default (`KIVO_CROSS_PROVIDER_FAILOVER=1`).

---

## 6. Verification & Test Suite

Run tests regularly:
```bash
npm test          # 158 tests across 34 suites (agent, editor, SCM, workspaces, daemon)
npm run typecheck # TypeScript checks for UI, server, and tests
npm run lint      # oxlint validation
npm run check     # Full verification (typecheck + lint + tests)
```

---

## 7. Pre-Push Synchronization Checklist

Before pushing to git (`git push`), verify:
- [ ] Run `npm run check` and ensure all tests pass.
- [ ] Check `git status` for untracked files or unintended diffs.
- [ ] Update this file (`docs/MEMORY.md`) if any architectural change, new feature, security rule, or configuration was modified.
- [ ] Stage `docs/MEMORY.md` into the commit.
