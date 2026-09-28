import assert from "node:assert/strict"
import type http from "node:http"
import { Readable } from "node:stream"
import { describe, test } from "node:test"
import { parseIntent } from "@kivo/core/intent"
import type { ServiceSpec, StackChoice } from "@kivo/core/types"
import { HttpError, readJson } from "../src/http/http"
import { applyEdit, deriveRequirements, parseEdits, parseFiles, runBuild, sandboxEnv, type BuildEvent } from "../src/build/pipeline"
import { normalizeSpec, projectContext, resolveStack, sanitizeStack, validateBuildSpec } from "@kivo/ai/spec"
import { toolchainStatus } from "../src/build/toolchains"
import { hostOk, originOk } from "../src/http/web"

const PY: StackChoice = { language: "python", framework: "fastapi", database: "PostgreSQL", cache: "Redis" }
const req = (body: string) => Readable.from([Buffer.from(body)]) as unknown as http.IncomingMessage

describe("request bodies", () => {
  test("malformed JSON is a 400, not a crash", async () => {
    await assert.rejects(readJson(req("{nope")), (e: unknown) => e instanceof HttpError && e.status === 400)
  })
  test("arrays are rejected", async () => {
    await assert.rejects(readJson(req("[1,2]")), (e: unknown) => e instanceof HttpError && e.status === 400)
  })
  test("oversized bodies are a 413", async () => {
    await assert.rejects(readJson(req(`{"x":"${"a".repeat(6 * 1024 * 1024)}"}`)), (e: unknown) => e instanceof HttpError && e.status === 413)
  })
  test("empty body is an empty object", async () => {
    assert.deepEqual(await readJson(req("")), {})
  })
})

describe("stack resolution", () => {
  test("unknown languages fall back to Python", () => {
    assert.equal(sanitizeStack({ language: "cobol", framework: "x" }).language, "python")
  })
  test("framework must belong to the language", () => {
    assert.equal(sanitizeStack({ language: "java", framework: "fastapi" }).framework, "spring")
  })
  test("a language in the request overrides the picker", () => {
    assert.equal(resolveStack("notifications using Java", PY).language, "java")
    assert.equal(resolveStack("notifications", PY).language, "python")
  })
})

describe("normalizeSpec — model output is untrusted", () => {
  test("the model cannot change the language", () => {
    const spec = normalizeSpec({ name: "Notifications", implementation: { language: "python" } }, "notifications using Java", { ...PY, language: "java", framework: "spring" })
    assert.equal(spec.implementation.language, "java")
  })
  test("invalid endpoints are dropped", () => {
    const spec = normalizeSpec({ name: "X", endpoints: [{ method: "HACK", path: "/a" }, { method: "get", path: "no-slash" }, { method: "post", path: "/ok", requirement: "core" }] }, "x", PY)
    assert.deepEqual(
      spec.api.endpoints.map((e) => `${e.method} ${e.path}`),
      ["POST /ok"],
    )
  })
  test("ids are safe slugs", () => {
    assert.match(normalizeSpec({ name: "../../Evil Service!" }, "x", PY).id, /^[a-z0-9-]+$/)
  })
})

describe("validateBuildSpec — nothing escapes services/<id>", () => {
  const good = parseIntent("Create a notification system", PY)
  test("accepts a real spec", () => {
    assert.equal(validateBuildSpec(good).id, "notifications")
  })
  for (const id of ["../backend", "a/b", "", "UPPER", ".hidden", "x".repeat(80)]) {
    test(`rejects id ${JSON.stringify(id).slice(0, 20)}`, () => {
      assert.throws(() => validateBuildSpec({ ...good, id }), (e: unknown) => e instanceof HttpError && e.status === 400)
    })
  }
  test("rejects specs without requirements", () => {
    assert.throws(() => validateBuildSpec({ ...good, requirements: [] }))
  })
  test("keeps 'no cache' as no cache", () => {
    assert.equal(validateBuildSpec({ ...good, implementation: { ...PY, cache: undefined } }).implementation.cache, undefined)
  })
})

describe("projectContext", () => {
  test("lists the real services, not hard-coded ones", () => {
    const text = projectContext({ detections: [], languages: [], recommended: [], summary: "" }, [{ id: "billing", name: "Billing", language: "Java", framework: "Spring Boot", endpoints: ["GET /bills"] }])
    assert.match(text, /Billing \(id: billing, Java · Spring Boot\)/)
    assert.doesNotMatch(text, /User Management/)
  })
})

