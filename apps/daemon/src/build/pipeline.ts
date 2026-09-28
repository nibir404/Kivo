import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { specToYaml } from "@kivo/core/intent"
import { planFor } from "@kivo/core/plan"
import type { PlanStep, ServiceSpec } from "@kivo/core/types"
import { SECRET_ENV, stream } from "../ai/ai"
import { applyEdit } from "@kivo/ai/agent"
import { CODEGEN_SYSTEM, codegenUser, REPAIR_SYSTEM, repairUser } from "@kivo/ai/prompts"
import { bus } from "../events/bus"
import { PY_SCAFFOLD } from "@kivo/ai/scaffold"
import { contextFiles, openapiFor, parseEdits, parseFiles, type BuildEvent } from "@kivo/ai/codegen"
import { toolchainStatus } from "./toolchains"
import { git, isGitRepo, project, projectDir, VENV, WORKSPACES, writeFile } from "../projects/workspace"

/**
 * The build pipeline. AI steps write real files; deterministic steps run real tools.
 * A service is only reported as running when its tests pass and its process answers /health.
 */

const running = new Map<string, ChildProcess>()
const urls = new Map<string, string>()
/** Services with a build in progress — a second build of the same service is refused, not interleaved. */
const building = new Set<string>()

/** Builds of different services share one venv and one git index; these sections run one at a time. */
let exclusiveTail: Promise<unknown> = Promise.resolve()
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = exclusiveTail.then(fn, fn)
  exclusiveTail = run.catch(() => {})
  return run
}

/** Stop every service process Kivo started. Called on daemon shutdown so no orphans hold ports. */
export function stopAll() {
  for (const p of running.values()) if (p.exitCode === null) p.kill()
  running.clear()
}
process.on("exit", stopAll)

export const isBuilding = (id: string) => building.has(id)
export const anyBuilding = () => building.size > 0

/** Cap captured tool output so a chatty process can't exhaust memory. */
const MAX_OUTPUT = 1_000_000

/** Base URL of a service Kivo launched — the only targets the in-app API client may reach. */
export function serviceUrl(id: string) {
  const p = running.get(id)
  return p && p.exitCode === null ? urls.get(id) : undefined
}

export async function runBuild(spec: ServiceSpec, emit: (e: BuildEvent) => void, signal: AbortSignal) {
  if (building.has(spec.id)) {
    emit({ t: "error", message: `${spec.name} is already being built — wait for that build to finish.` })
    return
  }
  // Claim the slot before the first await, so two requests racing for the same service can't both start.
  building.add(spec.id)
  try {
    // Preflight: never spend AI calls on a build this machine can't finish.
    const toolchain = await toolchainStatus(spec.implementation.language, true)
    if (!toolchain.ok) {
      emit({ t: "error", message: toolchain.message ?? "This language can't be built here." })
      return
    }
    await build(spec, emit, signal)
  } finally {
    building.delete(spec.id)
  }
}

