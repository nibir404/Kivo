import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { specToYaml } from "../src/core/intent"
import { planFor } from "../src/core/plan"
import type { PlanStep, ServiceSpec } from "../src/core/types"
import { SECRET_ENV, stream } from "./ai"
import { CODEGEN_SYSTEM, codegenUser, REPAIR_SYSTEM, repairUser } from "./prompts"
import { bus } from "./bus"
import { PY_SCAFFOLD } from "./scaffold"
import { git, PROJECT_DIR, VENV, writeFile } from "./workspace"

/**
 * The build pipeline. AI steps write real files; deterministic steps run real tools.
 * A service is only reported as running when its tests pass and its process answers /health.
 */

export type BuildEvent =
  | { t: "step"; id: string; status: "active" | "done" | "failed" | "skipped"; note?: string }
  | { t: "delta"; id: string; channel: "reasoning" | "content"; text: string }
  | { t: "log"; id: string; text: string }
  | { t: "file"; id: string; path: string }
  | { t: "tests"; results: { name: string; status: "pass" | "fail" }[] }
  | { t: "url"; url: string; routes: string[] }
  | { t: "done"; ok: boolean; commit?: string }
  | { t: "error"; message: string }

const running = new Map<string, ChildProcess>()
const urls = new Map<string, string>()
process.on("exit", () => running.forEach((p) => p.kill()))

/** Base URL of a service Kivo launched — the only targets the in-app API client may reach. */
export function serviceUrl(id: string) {
  const p = running.get(id)
  return p && p.exitCode === null ? urls.get(id) : undefined
}

