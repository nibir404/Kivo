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
npm test          # every workspace's tests (core, daemon, web)
npm run typecheck # TypeScript across every workspace, tests included
npm run lint      # oxlint over the whole repo
npm run check     # typecheck + lint + tests (what CI runs, plus the build)
npm run e2e       # Playwright: builds everything, then runs the end-to-end suites below
```

Run one workspace with `-w`, e.g. `npm test -w @kivo/daemon` or `npm run dev -w @kivo/web`.

**End-to-end tests (Playwright).** `npm run e2e:install` once (downloads Chromium), then `npm run e2e`. Four suites, one per way Kivo runs:

| Project | What it drives |
|---|---|
| `api` | The daemon's HTTP API: health, Host/Origin guards, files, editor operations, search, key handling |
| `daemon` | The UI served by the daemon: tour, editing and saving to disk, the real terminal, ⌘K |
| `browser` | The hosted web app with no daemon: IndexedDB storage, key validation, Groq streaming (mocked, no real key), and falling back to the browser when no daemon answers on localhost |
| `desktop` | The Electron app with its own daemon: title bar, key, terminal through node-pty, menu commands, links opening outside the app |

The daemon under test uses a throwaway data folder (`e2e/.tmp/`) and no AI keys, so tests never touch your projects or spend tokens. Run one suite with `npx playwright test --project=browser`. To test a packaged app instead of the dev build: `E2E_DESKTOP_APP=apps/desktop/release/mac-arm64/Kivo.app/Contents/MacOS/Kivo npx playwright test --project=desktop`. Failures leave a trace and screenshot in `test-results/` (`npx playwright show-report`).

---

## Project Structure

An npm-workspaces monorepo: three apps and three shared packages.

```
kivo/
├── apps/
│   ├── web/                  @kivo/web — the UI (React 19, Vite, Tailwind, shadcn)
│   │   ├── src/
│   │   │   ├── shell/        app frame: top bar, navigator, panels, ⌘K, dialogs, projects, terminal
│   │   │   ├── features/     build · code · editor · scm · agent · observe · learn · library · workspace
│   │   │   ├── state/        zustand store and the actions that talk to the API
│   │   │   ├── lib/          typed API clients + transport.ts (daemon, or the in-page backend)
│   │   │   ├── backend/      the browser backend: the daemon's API answered inside the page
│   │   │   └── components/ui/  shadcn primitives
│   │   ├── test/
│   │   └── vite.config.ts
│   ├── desktop/              @kivo/desktop — the Electron app: starts the daemon, opens the UI in a window
│   │   ├── src/              main.ts (daemon process, window, menu) and preload.ts (the page's only bridge)
│   │   └── scripts/          build.mjs (esbuild bundles), package.mjs (electron-builder), icon.mjs
│   └── daemon/               @kivo/daemon — the local daemon on 127.0.0.1 (Node, node-pty, ws)
│       ├── src/
│       │   ├── index.ts      server entry and routes
│       │   ├── http/         response helpers, Host/Origin policy, static UI serving
│       │   ├── ai/           provider config from .env (the client itself is @kivo/ai)
│       │   ├── build/        the build pipeline (installs, tests, boot) and toolchains
│       │   ├── projects/     current project, open / clone / switch
│       │   ├── editor/ scm/ agent/ terminal/   one folder per feature API
│       │   └── paths.ts      where the repo and built UI live
│       └── test/
├── packages/
│   ├── core/                 @kivo/core — pure domain model: service IR, intent, planning, detection, search matching
│   ├── ai/                   @kivo/ai — AI layer for both daemon and browser: provider client with failover,
│   │                         prompts, spec validation, codegen parsing, the coding-agent loop
│   └── seed-project/         @kivo/seed-project — the demo project's files
├── e2e/                      Playwright suites: api · web (daemon UI) · browser (hosted) · desktop
├── docs/                     architecture and project memory
├── .github/workflows/ci.yml  checks on Linux and macOS, Playwright, desktop packages for every OS
└── tsconfig.base.json        compiler options every workspace extends
```

Boundaries: the packages import nothing from either app, and the web app never imports daemon code. They talk only over Kivo's HTTP/SSE and WebSocket API. That API is served by the daemon, or, in the hosted app, by `apps/web/src/backend`, which implements the same routes inside the page. The `.env` file and the `.kivo-workspace/` data folder stay at the repo root. `npm run build` writes the UI to `apps/web/dist`, which `npm start` serves (`KIVO_WEB_DIST` points it elsewhere).

---

## Kivo in the Browser (Hosted Web App)

The same build runs as a static site with no daemon. On any host other than `localhost`, Kivo answers its own API inside the page:

| Works in the browser | How |
|---|---|
| **AI**: planning, Ask, Explain, inline ⌘K edits, Tab autocomplete, the Agent | Groq is called directly from the page with **your own key**, pasted once in Preferences → AI. The key is checked with Groq before it's saved, stored only in that browser's `localStorage`, and sent only to `api.groq.com`. The deployed files contain no key. |
| **Your folders** | *Open folder* uses the browser's folder picker (Chrome, Edge). The browser asks before Kivo may read or write it. Files are edited in place on your disk; nothing is uploaded. |
| **GitHub** | *Import from GitHub* downloads a public repository's text files into browser storage (IndexedDB). |
| **The demo** | Kept in this browser; edits persist; *Reset demo project* restores it. |
| **Editor** | Explorer (create, rename, move, duplicate, delete), Quick Open, find & replace in files, the same matcher as the daemon. |
| **Builds** | Every code-generation step runs for real and writes the files. Install, test and boot are marked *skipped*, and the service is shown as *Code written*, never as running. |

A web page can't run a shell, git or Python on your computer, so the **terminal, source control and running services** say they need Kivo on your computer (`npm run dev`). Deleting in the browser is permanent (there's no system trash), and the confirmation says so.

Build the hosted site with `npm run build:hosted` (it lives at `/app/`), then deploy `apps/web/dist-hosted`. It's a separate folder, so it never clashes with the build that `npm start` and the desktop app use.

**Which backend is used** is decided when the page loads: the desktop app always uses its own daemon; a hosted site runs in the page; on `localhost`, Kivo uses the daemon if one answers and otherwise runs in the browser instead of showing "offline" (and offers to switch once the daemon starts). To force a mode locally, open `?backend=browser` or `?backend=daemon` (remembered).

---

## Kivo Desktop (macOS, Windows, Linux)

The full system in one app, like the Claude desktop app: no terminal commands, nothing to keep running.

```bash
npm run desktop           # build and open the app from this checkout
npm run desktop:package   # installable app for this OS → apps/desktop/release/ (.dmg/.zip, .exe, .AppImage)
```

- **Always connected.** The app starts Kivo's daemon itself (in an Electron utility process, on a free port on 127.0.0.1) and shows its UI in the window. Everything is real: your folders, terminal, git, installs, tests, running services.
- **AI.** Paste your Groq key in Settings (⌘,). It's checked with Groq first, then kept in the app's data folder, readable only by your user account, and used only by the daemon. The window never sees it.
- **Your environment.** Apps opened from the Dock get a bare `PATH`, so Kivo loads your login shell's environment first; the terminal finds your Homebrew, nvm, pyenv tools.
- **Data** lives in the app's data folder (`~/Library/Application Support/Kivo` on macOS), not in a checkout. Cloned repositories still go to `~/Kivo`. Logs: *Help → Show Logs*.
- **Safety.** The page has no Node access: a sandboxed window, one small preload bridge (menu commands), and navigation limited to Kivo's own UI; other links open in your browser. The daemon keeps its Host and Origin checks.
- **Signing.** Builds are unsigned by default (on macOS, right-click → Open the first time). To sign and notarize, set `CSC_LINK`/`CSC_KEY_PASSWORD` and `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`. CI packages every OS as build artifacts.

---

## What's Real in Kivo

| Capability | How It Works |
|---|---|
| **Intent → Spec** | Groq (`openai/gpt-oss-120b`) transforms plain-English descriptions into a typed Service IR under a JSON schema contract with streaming reasoning. |
| **Deterministic & AI Build** | Domain code streams token-by-token into `.kivo-workspace/tandem/services/<id>/`. Infrastructure files (`db.py`, `outbox.py`, `kv.py`, `conftest.py`) use deterministic templates to eliminate boilerplates. |
| **Pipeline Verification** | Import detection → allowlisted `pip install` → `pyflakes` linting (+ deterministic import autofix) → `pytest` suite → up to 3 AI repair iterations using exact SEARCH/REPLACE blocks → `uvicorn` boot with `/health` polling. |
| **Radical Honesty** | A service is marked **running** only when lint is clean and 100% of tests pass. Failing services boot "for inspection" with live failure logs exposed. |
| **Git & Source Control (SCM)** | Complete in-app Git GUI powered by Git Porcelain v2: stage/unstage files, view unified and split diffs, generate AI commit messages grounded in staged diffs, switch/create branches, publish upstream, push, and pull. Safe discard sends files to OS Trash. |
| **Runs in the Browser** | The hosted web app works without the daemon: AI with your own Groq key, your local folders (File System Access API), GitHub imports and the editor. See [Kivo in the Browser](#kivo-in-the-browser-hosted-web-app). |
| **Autonomous Coding Agent** | Multi-turn tool-calling loop (`list_files`, `read_file`, `search`, `edit_file`, `run_command` with user approval checkpoints). Path traversal protection, `.git` write guards, and inline ghost-text code autocomplete. |
| **Your Projects** | Open any folder on your machine (`⌘O`: native Finder picker or an in-app folder browser) or clone a repository (`owner/repo`, HTTPS or SSH URL) with your own git credentials. Recent projects are remembered. Your projects are never auto-committed and use your git identity and tools; only the built-in demo is Kivo-managed. |
| **Code Editor** | CodeMirror 6 with Python, TS/JS, Go, Rust, Java, C/C++, CSS, HTML, PHP, SQL, Markdown, YAML, JSON and more. Explorer with new/rename/move (drag & drop)/duplicate/delete-to-Trash; Quick Open (`⌘P`), go to line/symbol; find & replace across files (ripgrep → git grep → JS scan); multi-cursor; breadcrumbs; live reload when files change on disk, with a conflict bar for unsaved edits; inline `⌘K` AI edits and Tab autocomplete. |
| **Terminal** | Your real login shell (`node-pty` over WebSocket) with full access to your machine, opening in the current project (or your home folder from the `+` menu). Sessions live in the daemon and survive refreshes, with scrollback replay, search, clickable links and WebGL rendering. |
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

Adding a language requires defining a toolchain in `packages/core/src/stacks.ts`, preflight checks in `apps/daemon/src/build/toolchains.ts`, and pipeline verification steps. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#toolchains).

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
4. **Kivo's Keys Stay in the Daemon**: Kivo's AI provider keys are read from `.env` (git-ignored) and removed from the environment of terminals, builds and agent commands. Your own environment (SSH agent, `gh` login, PATH) is kept, so git and your tools work as they do in any terminal. The terminal is a real shell with your user's permissions; the agent's commands run only after you approve each one.
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
| `⌘P` | Quick Open (`:` line, `@` symbol) |
| `⌘O` | Open a folder |
| `⌘⇧F` | Find / replace in files |
| `⌘⇧E` / `⌃⇧G` | Explorer / Source Control |
| `⌘⇧O` / `⌃G` | Go to symbol / line |
| `Tab` | Accept AI autocomplete |
| `⌘,` | Open Preferences |
| `?` | Show all keyboard shortcuts |

---

## Stack

- **Frontend**: React 19 · TypeScript · Vite 8 · Tailwind CSS v4 · shadcn/ui (Radix) · CodeMirror 6 · xterm.js · React Flow · Zustand
- **Daemon / Backend**: Node.js 22 · `tsx` · `node-pty` · `ws` · Git Porcelain v2 · Groq API

---

## License

MIT © [Kivo Contributors](https://github.com/nibir404/Kivo)
