---
name: codebase-memory
description: Maintains, updates, and synchronizes persistent codebase memory and context before every git push or significant commit. Use whenever preparing to push code, committing architectural or full-stack changes, checking repository context before push, or when the user asks to update project memory.
---

# Codebase Memory & Context Synchronization Skill

This skill enforces a persistent, evergreen repository memory that evolves in tandem with the codebase. It ensures that critical context—architectural decisions, security boundaries, runtime topologies, active toolchains, and operational gotchas—is captured before code is committed and pushed to remote repositories.

---

## 1. When to Use This Skill

Activate this skill when:
- Preparing to execute `git push` or creating a commit that will be pushed.
- The user requests to "update memory", "sync memory before push", or "prepare push".
- Significant architectural, toolchain, or security features have been introduced or refactored.
- Onboarding into the codebase to review active systems and design decisions.

---

## 2. The 5-Step Pre-Push Memory Workflow

Whenever preparing changes for push, execute these five steps in sequence:

```
[1] Inspect Diffs ──▶ [2] Extract Context ──▶ [3] Update MEMORY.md ──▶ [4] Run Tests ──▶ [5] Stage & Push
```

### Step 1: Inspect Diffs & Git Working Tree
Inspect the working tree to understand all touched components:
```bash
git status --short
git diff --stat
git diff HEAD~1..HEAD --stat # if already committed locally
```
Identify which areas were affected:
- Core server/daemon logic (`server/`)
- UI shell & components (`src/`)
- Toolchains, pipelines, or sandbox guards
- Configuration (`package.json`, `.env.example`, `tsconfig`)
- Test suites (`tests/`)

### Step 2: Extract Architectural & Semantic Context
Synthesize the changes across five primary dimensions:
1. **Architecture & Subsystems**: Were new subsystems added (e.g. SCM, coding agent, terminal multiplexer)?
2. **APIs & Contracts**: Were endpoints, WebSocket routes, or schemas added/modified?
3. **Security & Sandboxing**: Were new security guards, path checks, or origin policies introduced?
4. **Key Decisions & Rationale**: Why was an approach chosen over alternatives?
5. **Gotchas & Limitations**: Did we discover new rate limits, platform quirks, or prerequisites?

### Step 3: Synchronize `docs/MEMORY.md`
Update the repository memory document: [docs/MEMORY.md](file:///Users/betopiagroup/Downloads/Translator/kivo/docs/MEMORY.md).

Ensure the following sections are updated:
- **Last Updated Date**: Set to current date.
- **Process Topology / Ports**: Verify daemon and UI ports match reality.
- **Core Subsystems**: Add descriptions of new modules and their responsibilities.
- **Security & Safety Invariants**: Document newly established boundaries.
- **Changelog / Recent Evolution**: Add a concise entry summarizing the changes being pushed.
- **Verification Checklist**: Confirm pre-push requirements are met.

### Step 4: Run Integrity & Verification Checks
Never push code without running the test suite:
```bash
npm run check || npm test
```
Confirm:
- All unit and integration tests pass (100% green).
- Type checking passes without errors.
- Linter reports zero errors.

### Step 5: Stage Memory and Commit
Stage `docs/MEMORY.md` together with the codebase changes:
```bash
git add docs/MEMORY.md
git status
```
Include memory updates in the commit message or as part of the feature commit, ensuring history and memory move together.

---

## 3. Standard Memory Schema (`docs/MEMORY.md`)

Maintain the following structure in `docs/MEMORY.md`:

```markdown
# [Project Name] — Persistent Codebase Memory

> **Last Updated**: YYYY-MM-DD
> **Status**: Active & Evergreen

## 1. Project Identity & Philosophy
- Mission, core user promise, and architectural principles.

## 2. Process Topology & Runtime Ports
- Table of running services, ports, protocols, and purposes.

## 3. Core Subsystems & Architecture
- Subsystem breakdown: responsibility, files, and interactions.

## 4. Security & Safety Invariants
- Non-negotiable security boundaries (origin checks, sandboxes, env stripping).

## 5. AI Providers & Model Topology
- Active providers, model fallbacks, rate limit policies.

## 6. Verification & Test Suite
- Test commands, test count, suite structure.

## 7. Evolution & Decision Log
- Reverse chronological record of architectural changes and rationale.
```

---

## 4. Automated Pre-Push Script

A helper script is provided at [scripts/sync-memory.sh](file:///Users/betopiagroup/Downloads/Translator/kivo/scripts/sync-memory.sh). Run it anytime to quickly inspect repository status and verify test health before pushing:

```bash
./scripts/sync-memory.sh
```

---

## 5. Golden Rules for Memory Maintenance

1. **Memory Travels With Code**: Never leave memory in external scratchpads. Keep it in `docs/MEMORY.md` inside version control.
2. **Zero Hallucination / Radical Honesty**: Only document what actually exists and works in the code. Never document aspirational features as complete.
3. **Keep It Concise**: Write high-density summaries. Avoid redundant verbosity; focus on architecture, contracts, and gotchas.
4. **Always Update Before Push**: If code changed, memory must be reviewed. No stale memory allowed.