export async function runBuild(spec: ServiceSpec, emit: (e: BuildEvent) => void, signal: AbortSignal) {
  const steps = planFor(spec)
  const serviceRel = `services/${spec.id}`
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
    if (signal.aborted) return
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
  try {
    await git(["add", "-A"])
    await git(["commit", "-q", "-m", `${ok ? "feat" : "wip"}(${spec.id}): ${spec.intent.slice(0, 72)}`])
    commit = (await git(["rev-parse", "--short", "HEAD"])).stdout.trim()
  } catch {
    // nothing to commit
  }
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
      case "install":
        if (!py) return `Skipped — dependency installation for ${spec.implementation.language} is not in the MVP yet.`
        return install(step.id)
      case "tests":
        await generate(step)
        if (!py) return `Skipped — running ${spec.implementation.language} tests is not in the MVP yet.`
        return test(step.id)
      case "boot":
        if (!py) return `Skipped — booting ${spec.implementation.language} services is not in the MVP yet.`
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
    const reqs = deriveRequirements(written, serviceDir)
    save(id, "requirements.txt", reqs.join("\n") + "\n")
    save(id, "pytest.ini", "[pytest]\npythonpath = .\ntestpaths = tests\n")
    if (!fs.existsSync(path.join(VENV, "bin", "python"))) {
      await sh(id, "python3", ["-m", "venv", VENV], PROJECT_DIR)
      await sh(id, path.join(VENV, "bin", "pip"), ["install", "-q", "--disable-pip-version-check", "-U", "pip", "pyflakes"], PROJECT_DIR)
    }
    if (!fs.existsSync(path.join(VENV, "bin", "pyflakes"))) await sh(id, path.join(VENV, "bin", "pip"), ["install", "-q", "--disable-pip-version-check", "pyflakes"], PROJECT_DIR)
    const r = await sh(id, path.join(VENV, "bin", "pip"), ["install", "--disable-pip-version-check", "--progress-bar", "off", "-r", "requirements.txt"], serviceDir)
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
      env: cleanEnv(),
    })
    running.set(spec.id, proc)
    urls.set(spec.id, `http://127.0.0.1:${port}`)
    const forward = (b: Buffer) =>
      b
        .toString()
        .split("\n")
        .filter(Boolean)
        .forEach((line) => bus.emit("event", { t: "service-log", service: spec.id, line }))
    proc.stdout.on("data", forward)
    proc.stderr.on("data", forward)
    const url = `http://127.0.0.1:${port}`
    for (let i = 0; i < 60; i++) {
      if (proc.exitCode !== null) throw new Error("Service process exited during startup — see Logs")
      try {
        const res = await fetch(`${url}/health`)
        if (res.ok) {
          const openapi = (await fetch(`${url}/openapi.json`).then((r) => r.json()).catch(() => ({ paths: {} }))) as { paths?: Record<string, object> }
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
    log(id, `$ ${path.basename(cmd)} ${args.map((a) => (a.includes(" ") ? `"${a}"` : a.replace(PROJECT_DIR, "."))).join(" ")}`)
    return new Promise<{ code: number; output: string }>((resolve) => {
      const p = spawn(cmd, args, { cwd, env: cleanEnv() })
      let output = ""
      const timer = setTimeout(() => p.kill(), timeout)
      const onData = (b: Buffer) => {
        const s = stripAnsi(b.toString())
        output += s
        if (!quiet) s.split("\n").filter((l) => l.trim()).forEach((l) => log(id, l))
      }
      p.stdout.on("data", onData)
      p.stderr.on("data", onData)
      signal.addEventListener("abort", () => p.kill(), { once: true })
      p.on("close", (code) => {
        clearTimeout(timer)
        resolve({ code: code ?? 1, output })
      })
    })
  }
}

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

/**
 * Split model output on "=== FILE: path ===" headers. END markers are optional (models drop them);
 * if the response was truncated, the last block is incomplete and is discarded.
 */
export function parseFiles(text: string, truncated = false) {
  const headers = [...text.matchAll(/^=== FILE: (.+?) ===\s*$/gm)]
  const out: { path: string; content: string }[] = []
  headers.forEach((h, i) => {
    const start = h.index! + h[0].length
    const end = i + 1 < headers.length ? headers[i + 1].index! : text.length
    const raw = text.slice(start, end)
    const hasEnd = /^=== END FILE ===\s*$/m.test(raw)
    if (truncated && i === headers.length - 1 && !hasEnd) return
    let content = raw
      .replace(/^=== END FILE ===[\s\S]*$/m, "")
      .replace(/^\r?\n/, "")
      .replace(/^```[\w-]*\n/, "")
      .replace(/\n```\s*$/, "")
      .trimEnd()
    content += "\n"
    const p = h[1].trim().replace(/^`|`$/g, "")
    if (!p.includes("..") && content.trim()) out.push({ path: p, content })
  })
  return out
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
}


/** Deterministic: requirements come from what the code imports, never from model output. */
function deriveRequirements(files: Record<string, string>, serviceDir: string) {
  const local = new Set(Object.keys(files).map((f) => path.basename(f, ".py")))
  for (const f of fs.existsSync(serviceDir) ? fs.readdirSync(serviceDir) : []) local.add(path.basename(f, ".py"))
  const pkgs = new Set(["fastapi", "uvicorn", "httpx", "pytest"])
  const code = Object.values(files).join("\n")
  for (const m of code.matchAll(/^\s*(?:from|import)\s+([A-Za-z_]\w*)/gm)) {
    const mod = m[1]
    if (STDLIB.has(mod) || local.has(mod) || mod === "tests" || mod === "conftest") continue
    pkgs.add(PACKAGE_FOR[mod] ?? mod)
  }
  if (/EmailStr/.test(code)) pkgs.add("email-validator")
  if (/\bForm\(|UploadFile/.test(code)) pkgs.add("python-multipart")
  return [...pkgs].sort()
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

const CORE_FILES = /^(db|models|main|router|schemas)\.py$/

/**
 * Keep prompts inside the free-tier token budget: core modules in full, everything else
 * reduced to its public surface (imports, signatures, top-level names).
 */
function contextFiles(files: Record<string, string>, failure = "", repairing = false) {
  const out: Record<string, string> = {}
  const code = Object.entries(files).filter(([p]) => p.endsWith(".py"))
  if (!repairing) {
    for (const [p, c] of code) out[p] = CORE_FILES.test(p) || failure.includes(path.basename(p)) ? c : surface(c)
    return out
  }
  // Repairs can only edit what they can see verbatim: fill a character budget with full files by priority.
  const rank = ([p]: [string, string]) =>
    (failure.includes(path.basename(p)) ? 0 : 10) + (p.startsWith("tests/conftest") ? 1 : p.startsWith("tests/") ? 2 : /^(router|db)\.py$/.test(p) ? 3 : /^models\.py$/.test(p) ? 4 : 6)
  let budget = 14_000
  for (const [p, c] of [...code].sort((a, b) => rank(a) - rank(b))) {
    if (c.length <= budget) {
      out[p] = c
      budget -= c.length
    } else out[`${p} (SIGNATURES ONLY — do not edit)`] = surface(c)
  }
  return out
}

function surface(code: string) {
  return code
    .split("\n")
    .filter((l) => /^(from |import |class |def |async def |@|[A-Z_][A-Z0-9_]* ?=|    def |    async def )/.test(l))
    .join("\n")
}

function openapiFor(spec: ServiceSpec) {
  const lines = ["openapi: 3.1.0", "info:", `  title: ${spec.name}`, "  version: 0.1.0", `  description: "${spec.purpose.replace(/"/g, "'")}"`, "paths:"]
  const byPath = new Map<string, typeof spec.api.endpoints>()
  for (const e of spec.api.endpoints) byPath.set(e.path, [...(byPath.get(e.path) ?? []), e])
  for (const [p, eps] of byPath) {
    lines.push(`  ${p}:`)
    for (const e of eps) {
      lines.push(`    ${e.method.toLowerCase()}:`, `      summary: "${e.summary.replace(/"/g, "'")}"`, `      x-kivo-requirement: ${e.requirement}`)
      if (e.auth) lines.push("      security: [{ bearer: [] }]")
      lines.push("      responses:", '        "200": { description: OK }')
    }
  }
  lines.push("components:", "  securitySchemes:", "    bearer: { type: http, scheme: bearer, bearerFormat: JWT }")
  return lines.join("\n") + "\n"
}

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

export function parseEdits(text: string) {
  const out: { path: string; search: string; replace: string }[] = []
  const blocks = text.split(/^=== EDIT: (.+?) ===\s*$/m)
  for (let i = 1; i < blocks.length; i += 2) {
    const p = blocks[i].trim()
    for (const m of blocks[i + 1].matchAll(/<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n?>>>>>>> REPLACE/g)) {
      out.push({ path: p, search: m[1], replace: m[2] })
    }
  }
  return out
}

/** Exact match first, then a whitespace-tolerant line match (models often drift on indentation of blank lines). */
export function applyEdit(content: string, search: string, replace: string): string | null {
  if (content.includes(search)) return content.replace(search, replace)
  const norm = (l: string) => l.trimEnd()
  const lines = content.split("\n")
  const target = search.split("\n").map(norm)
  while (target.length && !target[target.length - 1]) target.pop()
  for (let i = 0; i + target.length <= lines.length; i++) {
    if (target.every((t, j) => norm(lines[i + j]) === t)) {
      return [...lines.slice(0, i), ...replace.split("\n"), ...lines.slice(i + target.length)].join("\n")
    }
  }
  return null
}
