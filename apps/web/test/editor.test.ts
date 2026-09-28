import assert from "node:assert/strict"
import { describe, test } from "node:test"

describe("editor helpers", () => {
  test("quick open ranks file-name matches above path matches", async () => {
    const { scorePath } = await import("../src/features/editor/fuzzy")
    const files = ["backend/app/users/router.py", "docs/routing/overview.md", "server/prompts.ts", "src/core/runtime.ts"]
    const ranked = files
      .map((f) => ({ f, s: scorePath("rout", f) }))
      .filter((x) => x.s)
      .sort((a, b) => b.s!.score - a.s!.score)
      .map((x) => x.f)
    assert.equal(ranked[0], "backend/app/users/router.py")
    assert.equal(scorePath("zzz", "a/b.ts"), null)
  })
  test("symbols per language, and the enclosing chain for breadcrumbs", async () => {
    const { symbolAt, symbolsOf } = await import("../src/features/editor/symbols")
    const py = "class Users:\n    def get(self):\n        return 1\n\ndef main():\n    pass\n"
    assert.deepEqual(
      symbolsOf("a.py", py).map((s) => [s.name, s.kind, s.line]),
      [
        ["Users", "class", 1],
        ["get", "function", 2],
        ["main", "function", 5],
      ],
    )
    assert.deepEqual(
      symbolAt(symbolsOf("a.py", py), py, 3).map((s) => s.name),
      ["Users", "get"],
    )
    const go = "package x\n\ntype Server struct {}\n\nfunc (s *Server) Start() error {\n}\n"
    assert.deepEqual(
      symbolsOf("x.go", go).map((s) => s.name),
      ["Server", "Start"],
    )
    const ts = "export interface A {}\nexport const useThing = () => {}\nexport default function App() {}\n"
    assert.deepEqual(
      symbolsOf("x.tsx", ts).map((s) => s.name),
      ["A", "useThing", "App"],
    )
    assert.deepEqual(
      symbolsOf("r.md", "# Title\n```\n# not a heading\n```\n## Sub\n").map((s) => s.name),
      ["Title", "Sub"],
    )
  })
  test("indentation detection", async () => {
    const { detectIndent } = await import("../src/features/code/languages")
    assert.deepEqual(detectIndent("a:\n  b:\n    c: 1\n"), { tabs: false, size: 2 })
    assert.deepEqual(detectIndent("def f():\n    return 1\n"), { tabs: false, size: 4 })
    assert.equal(detectIndent("func f() {\n\treturn\n}\n").tabs, true)
  })
})
