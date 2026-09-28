import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, test } from "node:test"
import { createEntry, duplicateEntry, emptyDirs, listProjectFiles, renameEntry, replaceInFiles, resolveIn, searchFiles, trashEntry } from "../server/editor"
import { buildMatcher, findInText, globToRegExp, replaceInText } from "../src/features/editor/match"

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kivo-editor-")))
const proj = path.join(tmp, "proj")
const trash = path.join(tmp, "trash")
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(proj, rel)), { recursive: true })
  fs.writeFileSync(path.join(proj, rel), text)
}
const read = (rel: string) => fs.readFileSync(path.join(proj, rel), "utf8")

function hasGit() {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

before(() => {
  fs.mkdirSync(proj, { recursive: true })
  write("src/app.py", "def main():\n    print('hello world')\n\ndef helper():\n    return main()\n")
  write("src/util.ts", "export const mainValue = 1\r\nexport function mainly() { return 'main' }\r\n")
  write("docs/readme.md", "# Main\nsee main.py — ünïcode main\n")
  write("node_modules/dep/index.js", "main main main\n")
  fs.writeFileSync(path.join(proj, "bin.dat"), Buffer.from([0x6d, 0x61, 0x69, 0x6e, 0, 1, 2]))
})

after(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe("matcher", () => {
  test("literal queries escape regex syntax", () => {
    assert.equal(findInText(buildMatcher({ query: "a.b" }), "axb a.b").length, 1)
  })
  test("whole word and case", () => {
    const re = buildMatcher({ query: "main", wholeWord: true, caseSensitive: true })
    assert.deepEqual(
      findInText(re, "main mainly Main _main main").map((m) => m.col),
      [0, 23],
    )
  })
  test("invalid regex has a readable error", () => {
    assert.throws(() => buildMatcher({ query: "(", regex: true }), /Invalid regular expression/)
  })
  test("zero-length matches don't loop", () => {
    assert.equal(findInText(buildMatcher({ query: "x*", regex: true }), "abc").length, 0)
  })
  test("replace keeps CRLF and expands groups only in regex mode", () => {
    assert.deepEqual(replaceInText(buildMatcher({ query: "(\\w+)@", regex: true }), "a@\r\nbb@\r\n", "<$1>$$", true), { text: "<a>$\r\n<bb>$\r\n", count: 2 })
    assert.deepEqual(replaceInText(buildMatcher({ query: "a" }), "a a", "$&", false), { text: "$& $&", count: 2 })
  })
  test("globs", () => {
    assert.ok(globToRegExp("*.py").test("src/app.py"))
    assert.ok(globToRegExp("src").test("src/deep/x.ts"))
    assert.ok(globToRegExp("src/**/*.{ts,tsx}").test("src/a/b.tsx"))
    assert.ok(!globToRegExp("src/*.ts").test("src/a/b.ts"))
  })
})

describe("paths", () => {
  test("escapes are refused", () => {
    assert.throws(() => resolveIn(proj, "../outside.txt"), /Path outside workspace/)
    assert.throws(() => resolveIn(proj, "/etc/passwd"), /Path outside workspace/)
    assert.throws(() => resolveIn(proj, "."), /project folder itself/)
    assert.throws(() => resolveIn(proj, ".git/config"), /inside .git/)
  })
  test("a symlinked folder can't be used to write outside", () => {
    const outside = path.join(tmp, "outside")
    fs.mkdirSync(outside, { recursive: true })
    fs.symlinkSync(outside, path.join(proj, "link"))
    try {
      assert.throws(() => createEntry(proj, "link/evil.txt", "file"), /Path outside workspace/)
      assert.equal(fs.existsSync(path.join(outside, "evil.txt")), false)
    } finally {
      fs.unlinkSync(path.join(proj, "link"))
    }
  })
})

describe("file operations", () => {
  test("create file and folder, refusing to overwrite", () => {
    createEntry(proj, "new/deep/file.txt", "file")
    assert.equal(read("new/deep/file.txt"), "")
    assert.throws(() => createEntry(proj, "new/deep/file.txt", "file"), /already exists/)
    createEntry(proj, "empty/inner", "folder")
    assert.ok(fs.statSync(path.join(proj, "empty/inner")).isDirectory())
    assert.deepEqual(emptyDirs(proj, listProjectFiles(proj)), ["empty", "empty/inner"])
  })
  test("rename and move", () => {
    write("r/a.txt", "A")
    assert.deepEqual(renameEntry(proj, "r/a.txt", "r2/b.txt"), { path: "r2/b.txt" })
    assert.equal(read("r2/b.txt"), "A")
    write("r/c.txt", "C")
    assert.throws(() => renameEntry(proj, "r/c.txt", "r2/b.txt"), /already exists/)
    assert.throws(() => renameEntry(proj, "r", "r/sub"), /into itself/)
    assert.throws(() => renameEntry(proj, "r/c.txt", "../c.txt"), /Path outside workspace/)
  })
  test("duplicate picks a free name", () => {
    write("d/x.ts", "X")
    assert.equal(duplicateEntry(proj, "d/x.ts").path, "d/x copy.ts")
    assert.equal(duplicateEntry(proj, "d/x.ts").path, "d/x copy 2.ts")
    assert.equal(duplicateEntry(proj, "d").path, "d copy")
    assert.equal(read("d copy/x.ts"), "X")
  })
  test("delete moves to the trash (macOS layout), unique names on collision", () => {
    write("t/gone.txt", "1")
    const a = trashEntry(proj, "t/gone.txt", { trash, platform: "darwin" })
    write("t/gone.txt", "2")
    const b = trashEntry(proj, "t/gone.txt", { trash, platform: "darwin" })
    assert.equal(fs.existsSync(path.join(proj, "t/gone.txt")), false)
    assert.equal(path.basename(a.trashed), "gone.txt")
    assert.equal(path.basename(b.trashed), "gone 2.txt")
    assert.equal(fs.readFileSync(b.trashed, "utf8"), "2")
  })
  test("delete on Linux writes a .trashinfo", () => {
    write("t/dir/f.txt", "f")
    const lt = path.join(tmp, "xdg-trash")
    const r = trashEntry(proj, "t/dir", { trash: lt, platform: "linux" })
    assert.equal(r.trashed, path.join(lt, "files", "dir"))
    assert.match(fs.readFileSync(path.join(lt, "info", "dir.trashinfo"), "utf8"), /^\[Trash Info\]\nPath=.*\/t\/dir\nDeletionDate=/)
  })
  test("no known trash → refuse rather than delete", () => {
    write("t/keep.txt", "k")
    assert.throws(() => trashEntry(proj, "t/keep.txt", { trash: null }), /won't delete/)
    assert.equal(read("t/keep.txt"), "k")
  })
  test("trash refuses escapes", () => {
    assert.throws(() => trashEntry(proj, "../trash", { trash, platform: "darwin" }), /Path outside workspace/)
  })
})

describe("search", () => {
  test("JS scan: groups by file, skips ignored and binary files, UTF-16 columns", async () => {
    const r = await searchFiles(proj, { query: "main", engine: "js" })
    assert.equal(r.engine, "js")
    const files = r.files.map((f) => f.path)
    assert.ok(files.includes("src/app.py"))
    assert.ok(!files.some((f) => f.startsWith("node_modules")))
    assert.ok(!files.includes("bin.dat"))
    const md = r.files.find((f) => f.path === "docs/readme.md")!
    const last = md.matches.at(-1)!
    assert.equal(last.line, 2)
    assert.equal("see main.py — ünïcode main".slice(last.col, last.col + last.len), "main")
  })
  test("include / exclude / whole word / case", async () => {
    const r = await searchFiles(proj, { query: "main", engine: "js", include: "src", exclude: "*.ts", wholeWord: true })
    assert.deepEqual(
      r.files.map((f) => [f.path, f.matches.length]),
      [["src/app.py", 2]],
    )
    const cs = await searchFiles(proj, { query: "Main", engine: "js", caseSensitive: true })
    assert.deepEqual(
      cs.files.map((f) => f.path),
      ["docs/readme.md"],
    )
  })
  test("cap reports truncation", async () => {
    const r = await searchFiles(proj, { query: "main", engine: "js", maxResults: 2 })
    assert.equal(r.total, 2)
    assert.equal(r.truncated, true)
  })
  test("bad regex is a 400", async () => {
    await assert.rejects(searchFiles(proj, { query: "[", regex: true, engine: "js" }), (e: Error & { status?: number }) => e.status === 400)
  })
  test("git grep engine agrees with the JS scan", { skip: !hasGit() }, async () => {
    const g = path.join(tmp, "gitproj")
    fs.cpSync(proj, g, { recursive: true })
    fs.writeFileSync(path.join(g, ".gitignore"), "node_modules/\n")
    execFileSync("git", ["init", "-q"], { cwd: g })
    const r = await searchFiles(g, { query: "main", engine: "git" })
    const js = await searchFiles(g, { query: "main", engine: "js" })
    assert.equal(r.engine, "git")
    const key = (x: typeof r) => x.files.flatMap((f) => f.matches.map((m) => `${f.path}:${m.line}:${m.col}`)).sort()
    assert.deepEqual(key(r), key(js))
    // regex through git grep -P (or the JS fallback if this git lacks PCRE)
    const re = await searchFiles(g, { query: "def \\w+\\(", regex: true })
    assert.equal(re.total, 2)
  })
  test("ripgrep JSON is parsed (byte offsets → UTF-16 columns, ./ stripped, filters applied)", async () => {
    // A stand-in rg that replays canned --json output, so the parser is tested without ripgrep installed.
    const fake = path.join(tmp, "fake-rg.mjs")
    const lines = [
      { type: "begin", data: { path: { text: "./docs/readme.md" } } },
      { type: "match", data: { path: { text: "./docs/readme.md" }, lines: { text: "see main.py — ünïcode main\n" }, line_number: 2, submatches: [{ match: { text: "main" }, start: 4, end: 8 }, { match: { text: "main" }, start: Buffer.byteLength("see main.py — ünïcode "), end: Buffer.byteLength("see main.py — ünïcode main") }] } },
      { type: "match", data: { path: { text: "./src/util.ts" }, lines: { text: "export const mainValue = 1\r\n" }, line_number: 1, submatches: [{ match: { text: "main" }, start: 13, end: 17 }] } },
    ]
    fs.writeFileSync(fake, `#!/usr/bin/env node\nif (process.argv.includes("--version")) { console.log("ripgrep 14"); process.exit(0) }\n${lines.map((l) => `console.log(${JSON.stringify(JSON.stringify(l))})`).join("\n")}\n`)
    fs.chmodSync(fake, 0o755)
    const prev = process.env.KIVO_RG
    process.env.KIVO_RG = fake
    try {
      const r = await searchFiles(proj, { query: "main", engine: "rg", exclude: "*.ts" })
      assert.equal(r.engine, "rg")
      assert.deepEqual(
        r.files.map((f) => f.path),
        ["docs/readme.md"],
      )
      const [m1, m2] = r.files[0].matches
      assert.equal(m1.col, 4)
      assert.equal(m2.col, "see main.py — ünïcode ".length)
      assert.equal(m2.len, 4)
      assert.equal(m2.text, "main")
    } finally {
      if (prev === undefined) delete process.env.KIVO_RG
      else process.env.KIVO_RG = prev
    }
  })
  test("auto falls back to the JS scan without rg or git", async () => {
    const prev = process.env.KIVO_RG
    process.env.KIVO_RG = path.join(tmp, "no-such-rg")
    try {
      const r = await searchFiles(proj, { query: "helper" })
      assert.equal(r.engine, "js")
      assert.equal(r.total, 1)
    } finally {
      if (prev === undefined) delete process.env.KIVO_RG
      else process.env.KIVO_RG = prev
    }
  })
})

describe("replace", () => {
  test("dry run counts, then replaces on disk; skip leaves files alone", () => {
    write("rep/a.txt", "foo bar foo\n")
    write("rep/b.txt", "foo\r\nno\r\n")
    write("rep/c.txt", "foo\n")
    const q = { query: "foo", replace: "baz", include: "rep" }
    const dry = replaceInFiles(proj, { ...q, dryRun: true })
    assert.equal(dry.total, 4)
    assert.equal(read("rep/a.txt"), "foo bar foo\n")
    const done = replaceInFiles(proj, { ...q, skip: ["rep/c.txt"] })
    assert.equal(done.total, 3)
    assert.equal(read("rep/a.txt"), "baz bar baz\n")
    assert.equal(read("rep/b.txt"), "baz\r\nno\r\n")
    assert.equal(read("rep/c.txt"), "foo\n")
  })
  test("per-file replace with regex groups; paths are checked", () => {
    write("rep/d.txt", "x=1 y=2\n")
    replaceInFiles(proj, { query: "(\\w)=(\\d)", regex: true, replace: "$2=$1", paths: ["rep/d.txt"] })
    assert.equal(read("rep/d.txt"), "1=x 2=y\n")
    assert.throws(() => replaceInFiles(proj, { query: "x", replace: "y", paths: ["../etc"] }), /Path outside workspace/)
  })
})

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

describe("symlinks", () => {
  test("search and replace don't follow symlinks out of the project", async () => {
    const outside = path.join(tmp, "secret.txt")
    fs.writeFileSync(outside, "needle\n")
    fs.symlinkSync(outside, path.join(proj, "leak.txt"))
    try {
      const r = await searchFiles(proj, { query: "needle", engine: "js" })
      assert.equal(r.total, 0)
      replaceInFiles(proj, { query: "needle", replace: "gone", paths: ["leak.txt"] })
      assert.equal(fs.readFileSync(outside, "utf8"), "needle\n")
    } finally {
      fs.unlinkSync(path.join(proj, "leak.txt"))
    }
  })
})