describe("model output parsing", () => {
  test("parseFiles drops a truncated last file", () => {
    const out = parseFiles("=== FILE: a.py ===\nx = 1\n=== END FILE ===\n=== FILE: b.py ===\ny =", true)
    assert.deepEqual(
      out.map((f) => f.path),
      ["a.py"],
    )
  })
  test("parseFiles refuses path traversal", () => {
    assert.equal(parseFiles("=== FILE: ../../etc/x ===\nboom\n=== END FILE ===").length, 0)
  })
  test("SEARCH/REPLACE edits apply, tolerating trailing whitespace", () => {
    const [e] = parseEdits("=== EDIT: a.py ===\n<<<<<<< SEARCH\nx = 1  \n=======\nx = 2\n>>>>>>> REPLACE")
    assert.equal(applyEdit("x = 1\ny = 0", e.search, e.replace), "x = 2\ny = 0")
    assert.equal(applyEdit("z = 3", e.search, e.replace), null)
  })
})

describe("build preflight", () => {
  test("Java is reported as not buildable, with a reason", async () => {
    const s = await toolchainStatus("java", true)
    assert.equal(s.ok, false)
    assert.match(s.message ?? "", /can't build/)
  })

  test("a Java build is refused before any AI call or file write — never faked", async () => {
    const spec: ServiceSpec = parseIntent("Create a notification system", { ...PY, language: "java", framework: "spring" })
    const events: BuildEvent[] = []
    await runBuild(spec, (e) => events.push(e), new AbortController().signal)
    assert.equal(events.length, 1)
    assert.equal(events[0].t, "error")
    assert.ok(!events.some((e) => e.t === "done"))
  })
})

describe("production hardening", () => {
  const headers = (h: Record<string, string>) => ({ headers: h }) as unknown as http.IncomingMessage

  test("a hallucinated import is reported, never pip-installed", () => {
    const { packages, unknown } = deriveRequirements({ "main.py": "import os\nimport jwt\nfrom fastapi_jwtauth2 import Auth\n" }, "/nonexistent")
    assert.ok(packages.includes("PyJWT"))
    assert.ok(!packages.some((p) => p.includes("jwtauth2")))
    assert.deepEqual(unknown, ["fastapi_jwtauth2"])
  })

  test("KIVO_EXTRA_PACKAGES lets the user vouch for a package", () => {
    process.env.KIVO_EXTRA_PACKAGES = "fastapi-jwtauth2==1.0"
    try {
      const { packages, unknown } = deriveRequirements({ "main.py": "from fastapi_jwtauth2 import Auth\n" }, "/nonexistent")
      assert.ok(packages.includes("fastapi-jwtauth2==1.0"))
      assert.deepEqual(unknown, [])
    } finally {
      delete process.env.KIVO_EXTRA_PACKAGES
    }
  })

  test("repair edits insert $-patterns literally", () => {
    assert.equal(applyEdit("PATTERN = None\n", "PATTERN = None", "PATTERN = r'^[a-z]+$'"), "PATTERN = r'^[a-z]+$'\n")
    assert.equal(applyEdit("a = 1", "a = 1", "a = '$&$$'"), "a = '$&$$'")
  })

  test("generated code doesn't inherit the user's credentials", () => {
    process.env.GITHUB_TOKEN = "ghp_test"
    process.env.AWS_SECRET_ACCESS_KEY = "aws_test"
    process.env.GROQ_API_KEY = "gsk_test"
    try {
      const env = sandboxEnv()
      assert.equal(env.GITHUB_TOKEN, undefined)
      assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined)
      assert.equal(env.GROQ_API_KEY, undefined)
      assert.ok(env.PATH)
      assert.equal(env.PYTHONUNBUFFERED, "1")
    } finally {
      delete process.env.GITHUB_TOKEN
      delete process.env.AWS_SECRET_ACCESS_KEY
      delete process.env.GROQ_API_KEY
    }
  })

  test("DNS rebinding: only loopback Host headers are answered", () => {
    assert.ok(hostOk(headers({ host: "localhost:5175" })))
    assert.ok(hostOk(headers({ host: "127.0.0.1:5174" })))
    assert.ok(!hostOk(headers({ host: "attacker.example:5175" })))
    assert.ok(!hostOk(headers({ host: "127.0.0.1.attacker.example" })))
    assert.ok(!hostOk(headers({})))
  })

  test("only the Kivo UI origin may call the daemon", () => {
    assert.ok(originOk(headers({ origin: "http://localhost:5174" })))
    assert.ok(originOk(headers({})))
    assert.ok(!originOk(headers({ origin: "https://evil.example" })))
    assert.ok(!originOk(headers({ origin: "http://localhost:9999" })))
  })
})
