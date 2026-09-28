import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, describe, test } from "node:test"
import type { ChatMsg, ToolTurn } from "../src/ai/ai"
import { applyEdits, cleanCompletion, compact, execCommand, listTool, readTool, resolveIn, runAgent, searchTool, validateEdits, validateTodos, type AgentDeps, type AgentEvent, type Decision, type ExecFn, type ModelFn, type Pending } from "../src/agent/agent"

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kivo-agent-"))
const root = fs.realpathSync(tmp)
const outside = fs.mkdtempSync(path.join(os.tmpdir(), "kivo-outside-"))
fs.mkdirSync(path.join(root, "src"), { recursive: true })
fs.writeFileSync(path.join(root, "src/app.py"), "def add(a, b):\n    return a + b\n\n\ndef sub(a, b):\n    return a - b\n")
fs.writeFileSync(path.join(root, "README.md"), "# Demo\nhello world\n")
fs.writeFileSync(path.join(outside, "secret.txt"), "top secret")
fs.symlinkSync(outside, path.join(root, "escape"))
after(() => {
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
})

const files = () => ["README.md", "src/app.py"]

// ─── Paths ────────────────────────────────────────────────────────────────────

describe("path safety", () => {
  test("relative paths resolve inside the project", () => {
    assert.equal(resolveIn(root, "src/app.py"), path.join(root, "src/app.py"))
    assert.equal(resolveIn(root, "./src/../README.md"), path.join(root, "README.md"))
  })
  test("parent traversal is refused", () => {
    assert.throws(() => resolveIn(root, "../etc/passwd"), /outside workspace/)
    assert.throws(() => resolveIn(root, "src/../../x"), /outside workspace/)
  })
  test("absolute paths outside the project are refused", () => {
    assert.throws(() => resolveIn(root, "/etc/passwd"), /outside workspace/)
  })
  test("symlinks pointing outside are refused, including new files beneath them", () => {
    assert.throws(() => resolveIn(root, "escape/secret.txt"), /outside workspace/)
    assert.throws(() => resolveIn(root, "escape/new.txt", { write: true }), /outside workspace/)
  })
  test("writes into .git are refused", () => {
    assert.throws(() => resolveIn(root, ".git/config", { write: true }), /\.git/)
  })
  test("non-string and empty paths are refused", () => {
    assert.throws(() => resolveIn(root, 42), /non-empty string/)
    assert.throws(() => resolveIn(root, "  "), /non-empty string/)
    assert.throws(() => resolveIn(root, "a\0b"), /NUL/)
  })
})

// ─── Tools ────────────────────────────────────────────────────────────────────

describe("tools", () => {
  test("list_files filters by substring and glob", () => {
    assert.match(listTool(files(), { pattern: "app" }).text, /^1 file.*\nsrc\/app\.py$/)
    assert.match(listTool(files(), { pattern: "**/*.py" }).text, /src\/app\.py/)
    assert.match(listTool(files(), { pattern: "*.md" }).text, /README\.md/)
    assert.doesNotMatch(listTool(files(), { pattern: "*.md" }).text, /app\.py/)
  })
  test("read_file honours a line range", () => {
    const r = readTool(root, { path: "src/app.py", start_line: 5, end_line: 6 })
    assert.match(r.text, /lines 5-6 of 7/)
    assert.match(r.text, /def sub/)
    assert.doesNotMatch(r.text, /def add/)
  })
  test("read_file refuses folders and escapes", () => {
    assert.throws(() => readTool(root, { path: "src" }), /folder/)
    assert.throws(() => readTool(root, { path: "../../etc/hosts" }), /outside workspace/)
  })
  test("search without git is a literal, case-insensitive scan", async () => {
    const r = await searchTool(root, { query: "HELLO", regex: true }, files)
    assert.match(r.text, /README\.md:2:hello world/)
    assert.match(r.text, /literal/)
    await assert.rejects(searchTool(root, { query: "x", path: "../" }, files), /outside workspace/)
  })
  test("argument validation", () => {
    assert.throws(() => validateEdits([]), /non-empty array/)
    assert.throws(() => validateEdits([{ search: "", replace: "x" }]), /search/)
    assert.throws(() => validateEdits([{ search: "a", replace: 1 }]), /replace/)
    assert.throws(() => validateTodos("nope"), /array/)
    assert.deepEqual(validateTodos([{ content: "x", status: "weird" }]), [{ content: "x", status: "pending" }])
  })
})