async function build(spec: ServiceSpec, emit: (e: BuildEvent) => void, signal: AbortSignal) {
  const steps = planFor(spec)
  const serviceRel = `services/${spec.id}`
  const PROJECT_DIR = projectDir()
  const serviceDir = path.join(PROJECT_DIR, serviceRel)
  const py = spec.implementation.language === "python"
  const written: Record<string, string> = {}
  let ok = true
  let blocked = false
  let testsFailed = false

  const save = (stepId: string, rel: string, content: string) => {
    const full = rel.startsWith(serviceRel + "/") ? rel : `${serviceRel}/${rel.replace(/^\.?\//, "")}`
    // Never write edit/conflict markers into source — that's a malformed model answer, not code.
    if (/^(<<<<<<< SEARCH|>>>>>>> REPLACE)\s*$/m.test(content)) {
      log(stepId, `! refused to write ${full.split("/").pop()}: it contained unapplied edit markers`)
      return false
    }
    writeFile(full, content)
    written[full.slice(serviceRel.length + 1)] = content
    emit({ t: "file", id: stepId, path: full })
    return true
  }
  const log = (id: string, text: string) => emit({ t: "log", id, text })

  running.get(spec.id)?.kill()
  fs.rmSync(serviceDir, { recursive: true, force: true })

  for (const step of steps) {
    if (signal.aborted) {
      running.get(spec.id)?.kill()
      return
    }
    if (blocked) {
      emit({ t: "step", id: step.id, status: "skipped", note: "Skipped — an earlier step failed." })
      continue
    }
    emit({ t: "step", id: step.id, status: "active" })
    try {
      const note = await runStep(step)
      emit({ t: "step", id: step.id, status: note?.startsWith("Skipped") ? "skipped" : "done", note })
    } catch (err) {
      ok = false
      const message = err instanceof Error ? err.message : String(err)
      log(step.id, `✗ ${message}`)
      emit({ t: "step", id: step.id, status: "failed", note: message })
      // Nothing downstream can run if the spec or installs fail. Failing tests still allow a boot for inspection.
      if (step.id === "understand" || step.id === "install") blocked = true
      if (step.id === "tests") testsFailed = true
    }
  }

  let commit: string | undefined
  await exclusive(async () => {
    // Kivo commits only in its own demo project; in the user's repo the changes are left for them to review.
    if (!project().managed || !isGitRepo()) return
    try {
      // Only this service's files — another build may be writing its own right now.
      await git(["add", "-A", "--", serviceRel])
      const staged = await git(["diff", "--cached", "--quiet"]).then(
        () => false,
        () => true,
      )
      if (staged) await git(["commit", "-q", "-m", `${ok ? "feat" : "wip"}(${spec.id}): ${spec.intent.slice(0, 72)}`])
      commit = (await git(["rev-parse", "--short", "HEAD"])).stdout.trim()
    } catch (err) {
      log("boot", `! couldn't record this build in git: ${(err as Error).message.split("\n")[0]}`)
    }
  })
  emit({ t: "done", ok, commit })

  async function runStep(step: PlanStep): Promise<string | undefined> {
    switch (step.id) {
      case "understand":
        save(step.id, "kivo.service.yaml", specToYaml(spec) + "\n")
        return "Service IR written."
      case "api":
        save(step.id, "openapi.yaml", openapiFor(spec))
        return `Contract derived from the IR: ${spec.api.endpoints.length} endpoints.`
      case "storage": {
        const compose = fs.existsSync(path.join(PROJECT_DIR, "docker-compose.yml")) ? fs.readFileSync(path.join(PROJECT_DIR, "docker-compose.yml"), "utf8") : ""
        const db = spec.storage.type.toLowerCase()
        log(step.id, compose.includes(db.slice(0, 6)) ? `✓ docker-compose.yml already declares ${spec.storage.type}` : `! ${spec.storage.type} not in docker-compose.yml — using SQLite for local runs`)
        save(step.id, ".env.example", `# Local runs default to SQLite. Point at ${spec.storage.type} for production:\nDATABASE_URL=postgresql://tandem:tandem@localhost/tandem\n${spec.cache ? "REDIS_URL=redis://localhost:6379/0\n" : ""}JWT_SECRET=change-me\n`)
        return "DATABASE_URL wired; SQLite by default so it runs without containers."
      }
      // Preflight guarantees a buildable toolchain; this guard keeps the pipeline honest if that ever changes.
      case "install":
        if (!py) throw new Error(`No install step for ${spec.implementation.language}`)
        return install(step.id)
      case "tests":
        await generate(step)
        if (!py) throw new Error(`No test runner for ${spec.implementation.language}`)
        return test(step.id)
      case "boot":
        if (!py) throw new Error(`No runtime for ${spec.implementation.language}`)
        return boot(step.id)
      default:
        if (step.executor === "ai") {
          await generate(step)
          return undefined
        }
        return undefined
    }
  }

  async function generate(step: PlanStep, prompt?: string, primaryOnly = false) {
    const scaffold = py ? PY_SCAFFOLD : {}
    const all = step.artifacts.map((a) => a.slice(serviceRel.length + 1))
    for (const rel of all) if (scaffold[rel]) save(step.id, rel, scaffold[rel])
    const rels = all.filter((r) => !scaffold[r])
    if (!prompt && !rels.length) return []
    const base = prompt ?? codegenUser(spec, step, rels, contextFiles(written))

    for (let attempt = 1; attempt <= 2; attempt++) {
      let finish = "stop"
      const content = await stream(
        [
          { role: "system", content: CODEGEN_SYSTEM },
          {
            role: "user",
            content: attempt === 1 ? base : `${base}\n\nIMPORTANT: your previous answer was cut off at the output limit. Be much more concise: no docstrings, no comments, minimal code that still meets every requirement.`,
          },
        ],
        (d) => emit({ t: "delta", id: step.id, channel: d.channel, text: d.text }),
        {
          effort: "low",
          maxTokens: 6000,
          signal,
          primaryOnly,
          onFinish: (r) => (finish = r),
          onRateLimit: ({ model, waitMs, next }) =>
            log(step.id, waitMs ? `⏳ Rate limit reached on ${model} — waiting ${Math.ceil(waitMs / 1000)}s, then retrying` : `↻ ${model} is rate-limited — switching to ${next}`),
        },
      )
      const files = parseFiles(content, finish === "length")
      if (files.length) {
        if (finish === "length") log(step.id, "! Output hit the token limit — kept only the complete files")
        // Scaffold files are Kivo's contract with the model; generated code can't overwrite them.
        for (const f of files) if (!scaffold[f.path]) save(step.id, f.path, f.content)
        return files
      }
      log(step.id, finish === "length" ? "! Output was cut off before any file completed — retrying with a more concise request" : "! The model returned no files — retrying")
    }
    throw new Error("The model returned no complete files after a retry.")
  }

  function autoImport(id: string, output: string) {
    const missing = new Map<string, Set<string>>()
    for (const m of output.matchAll(/^\.\/(.+?\.py):\d+:\d+:? undefined name '(\w+)'/gm)) {
      const [, file, name] = m
      if (STDLIB.has(name) || PACKAGE_FOR[name]) (missing.get(file) ?? missing.set(file, new Set()).get(file)!).add(name)
    }
    for (const [file, names] of missing) {
      const current = written[file]
      if (current === undefined) continue
      const lines = current.split("\n")
      // Insert after the last top-level import (or after a module docstring / at the top).
      let at = 0
      for (let i = 0; i < lines.length; i++) {
        if (!/^(import |from \S+ import )/.test(lines[i])) continue
        let end = i
        if (lines[i].includes("(") && !lines[i].includes(")")) while (end < lines.length - 1 && !lines[end].includes(")")) end++
        at = end + 1
        i = end
      }
      lines.splice(at, 0, ...[...names].map((n) => `import ${n}`))
      save(id, file, lines.join("\n"))
      log(id, `⚙ autofix: added ${[...names].map((n) => `import ${n}`).join(", ")} to ${file}`)
    }
    return missing.size > 0
  }

  /** Repairs use targeted SEARCH/REPLACE edits so they fit the token budget and never clobber working files. */
  async function repair(id: string, failure: string) {
    let finish = "stop"
    const content = await stream(
      [
        { role: "system", content: REPAIR_SYSTEM },
        { role: "user", content: repairUser(spec, failure, contextFiles(written, failure, true)) },
      ],
      (d) => emit({ t: "delta", id, channel: d.channel, text: d.text }),
      {
        effort: "medium",
        maxTokens: 3000,
        signal,
        primaryOnly: true,
        onFinish: (r) => (finish = r),
        onRateLimit: ({ waitMs }) => log(id, `⏳ Rate limit — waiting ${Math.ceil(waitMs / 1000)}s for the primary model`),
      },
    )
    let applied = 0
    const edits = parseEdits(content)
    const fileBlocks = parseFiles(content, finish === "length")
    for (const f of fileBlocks) {
      if (/^<<<<<<< SEARCH\s*$/m.test(f.content)) edits.push(...parseEdits(`=== EDIT: ${f.path} ===\n${f.content}`))
    }
    for (const e of edits) {
      const current = written[e.path]
      if (current === undefined) {
        log(id, `! edit skipped — ${e.path} does not exist`)
        continue
      }
      const next = applyEdit(current, e.search, e.replace)
      if (next === null) {
        log(id, `! edit skipped — SEARCH text not found in ${e.path}`)
        continue
      }
      save(id, e.path, next)
      log(id, `✎ ${e.path}: replaced ${e.search.split("\n").length} line(s)`)
      applied++
    }
    for (const f of fileBlocks) {
      if (/^<<<<<<< SEARCH\s*$/m.test(f.content)) continue
      if (save(id, f.path, f.content)) applied++
    }
    if (!applied) log(id, "! repair produced no applicable changes")
  }

  async function install(id: string) {
    const { packages: reqs, unknown } = deriveRequirements(written, serviceDir)
    if (unknown.length) {
      unknown.forEach((m) => log(id, `✗ import ${m}: not a package Kivo knows`))
      throw new Error(
        `The generated code imports ${unknown.map((m) => `"${m}"`).join(", ")}, which ${unknown.length === 1 ? "isn't a package" : "aren't packages"} Kivo installs automatically. ` +
          `Installing unknown names from PyPI could run a look-alike package. If you trust ${unknown.length === 1 ? "it" : "them"}, add ${unknown.length === 1 ? "it" : "them"} to KIVO_EXTRA_PACKAGES in .env and rebuild.`,
      )
    }
    save(id, "requirements.txt", reqs.join("\n") + "\n")
    save(id, "pytest.ini", "[pytest]\npythonpath = .\ntestpaths = tests\n")
    const r = await exclusive(async () => {
      if (!fs.existsSync(path.join(VENV, "bin", "python"))) {
        const v = await sh(id, "python3", ["-m", "venv", VENV], PROJECT_DIR)
        if (v.code !== 0) throw new Error("Couldn't create the Python virtual environment")
        await sh(id, path.join(VENV, "bin", "pip"), ["install", "-q", "--disable-pip-version-check", "-U", "pip", "pyflakes"], PROJECT_DIR)
      }
      if (!fs.existsSync(path.join(VENV, "bin", "pyflakes"))) await sh(id, path.join(VENV, "bin", "pip"), ["install", "-q", "--disable-pip-version-check", "pyflakes"], PROJECT_DIR)
      return sh(id, path.join(VENV, "bin", "pip"), ["install", "--disable-pip-version-check", "--progress-bar", "off", "-r", "requirements.txt"], serviceDir)
    })
    if (r.code !== 0) throw new Error("pip install failed")
    return `${reqs.length} packages installed from imports found in the generated code.`
  }

  async function lint(id: string) {
    let r = await sh(id, path.join(VENV, "bin", "python"), ["-m", "pyflakes", "."], serviceDir, 60_000, true)
    // Deterministic autofix: a missing import of a known module never needs a model call.
    if (autoImport(id, r.output)) r = await sh(id, path.join(VENV, "bin", "python"), ["-m", "pyflakes", "."], serviceDir, 60_000, true)
    const errors = r.output.split("\n").filter((l) => /undefined name|invalid syntax|SyntaxError|unexpected indent|could not compile|is not defined/.test(l))
    errors.forEach((e) => log(id, e))
    log(id, errors.length ? `✗ lint: ${errors.length} error(s)` : "✓ lint clean (pyflakes)")
    return errors.join("\n")
  }

  async function test(id: string) {
    const runTests = () => sh(id, path.join(VENV, "bin", "python"), ["-m", "pytest", "-q", "-rA", "--tb=short", "--no-header", "--color=no", "-p", "no:cacheprovider", "-W", "ignore::DeprecationWarning"], serviceDir, 180_000)
    let lintErrors = await lint(id)
    let r = await runTests()
    for (let attempt = 1; attempt <= 3 && (r.code !== 0 || lintErrors); attempt++) {
      log(id, `✦ Validation failed — sending the exact errors to the Implementation Agent (repair ${attempt}/3)…`)
      const failure = [lintErrors && `pyflakes:\n${lintErrors}`, r.code !== 0 && `pytest:\n${compactFailure(r.output)}`].filter(Boolean).join("\n\n")
      try {
        await repair(id, failure)
      } catch (err) {
        // A repair that can't run (e.g. rate limit) ends the loop; we still report the real test results.
        log(id, `✗ repair stopped: ${(err as Error).message}`)
        break
      }
      lintErrors = await lint(id)
      r = await runTests()
    }
    const results = parseTests(r.output)
    emit({ t: "tests", results })
    const passed = results.filter((x) => x.status === "pass").length
    if (r.code !== 0 && !results.length) {
      const cause = r.output.split("\n").find((l) => /Error|error:/.test(l) && !/warn/i.test(l))?.replace(/^E\s+/, "").trim()
      throw new Error(`The test suite couldn't load after 3 repair attempts${cause ? ` — ${cause}` : ""}`)
    }
    if (r.code !== 0) throw new Error(`${passed} of ${results.length} tests passing — ${results.length - passed} still failing after repairs`)
    return `${passed}/${results.length} tests passed.`
  }

  async function boot(id: string) {
    const port = await freePort()
    log(id, `$ uvicorn main:app --port ${port}`)
    const proc = spawn(path.join(VENV, "bin", "python"), ["-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", String(port)], {
      cwd: serviceDir,
      env: sandboxEnv(),
    })
    let spawnError: Error | undefined
    proc.on("error", (err) => (spawnError = err))
    running.set(spec.id, proc)
    urls.set(spec.id, `http://127.0.0.1:${port}`)
    // Chunks don't end on line boundaries; carry the partial line over so tracebacks stay whole.
    const lineForwarder = () => {
      let rest = ""
      return (b: Buffer) => {
        const lines = (rest + b.toString()).split("\n")
        rest = lines.pop()!.slice(-8192)
        for (const line of lines) if (line) bus.emit("event", { t: "service-log", service: spec.id, line })
      }
    }
    proc.stdout.on("data", lineForwarder())
    proc.stderr.on("data", lineForwarder())
    const url = `http://127.0.0.1:${port}`
    for (let i = 0; i < 60; i++) {
      if (spawnError) throw new Error(`Couldn't start the service: ${spawnError.message}`)
      if (proc.exitCode !== null) throw new Error("Service process exited during startup — see Logs")
      if (signal.aborted) {
        proc.kill()
        throw new Error("Build cancelled")
      }
      try {
        const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) })
        if (res.ok) {
          const openapi = (await fetch(`${url}/openapi.json`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json()).catch(() => ({ paths: {} }))) as { paths?: Record<string, object> }
          const routes = Object.entries(openapi.paths ?? {}).flatMap(([p, ms]) => Object.keys(ms as object).map((m) => `${m.toUpperCase()} ${p}`))
          log(id, `✓ healthy at ${url} — ${routes.length} routes live`)
          emit({ t: "url", url, routes })
          return testsFailed
            ? `Booted at ${url} for inspection only — tests are failing, so it is not marked ready.`
            : `Running at ${url}. Try it from the Terminal: curl ${url}/health`
        }
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 300))
    }
    proc.kill()
    throw new Error("Service did not answer /health within 18s")
  }

  function sh(id: string, cmd: string, args: string[], cwd: string, timeout = 300_000, quiet = false) {
    const shown = (a: string) => a.replace(PROJECT_DIR, ".").replace(WORKSPACES, "~kivo")
    log(id, `$ ${path.basename(cmd)} ${args.map((a) => (a.includes(" ") ? `"${shown(a)}"` : shown(a))).join(" ")}`)
    return new Promise<{ code: number; output: string }>((resolve) => {
      const p = spawn(cmd, args, { cwd, env: sandboxEnv() })
      let output = ""
      const timer = setTimeout(() => p.kill(), timeout)
      const onData = (b: Buffer) => {
        const s = stripAnsi(b.toString())
        output = (output + s).slice(-MAX_OUTPUT)
        if (!quiet) s.split("\n").filter((l) => l.trim()).forEach((l) => log(id, l))
      }
      p.stdout.on("data", onData)
      p.stderr.on("data", onData)
      const abort = () => p.kill()
      if (signal.aborted) abort()
      else signal.addEventListener("abort", abort, { once: true })
      let settled = false
      const finish = (code: number, extra = "") => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener("abort", abort)
        resolve({ code, output: output + extra })
      }
      // A missing executable emits "error" (not "close") — without this handler it would crash the daemon.
      p.on("error", (err) => {
        log(id, `✗ couldn't run ${path.basename(cmd)}: ${err.message}`)
        finish(127, `\n${err.message}`)
      })
      p.on("close", (code) => finish(code ?? 1))
    })
  }
}

