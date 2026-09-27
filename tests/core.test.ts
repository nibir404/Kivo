import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { languageReason, parseIntent } from "../src/core/intent"
import { planFor } from "../src/core/plan"
import { detectStack, toolchainFor } from "../src/core/stacks"
import type { StackChoice } from "../src/core/types"

const PY: StackChoice = { language: "python", framework: "fastapi", database: "PostgreSQL", cache: "Redis" }
const JAVA: StackChoice = { language: "java", framework: "spring", database: "PostgreSQL", cache: "Redis" }

describe("detectStack — a language named in the request wins", () => {
  const cases: [string, string | null, string?][] = [
    ["Create a notification service using Java", "java", "spring"],
    ["notifications in Spring Boot", "java", "spring"],
    ["a Quarkus service for invoices", "java", "quarkus"],
    ["Build it with Kotlin", "kotlin", "ktor"],
    ["write the payments API in Go", "go", "stdlib"],
    ["a golang worker", "go", "stdlib"],
    ["a Rust service with axum", "rust", "axum"],
    ["use FastAPI", "python", "fastapi"],
    ["an Express.js server", "typescript", "express"],
    ["a JavaScript backend", "typescript", "node"],
    ["Create a notification system.", null],
    ["Let's go build a login page", null],
    ["express delivery notifications", null],
  ]
  for (const [text, language, framework] of cases) {
    test(JSON.stringify(text), () => {
      const got = detectStack(text)
      if (language === null) assert.equal(got, null)
      else {
        assert.equal(got?.language, language)
        if (framework) assert.equal(got?.framework, framework)
      }
    })
  }
})

describe("planFor — files match the service's language", () => {
  test("Java services never get TypeScript files", () => {
    const spec = parseIntent("Create a notification system", JAVA)
    const files = planFor(spec).flatMap((s) => s.artifacts)
    assert.ok(!files.some((f) => f.endsWith(".ts")), files.join(", "))
    assert.ok(files.some((f) => f.endsWith(".java")))
    const install = planFor(spec).find((s) => s.id === "install")!
    assert.equal(install.engine, "Maven")
  })

  test("Python services keep the verified pipeline layout", () => {
    const files = planFor(parseIntent("Create an authentication service", PY)).flatMap((s) => s.artifacts)
    for (const f of ["requirements.txt", "tests/conftest.py", "db.py", "security.py"]) assert.ok(files.some((x) => x.endsWith(f)), f)
  })
})

describe("parseIntent", () => {
  test("keeps the chosen language and explains it honestly", () => {
    const spec = parseIntent("notifications", JAVA)
    assert.equal(spec.implementation.language, "java")
    const d = spec.decisions.find((x) => x.topic === "Language & framework")!
    assert.equal(d.choice, "Java · Spring Boot")
    assert.equal(d.reason, languageReason("java"))
    assert.doesNotMatch(d.reason, /Matches the existing backend/)
  })
})

describe("toolchains", () => {
  test("only Python has a verified build pipeline", () => {
    assert.equal(toolchainFor("python").buildable, true)
    for (const l of ["java", "typescript", "go", "rust", "kotlin"]) assert.equal(toolchainFor(l).buildable, false, l)
  })
  test("unknown languages degrade safely", () => {
    assert.equal(toolchainFor("cobol").buildable, false)
  })
})