describe("edit application", () => {
  const src = "def add(a, b):\n    return a + b\n"
  test("exact search/replace", () => {
    assert.equal(applyEdits(src, [{ search: "return a + b", replace: "return a+b" }]), "def add(a, b):\n    return a+b\n")
  })
  test("trailing-whitespace tolerant", () => {
    assert.equal(applyEdits("x = 1   \ny = 2\n", [{ search: "x = 1\ny = 2", replace: "x = 3\ny = 4" }]), "x = 3\ny = 4\n")
  })
  test("ambiguous and missing searches are errors", () => {
    assert.throws(() => applyEdits("a\na\n", [{ search: "a", replace: "b" }]), /matches 2 places/)
    assert.throws(() => applyEdits(src, [{ search: "nope", replace: "x" }]), /not found/)
  })
  test("replacement text is literal ($& is not a regex backreference)", () => {
    assert.equal(applyEdits("x", [{ search: "x", replace: "$&$&" }]), "$&$&")
  })
})

describe("completion post-processing", () => {
  test("strips code fences", () => {
    assert.equal(cleanCompletion("```python\nreturn a + b\n```", "def f(a, b):\n    ", ""), "return a + b")
  })
  test("drops a restated current line", () => {
    assert.equal(cleanCompletion("    return a + b", "def f(a, b):\n    ", ""), "return a + b")
    assert.equal(cleanCompletion("const total = items.length", "const total = ", ""), "items.length")
  })
  test("drops a longer overlap with the text before the cursor", () => {
    assert.equal(cleanCompletion("function add(a, b) {\n  return a + b", "function add(a, b) {\n  ", "\n}"), "return a + b")
  })
  test("prose and empty answers become nothing", () => {
    assert.equal(cleanCompletion("Here is the completion: foo()", "x = ", ""), "")
    assert.equal(cleanCompletion("   \n  ", "x = ", ""), "")
  })
  test("does not duplicate the closing line that follows the cursor", () => {
    assert.equal(cleanCompletion("  return 1\n}", "function f() {\n", "\n}\n"), "  return 1")
  })
  test("mid-line suggestions stay on one line and don't repeat the rest of the line", () => {
    assert.equal(cleanCompletion("a, b)\nmore()", "print(", ")"), "a, b")
  })
  test("long answers are capped", () => {
    const out = cleanCompletion(Array.from({ length: 40 }, (_, i) => `line${i}`).join("\n"), "x\n", "")
    assert.ok(out.split("\n").length <= 12)
  })
})