/**
 * Environment for AI-written code and the packages it installs: an allowlist, so tokens the user
 * has exported (AWS_*, GITHUB_TOKEN, SSH_AUTH_SOCK…) never reach code nobody has reviewed yet.
 */
const SANDBOX_ENV = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_\w+|TZ|TMPDIR|TEMP|TMP|SYSTEMROOT|COMSPEC|PATHEXT|VIRTUAL_ENV|PYTHON\w*|PIP_\w+|UV_\w+|SSL_CERT_\w+|REQUESTS_CA_BUNDLE|HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy|__CF_USER_TEXT_ENCODING)$/
export function sandboxEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (SANDBOX_ENV.test(k)) env[k] = v
  for (const k of SECRET_ENV) delete env[k]
  return { ...env, PYTHONDONTWRITEBYTECODE: "1", PYTHONUNBUFFERED: "1", NO_COLOR: "1" }
}

/** Environment for the user's own terminal: theirs, minus Kivo's provider keys and npm's leaked config. */
export function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONUNBUFFERED: "1", NO_COLOR: "1" }
  delete env.FORCE_COLOR
  for (const k of SECRET_ENV) delete env[k]
  // npm leaks its own config into child processes (breaks nvm and friends in the user's shell).
  for (const k of Object.keys(env)) if (k.startsWith("npm_")) delete env[k]
  delete env.REDIS_URL
  delete env.DATABASE_URL
  return env
}


