import assert from "node:assert/strict"
import { afterEach, describe, test } from "node:test"
import { runAgentIn, ToolError, type AgentEvent, type AgentWorkspace, type ModelFn } from "../src/agent"
import { aiAvailable, checkAll, configure, GROQ_DEFAULTS, stream, type ToolTurn } from "../src/client"

/** A scripted stand-in for an OpenAI-compatible provider, installed as global fetch. */
function fakeProvider(handler: (url: string, body: Record<string, unknown>, headers: Record<string, string>) => Response) {
  const calls: { url: string; body: Record<string, unknown>; auth?: string }[] = []
  const real = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({ url, body, auth: headers.Authorization })
    return handler(url, body, headers)
  }) as typeof fetch
  return { calls, restore: () => (globalThis.fetch = real) }
}

const sse = (chunks: unknown[]) =>
  new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } })
const words = (s: string) => sse([{ choices: [{ delta: { reasoning: "hmm" } }] }, ...s.split(" ").map((w, i) => ({ choices: [{ delta: { content: (i ? " " : "") + w } }] })), { choices: [{ delta: {}, finish_reason: "stop" }] }])

let restore: (() => void) | null = null
afterEach(() => {
  restore?.()
  restore = null
})

describe("provider client (shared by the daemon and the browser)", () => {
  test("a configured key is checked, then used as a bearer token for streamed answers", async () => {
    const f = fakeProvider((url) => (url.endsWith("/models") ? Response.json({ data: [] }) : words("hello from the model")))
    restore = f.restore
    configure([{ ...GROQ_DEFAULTS, key: "gsk_test" }])
    await checkAll()
    assert.ok(aiAvailable())
    const deltas: string[] = []
    const text = await stream([{ role: "user", content: "hi" }], (d) => deltas.push(`${d.channel}:${d.text}`))
    assert.equal(text, "hello from the model")
    assert.equal(deltas[0], "reasoning:hmm")
    assert.ok(f.calls.every((c) => c.auth === "Bearer gsk_test"))
    assert.equal(f.calls[1].body.model, "openai/gpt-oss-120b")
  })

  test("a rate-limited model fails over to the next one", async () => {
    const f = fakeProvider((url, body) => {
      if (url.endsWith("/models")) return Response.json({ data: [] })
      if (body.model === "openai/gpt-oss-120b") return new Response(JSON.stringify({ error: { message: "Rate limit reached. Please try again in 20s." } }), { status: 429 })
      return words("from the small model")
    })
    restore = f.restore
    configure([{ ...GROQ_DEFAULTS, key: "gsk_test" }])
    await checkAll()
    const waits: string[] = []
    const text = await stream([{ role: "user", content: "hi" }], () => {}, { onRateLimit: (r) => waits.push(`${r.model}→${r.next}`) })
    assert.equal(text, "from the small model")
    assert.deepEqual(waits, ["openai/gpt-oss-120b→openai/gpt-oss-20b"])
  })

  test("a rejected key leaves no provider available, with the provider's reason", async () => {
    const f = fakeProvider(() => new Response(JSON.stringify({ error: { message: "Invalid API Key" } }), { status: 401 }))
    restore = f.restore
    configure([{ ...GROQ_DEFAULTS, key: "gsk_wrong" }])
    const d = await checkAll()
    assert.equal(aiAvailable(), false)
    assert.equal(d.providers[0].status, "unauthorized")
    assert.equal(d.providers[0].message, "Invalid API Key")
  })

  test("no key means unconfigured, and nothing is requested", async () => {
    const f = fakeProvider(() => Response.json({}))
    restore = f.restore
    configure([{ ...GROQ_DEFAULTS, key: "" }])
    const d = await checkAll()
    assert.equal(d.providers[0].status, "unconfigured")
    assert.equal(f.calls.length, 0)
  })
})

/** An in-memory project, like the browser's: no shell. */
function memoryWorkspace(files: Record<string, string>): AgentWorkspace {
  const clean = (p: unknown) => {
    if (typeof p !== "string" || !p.trim() || p.includes("..") || p.startsWith("/")) throw new ToolError("Path outside workspace")
    return p.replace(/^\.\//, "") || "."
  }
  return {
    name: "demo",
    where: "(in the browser)",
    files: () => Object.keys(files).sort(),
    resolve: (p) => clean(p),
    exists: (r) => r in files,
    isDir: (r) => r === "." || Object.keys(files).some((f) => f.startsWith(`${r}/`)),
    read: (r) => {
      if (!(r in files)) throw new ToolError("file not found")
      return files[r]
    },
    write: (r, c) => void (files[r] = c),
    search: async ({ query }) => ({ lines: Object.entries(files).flatMap(([p, t]) => t.split("\n").flatMap((l, i) => (l.includes(query) ? [`${p}:${i + 1}:${l}`] : []))) }),
  }
}

const call = (name: string, args: unknown): ToolTurn => ({ content: "", toolCalls: [{ id: `c_${name}`, name, arguments: JSON.stringify(args) }], finish: "tool_calls", model: "fake", tokens: 50 })
const final = (text: string): ToolTurn => ({ content: text, toolCalls: [], finish: "stop", model: "fake", tokens: 50 })

describe("agent loop in a workspace without a shell (the browser)", () => {
  test("run_command isn't offered, and a call to it is an unknown tool", async () => {
    const offered: string[][] = []
    const turns = [call("run_command", { command: "rm -rf /" }), final("ok")]
    const seen: string[] = []
    const model: ModelFn = async (messages, tools) => {
      offered.push(tools.map((t) => t.function.name))
      const tool = messages.filter((m) => m.role === "tool").pop()
      if (tool) seen.push((tool as { content: string }).content)
      return turns.shift()!
    }
    await runAgentIn(memoryWorkspace({ "a.py": "x = 1\n" }), "clean up", [], { model, emit: () => {}, decide: async () => ({ decision: "approve" }), signal: new AbortController().signal })
    assert.ok(!offered[0].includes("run_command"))
    assert.match(seen[0], /unknown tool "run_command"/)
  })

  test("edits are proposed, wait for the user, and only then write", async () => {
    const files = { "src/app.py": "def add(a, b):\n    return a + b\n" }
    const events: AgentEvent[] = []
    const turns = [call("read_file", { path: "src/app.py" }), call("edit_file", { path: "src/app.py", edits: [{ search: "return a + b", replace: "return b + a" }] }), final("done")]
    let asked = 0
    await runAgentIn(memoryWorkspace(files), "swap", [], {
      model: async () => turns.shift()!,
      emit: (e) => events.push(e),
      decide: async () => {
        asked++
        assert.equal(files["src/app.py"].includes("b + a"), false, "nothing is written before the decision")
        return { decision: "accept" }
      },
      signal: new AbortController().signal,
    })
    assert.equal(asked, 1)
    assert.match(files["src/app.py"], /return b \+ a/)
    assert.ok(events.some((e) => e.t === "edit-result" && e.status === "applied"))
  })

  test("escapes are refused before anything is read", async () => {
    const turns = [call("read_file", { path: "../secret" }), final("done")]
    const results: string[] = []
    await runAgentIn(memoryWorkspace({}), "x", [], {
      model: async (messages) => {
        const t = messages.filter((m) => m.role === "tool").pop()
        if (t) results.push((t as { content: string }).content)
        return turns.shift()!
      },
      emit: () => {},
      decide: async () => ({ decision: "reject" }),
      signal: new AbortController().signal,
    })
    assert.match(results[0], /outside workspace/)
  })
})
