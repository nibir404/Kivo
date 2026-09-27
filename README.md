# Kivo

**Build software by describing what you want. Understand it by watching how it works.**

One engineering environment. Any stack. Any discipline. Any level of expertise.

Kivo is an intent-driven engineering environment: you describe a service, review what Kivo understood as a structured spec, watch it get built with every step explained, then observe it running — and capture what you learn into a personal library that makes future answers yours.

This repository is the working prototype of the full loop, plus the architecture it's designed around ([docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)).

## Run it

```bash
npm install
cp .env.example .env   # then put your GROQ_API_KEY in .env
npm run dev            # starts the Kivo daemon (127.0.0.1:5175) and the UI (localhost:5174)
```

Without a key, or without the daemon, Kivo still runs in offline mode with simulated builds (clearly labelled).

## What's real

| | How it works |
|---|---|
| **Intent → spec** | Groq (`openai/gpt-oss-120b`) turns your description into a Service IR under a JSON contract; the reasoning streams live. |
| **Build** | The Implementation Agent writes real files into `.kivo-workspace/tandem/services/<id>/`, streaming token by token. Infrastructure (`db.py`, `outbox.py`, `kv.py`, `tests/conftest.py`) comes from deterministic templates. |
| **Validation** | `pip install` of requirements derived from the code's imports → `pyflakes` lint (+ deterministic import autofix) → `pytest` → up to 3 AI repair rounds using targeted SEARCH/REPLACE edits → `uvicorn` boot with a `/health` check. |
| **Honesty** | A service is only marked running when lint is clean and every test passes; otherwise it boots "for inspection" and the failing output is shown. |
| **Terminal** | A real login shell (pty over WebSocket) in the project workspace, with the build venv on `PATH`. Try `cd services/authentication && pytest` or `curl` the running service. |
| **Code** | A pure editor (CodeMirror) over the real files. **Inline AI edit**: select code with the mouse and the prompt opens by itself (or press ⌘K on a selection or line), describe the change, watch it stream in as a red/green diff, then Accept ⌘↵ / Reject Esc / refine with a follow-up. ⌘S saves; right-click or ⌘E explains a selection. |
| **API client** | Every service Kivo runs gets an in-app API tab: endpoints and example bodies come from its live OpenAPI schema, tokens from login responses are captured and reused. Requests go through the daemon, which can only reach Kivo-launched services. |
| **Git** | The workspace is a git repo; every build is a commit (`feat(...)` when green, `wip(...)` when not). |
| **AI answers** | Streaming Groq answers grounded in the project graph and your personal notes/experiences, with the retrieved context listed under each answer. |

Still simulated: the traffic in **Observe** (request traces and metrics). Real logs from running services stream into the **Logs** tab.

## AI providers

Kivo talks to any OpenAI-compatible provider. Configure one or more in `.env` (see `.env.example`):

| Provider | Env | Notes |
|---|---|---|
| Groq | `GROQ_API_KEY` | Default. `gpt-oss-120b` → `gpt-oss-20b`. |
| Puku | `PUKU_API_KEY` (+ optional `PUKU_BASE_URL`, `PUKU_MODELS`, `PUKU_AUTH_HEADER`) | `api.puku.sh/v1` currently requires a JWT from Puku's sign-in, so `pk_live_` keys show as **Not authorized** until Puku documents how they authenticate. |
| Any other | `OPENAI_COMPAT_BASE_URL`, `OPENAI_COMPAT_API_KEY`, `OPENAI_COMPAT_MODELS` | OpenRouter, a self-hosted gateway, etc. |

The status chip in the top bar shows every provider's live state (connected / not authorized / unreachable / not configured) with the provider's own error message, lets you switch the active one, and re-checks on demand. When the active provider is rate-limited, other connected providers take over (`KIVO_CROSS_PROVIDER_FAILOVER=0` to disable). A provider that starts rejecting its key mid-session is taken out of rotation automatically.

## Groq free tier

Free Groq keys allow ~8K tokens per minute per model. Kivo fails over between `gpt-oss-120b` and `gpt-oss-20b` and waits exactly as long as Groq asks, showing the countdown. A full authentication build takes about 1–4 minutes. Quality varies run to run; failures are shown with exact output, and you can fix them in Code and re-run `pytest` in the Terminal.

## Security

- The daemon binds to `127.0.0.1` and rejects requests and WebSocket upgrades from any origin other than the Kivo UI, so other websites can't reach your shell or files.
- File access is confined to the workspace directory.
- The API key lives only in `.env` (git-ignored). It's never sent to the browser and it's stripped from the environment of the shell and every child process.
- Model output is treated as untrusted: JSON is coerced into typed structures, and Markdown renders without raw HTML.

## Try this

1. **Build**: click the authentication example and press ↑. Watch the Intent Agent reason, review *"I understand this as"* (including its open questions), then **Build Authentication**.
2. The **Build** tab is a timeline: finished steps collapse to one line, the running step shows the code being written or the tool output. "Why this step?" opens the explanation beside it.
3. When it finishes, the result card offers **Try the API** (in-app client), **Open code**, **Run tests** (typed into the built-in terminal) and **Rebuild**, or **Ask AI why** if something failed.
4. **Code** (⌘2): open a generated file, select a function, press **⌘K** and describe a change.
5. **Observe / Learn / Library**: the runtime explanation, architecture graph, and personal knowledge features from before.

`⌘K` opens the command menu (or inline edit inside the editor). `⌘1–5` switch modes. `⌘B` / `⌘J` / `⌘I` toggle the panels. `⌘,` opens Preferences, `?` lists every shortcut. Below 960px wide, the navigator and context panel become slide-over sheets.

## You stay in control

- **First run** shows a short welcome. You pick how Kivo explains things (Beginner → Expert) and where to start. You can reopen it from the avatar menu → Getting started.
- **Nothing runs on its own.** Demo traffic is simulated, labelled as such, and off until you turn it on (status bar, Observe, or Preferences). When a build finishes, Kivo tells you what happened and offers next steps. It doesn't switch screens for you.
- **Every decision point offers choices.** On intent review you can Build, Refine description (it goes back to the composer with your text) or Discard (with Undo). Empty screens (Code, Observe) suggest where to begin instead of showing a blank page.
- **Preferences** (`⌘,`) covers theme, explanation depth, AI provider, focus mode for code, the Explain & Capture toolbar, build notifications, demo traffic, layout reset, and memory/privacy.
- **Your layout sticks.** Panel sizes you drag are remembered across sessions. The terminal panel starts folded and opens when you run something.

## Stack

React 19 · TypeScript · Vite · Tailwind v4 · shadcn/ui (Radix) · CodeMirror 6 · xterm.js · React Flow · Zustand — daemon: Node 22 · node-pty · ws · Groq