function parseTests(output: string) {
  const results: { name: string; status: "pass" | "fail" }[] = []
  for (const m of output.matchAll(/^(PASSED|FAILED|ERROR) (\S+?)(?:::(\S+))?(?: - .*)?$/gm)) {
    results.push({ name: m[3] ?? m[2], status: m[1] === "PASSED" ? "pass" : "fail" })
  }
  return results
}

const PACKAGE_FOR: Record<string, string> = {
  fastapi: "fastapi",
  uvicorn: "uvicorn",
  sqlalchemy: "sqlalchemy>=2",
  pydantic: "pydantic>=2",
  jwt: "PyJWT",
  bcrypt: "bcrypt",
  redis: "redis",
  httpx: "httpx",
  pytest: "pytest",
  email_validator: "email-validator",
  passlib: "passlib[bcrypt]",
  itsdangerous: "itsdangerous",
  stripe: "stripe",
  dotenv: "python-dotenv",
  multipart: "python-multipart",
  aiosqlite: "aiosqlite",
  psycopg2: "psycopg2-binary",
  asyncpg: "asyncpg",
  fakeredis: "fakeredis",
  pydantic_settings: "pydantic-settings",
  starlette: "starlette",
  jose: "python-jose[cryptography]",
  cryptography: "cryptography",
  argon2: "argon2-cffi",
  requests: "requests",
  yaml: "PyYAML",
  dateutil: "python-dateutil",
  pytest_asyncio: "pytest-asyncio",
  anyio: "anyio",
  sqlmodel: "sqlmodel",
  alembic: "alembic",
  pyotp: "pyotp",
  slugify: "python-slugify",
}