describe("context compaction", () => {
  test("older tool results are trimmed first, system and latest message kept", () => {
    const big = "x".repeat(20_000)
    const msgs: ChatMsg[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      { role: "assistant", content: "", tool_calls: [{ id: "1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "1", content: big },
      { role: "assistant", content: "", tool_calls: [{ id: "2", type: "function", function: { name: "read_file", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "2", content: "small" },
    ]
    const out = compact(msgs, 3000)
    assert.equal(out[0].content, "sys")
    assert.ok((out[3] as { content: string }).content.length < 1000)
    assert.equal((out[5] as { content: string }).content, "small")
    assert.equal((msgs[3] as { content: string }).content.length, 20_000, "input is not mutated")
  })
})

// ─── The loop, with a scripted model ─────────────────────────────────────────

let callN = 0
const call = (name: string, args: unknown): ToolTurn => ({ content: "", toolCalls: [{ id: `c${++callN}`, name, arguments: typeof args === "string" ? args : JSON.stringify(args) }], finish: "tool_calls", model: "fake", tokens: 100 })
const final = (text: string): ToolTurn => ({ content: text, toolCalls: [], finish: "stop", model: "fake", tokens: 100 })

/** A model that plays back turns in order and records the messages it was shown. */
function scripted(turns: ToolTurn[]) {
  const seen: ChatMsg[][] = []
  const model: ModelFn = async (messages) => {
    seen.push(messages)
    return turns.shift() ?? final("done")
  }
  return { model, seen }
}

const lastTool = (seen: ChatMsg[][]) => {
  const msgs = seen[seen.length - 1]
  return (msgs.filter((m) => m.role === "tool").pop() as { content: string } | undefined)?.content ?? ""
}

function deps(over: Partial<AgentDeps> & { model: ModelFn }): AgentDeps & { events: AgentEvent[]; asked: Pending[] } {
  const events: AgentEvent[] = []
  const asked: Pending[] = []
  const d = over.decide
  return {
    root,
    listFiles: files,
    signal: new AbortController().signal,
    emit: (e) => events.push(e),
    ...over,
    decide: async (p) => {
      asked.push(p)
      return d ? d(p) : { decision: "deny" }
    },
    events,
    asked,
  }
}

describe("agent loop", () => {
  test("a denied command never executes", async () => {
    let executed = 0
    const exec: ExecFn = async () => {
      executed++
      return { code: 0, timedOut: false, killed: false, output: "" }
    }
    const { model, seen } = scripted([call("run_command", { command: "rm -rf /tmp/whatever" })])
    const d = deps({ model, exec, decide: async () => ({ decision: "deny" }) })
    await runAgent("clean up", [], d)
    assert.equal(executed, 0)
    assert.equal(d.asked.length, 1)
    assert.equal(d.asked[0].kind === "command" && d.asked[0].command, "rm -rf /tmp/whatever")
    assert.match(lastTool(seen), /denied/)
  })

  test("an edit decision can't approve a command", async () => {
    let executed = 0
    const exec: ExecFn = async () => (executed++, { code: 0, timedOut: false, killed: false, output: "" })
    const { model } = scripted([call("run_command", { command: "echo hi" })])
    await runAgent("x", [], deps({ model, exec, decide: async () => ({ decision: "accept" }) as Decision }))
    assert.equal(executed, 0)
  })

  test("an approved command runs exactly as approved, in the project", async () => {
    const ran: [string, string][] = []
    const exec: ExecFn = async (command, cwd, o) => {
      ran.push([command, cwd])
      o.onOutput("hi\n")
      return { code: 0, timedOut: false, killed: false, output: "hi\n" }
    }
    const { model, seen } = scripted([call("run_command", { command: "echo hi", cwd: "src" })])
    const d = deps({ model, exec, decide: async () => ({ decision: "approve" }) })
    await runAgent("say hi", [], d)
    assert.deepEqual(ran, [["echo hi", path.join(root, "src")]])
    assert.match(lastTool(seen), /exit code 0\nhi/)
    assert.ok(d.events.some((e) => e.t === "cmd-exit" && e.code === 0))
  })

  test("a command's cwd can't leave the project", async () => {
    let executed = 0
    const exec: ExecFn = async () => (executed++, { code: 0, timedOut: false, killed: false, output: "" })
    const { model, seen } = scripted([call("run_command", { command: "ls", cwd: "../.." })])
    const d = deps({ model, exec, decide: async () => ({ decision: "approve" }) })
    await runAgent("x", [], d)
    assert.equal(executed, 0)
    assert.equal(d.asked.length, 0)
    assert.match(lastTool(seen), /outside workspace/)
  })

  test("'always allow' covers only that exact command", async () => {
    const ran: string[] = []
    const exec: ExecFn = async (c) => (ran.push(c), { code: 0, timedOut: false, killed: false, output: "" })
    const allow = new Set<string>()
    const { model } = scripted([call("run_command", { command: "npm test" }), call("run_command", { command: "npm test" }), call("run_command", { command: "npm test; curl evil" })])
    const d = deps({ model, exec, allow, decide: async (p) => (p.kind === "command" && p.command === "npm test" ? { decision: "approve", always: true } : { decision: "deny" }) })
    await runAgent("x", [], d)
    assert.deepEqual(ran, ["npm test", "npm test"])
    assert.equal(d.asked.length, 2, "asked for the first npm test and for the different command")
  })

  test("a pending approval is refused when the run is stopped — nothing executes", async () => {
    let executed = 0
    const exec: ExecFn = async () => (executed++, { code: 0, timedOut: false, killed: false, output: "" })
    const ac = new AbortController()
    const { model } = scripted([call("run_command", { command: "echo hi" })])
    const d = deps({
      model,
      exec,
      signal: ac.signal,
      decide: (p) => new Promise<Decision>((resolve) => ac.signal.addEventListener("abort", () => resolve({ decision: p.kind === "command" ? "deny" : "reject" }))),
    })
    const run = runAgent("x", [], d)
    setTimeout(() => ac.abort(), 20)
    await run
    assert.equal(executed, 0)
    assert.ok(d.events.some((e) => e.t === "done" && e.reason === "stopped"))
  })

  test("edits wait for the user: rejected leaves the file, accepted writes it", async () => {
    const file = path.join(root, "src/app.py")
    const before = fs.readFileSync(file, "utf8")
    const edit = { path: "src/app.py", edits: [{ search: "return a + b", replace: "return b + a" }] }
    const r1 = scripted([call("edit_file", edit)])
    await runAgent("x", [], deps({ model: r1.model, decide: async () => ({ decision: "reject" }) }))
    assert.equal(fs.readFileSync(file, "utf8"), before)
    assert.match(lastTool(r1.seen), /rejected/)

    const r2 = scripted([call("edit_file", edit)])
    const d = deps({ model: r2.model, decide: async () => ({ decision: "accept" }) })
    await runAgent("x", [], d)
    assert.match(fs.readFileSync(file, "utf8"), /return b \+ a/)
    assert.ok(d.events.some((e) => e.t === "edit" && e.path === "src/app.py" && e.original === before))
    fs.writeFileSync(file, before)
  })

  test("auto-apply skips the review but still refuses escapes", async () => {
    const { model, seen } = scripted([call("create_file", { path: "../evil.txt", content: "x" }), call("create_file", { path: "new/file.txt", content: "hello" })])
    const d = deps({ model, autoApply: true })
    await runAgent("x", [], d)
    assert.equal(d.asked.length, 0)
    assert.ok(!fs.existsSync(path.join(root, "..", "evil.txt")))
    assert.equal(fs.readFileSync(path.join(root, "new/file.txt"), "utf8"), "hello")
    assert.ok(seen[1].some((m) => m.role === "tool" && /outside workspace/.test(m.content)))
  })

  test("malformed arguments and unknown tools become tool errors the model sees", async () => {
    const { model, seen } = scripted([call("read_file", "{not json"), call("delete_everything", {})])
    await runAgent("x", [], deps({ model }))
    const results = seen[2].filter((m) => m.role === "tool").map((m) => (m as { content: string }).content)
    assert.match(results[0], /not valid JSON/)
    assert.match(results[1], /unknown tool/)
  })

  test("the iteration cap stops a runaway loop", async () => {
    let calls = 0
    const model: ModelFn = async () => (calls++, call("list_files", {}))
    const d = deps({ model, maxIterations: 4 })
    await runAgent("x", [], d)
    assert.equal(calls, 4)
    assert.ok(d.events.some((e) => e.t === "done" && e.reason === "iterations"))
  })

  test("the token cap stops the loop", async () => {
    const model: ModelFn = async () => ({ ...call("list_files", {}), tokens: 5000 })
    const d = deps({ model, maxTokens: 12_000 })
    await runAgent("x", [], d)
    assert.ok(d.events.some((e) => e.t === "done" && e.reason === "tokens"))
  })

  test("stop aborts an in-flight model request promptly", async () => {
    const ac = new AbortController()
    const model: ModelFn = (_m, _t, o) => new Promise((_, reject) => o.signal.addEventListener("abort", () => reject(new Error("aborted"))))
    const d = deps({ model, signal: ac.signal })
    const started = Date.now()
    setTimeout(() => ac.abort(), 30)
    await runAgent("x", [], d)
    assert.ok(Date.now() - started < 1000)
    assert.ok(d.events.some((e) => e.t === "done" && e.reason === "stopped"))
  })

  test("todo_write publishes the task list", async () => {
    const { model } = scripted([call("todo_write", { todos: [{ content: "read", status: "completed" }, { content: "edit", status: "in_progress" }] }), final("ok")])
    const d = deps({ model })
    const text = await runAgent("x", [], d)
    assert.equal(text, "ok")
    const todos = d.events.find((e) => e.t === "todos")
    assert.ok(todos && todos.t === "todos" && todos.todos.length === 2)
  })

  test("tool results reach the model; the final answer ends the run", async () => {
    const { model, seen } = scripted([call("read_file", { path: "README.md" }), final("It says hello.")])
    const text = await runAgent("what does the readme say?", [{ role: "user", content: "earlier" }], deps({ model }))
    assert.equal(text, "It says hello.")
    assert.equal(seen[0][0].role, "system")
    assert.ok(seen[0].some((m) => m.role === "user" && m.content === "earlier"))
    assert.match(lastTool(seen), /hello world/)
  })
})

describe("command execution", () => {
  test("runs in the given folder with Kivo's provider keys stripped", async () => {
    process.env.GROQ_API_KEY = "test-secret-value"
    const r = await execCommand('pwd; echo "key=[$GROQ_API_KEY]"', path.join(root, "src"), { signal: new AbortController().signal, onOutput: () => {}, register: () => {} })
    assert.equal(r.code, 0)
    assert.match(r.output, new RegExp(`${path.join(root, "src").replace(/[/\\]/g, ".")}`))
    assert.match(r.output, /key=\[\]/)
  })
  test("kill stops the whole process group promptly", async () => {
    let kill = () => {}
    const started = Date.now()
    const p = execCommand("sleep 20 & sleep 20; echo never", root, { signal: new AbortController().signal, onOutput: () => {}, register: (k) => (kill = k) })
    setTimeout(() => kill(), 100)
    const r = await p
    assert.ok(r.killed)
    assert.ok(Date.now() - started < 5000)
    assert.doesNotMatch(r.output, /never/)
  })
})