/** Packages the user has vetted themselves (KIVO_EXTRA_PACKAGES=name,name==1.2). Keys are import names. */
function extraPackages(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const spec of (process.env.KIVO_EXTRA_PACKAGES ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const name = spec.split(/[=<>!~\[;\s]/)[0]
    if (/^[A-Za-z0-9][\w.-]*$/.test(name)) out[name.replace(/-/g, "_").toLowerCase()] = spec
  }
  return out
}


/** Deterministic: requirements come from what the code imports, never from model output. */
export function deriveRequirements(files: Record<string, string>, serviceDir: string) {
  const local = new Set(Object.keys(files).map((f) => path.basename(f, ".py")))
  for (const f of fs.existsSync(serviceDir) ? fs.readdirSync(serviceDir) : []) local.add(path.basename(f, ".py"))
  const pkgs = new Set(["fastapi", "uvicorn", "httpx", "pytest"])
  const unknown = new Set<string>()
  const known = { ...PACKAGE_FOR, ...extraPackages() }
  const code = Object.values(files).join("\n")
  for (const m of code.matchAll(/^\s*(?:from|import)\s+([A-Za-z_]\w*)/gm)) {
    const mod = m[1]
    if (STDLIB.has(mod) || local.has(mod) || mod === "tests" || mod === "conftest") continue
    // Only names Kivo (or the user) vouches for are installed — a hallucinated import is never fetched from PyPI.
    const pkg = known[mod] ?? known[mod.toLowerCase()]
    if (pkg) pkgs.add(pkg)
    else unknown.add(mod)
  }
  if (/EmailStr/.test(code)) pkgs.add("email-validator")
  if (/\bForm\(|UploadFile/.test(code)) pkgs.add("python-multipart")
  return { packages: [...pkgs].sort(), unknown: [...unknown].sort() }
}

function freePort() {
  return new Promise<number>((resolve) => {
    const s = net.createServer()
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port
      s.close(() => resolve(port))
    })
  })
}

/** Python 3.9 standard library (sys.stdlib_module_names only exists from 3.10). */
const STDLIB = new Set(
  "__future__ abc argparse array ast asyncio base64 binascii bisect builtins calendar cmath collections concurrent contextlib contextvars copy csv ctypes dataclasses datetime decimal difflib email enum errno fnmatch fractions functools gc getpass glob gzip hashlib heapq hmac html http importlib inspect io ipaddress itertools json logging math mimetypes multiprocessing numbers operator os pathlib pickle platform pprint queue random re secrets select shlex shutil signal smtplib socket sqlite3 ssl stat statistics string struct subprocess sys tempfile textwrap threading time timeit traceback types typing unicodedata unittest urllib uuid warnings weakref xml zipfile zlib zoneinfo".split(" "),
)





const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")

/** Keep the parts of pytest output a repair actually needs: failure tracebacks and the summary — no warnings. */
function compactFailure(output: string) {
  const start = output.search(/=+ (FAILURES|ERRORS) =+/)
  let body = start >= 0 ? output.slice(start) : output
  body = body.replace(/=+ warnings summary =+[\s\S]*?(?=\n=+ |$)/g, "").replace(/=+ PASSES =+[\s\S]*?(?=\n=+ short test summary|$)/g, "")
  return body
    .split("\n")
    .filter((l) => l.trim() && !/^PASSED |site-packages.*Warning|^\s+warnings\.warn/.test(l))
    .join("\n")
    .slice(-3500)
}


export { applyEdit, parseEdits, parseFiles, type BuildEvent }
