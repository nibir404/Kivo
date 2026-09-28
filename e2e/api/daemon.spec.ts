import { expect, test } from "@playwright/test"

/** The daemon's HTTP API: the backend every UI mode except the hosted one talks to. */

test.describe("health and guards", () => {
  test("reports the demo project, its toolchains and no AI without keys", async ({ request }) => {
    const r = await request.get("/api/health")
    expect(r.ok()).toBe(true)
    const h = await r.json()
    expect(h.project).toBe("tandem")
    expect(h.ai).toBe(false)
    expect(h.keyEditable).toBe(true)
    expect(h.providers.find((p: { id: string }) => p.id === "groq").status).toBe("unconfigured")
  })

  test("refuses other websites (Origin) and DNS rebinding (Host)", async ({ request }) => {
    const origin = await request.get("/api/health", { headers: { Origin: "https://evil.example" } })
    expect(origin.status()).toBe(403)
    const host = await request.get("/api/health", { headers: { Host: "evil.example" } })
    expect(host.status()).toBe(421)
  })

  test("serves the built UI with hardening headers", async ({ request }) => {
    const r = await request.get("/")
    expect(r.ok()).toBe(true)
    expect(await r.text()).toContain('<div id="root">')
    expect(r.headers()["content-security-policy"]).toContain("frame-ancestors 'none'")
    expect(r.headers()["x-frame-options"]).toBe("DENY")
  })
})

test.describe("files", () => {
  test("write, read back, and list", async ({ request }) => {
    const w = await request.put("/api/fs/write", { data: { path: "e2e/hello.txt", content: "hi from playwright\n" } })
    expect(w.ok()).toBe(true)
    const r = await request.get("/api/fs/read?path=e2e/hello.txt")
    expect((await r.json()).content).toBe("hi from playwright\n")
    const tree = await (await request.get("/api/fs/tree")).json()
    expect(tree.files).toContain("e2e/hello.txt")
  })

  test("paths outside the project are refused", async ({ request }) => {
    for (const p of ["../outside.txt", "/etc/passwd"]) {
      const r = await request.get(`/api/fs/read?path=${encodeURIComponent(p)}`)
      expect(r.status(), p).toBeGreaterThanOrEqual(400)
      expect(r.status(), p).toBeLessThan(500)
    }
  })

  test("editor operations: create, rename, duplicate, trash", async ({ request }) => {
    expect((await request.post("/api/editor/create", { data: { path: "e2e/ops/a.py", kind: "file" } })).ok()).toBe(true)
    expect((await request.post("/api/editor/create", { data: { path: "e2e/ops/a.py", kind: "file" } })).status()).toBe(409)
    expect((await request.post("/api/editor/rename", { data: { from: "e2e/ops/a.py", to: "e2e/ops/b.py" } })).ok()).toBe(true)
    expect((await request.post("/api/editor/duplicate", { data: { path: "e2e/ops/b.py" } })).ok()).toBe(true)
    let files: string[] = (await (await request.get("/api/fs/tree")).json()).files
    expect(files.filter((f) => f.startsWith("e2e/ops/"))).toHaveLength(2)
    for (const f of files.filter((f) => f.startsWith("e2e/ops/"))) expect((await request.post("/api/editor/trash", { data: { path: f } })).ok()).toBe(true)
    files = (await (await request.get("/api/fs/tree")).json()).files
    expect(files.some((f) => f.startsWith("e2e/ops/"))).toBe(false)
  })

  test("search across the project", async ({ request }) => {
    await request.put("/api/fs/write", { data: { path: "e2e/needle.txt", content: "a unique-needle-4242 here\n" } })
    const r = await request.post("/api/editor/search", { data: { query: "unique-needle-4242" } })
    expect(r.ok()).toBe(true)
    expect(JSON.stringify(await r.json())).toContain("e2e/needle.txt")
  })
})

test.describe("AI settings", () => {
  test("a malformed key is refused before anything is saved or sent", async ({ request }) => {
    const r = await request.post("/api/settings/key", { data: { key: "not a key" } })
    expect(r.status()).toBe(400)
    expect((await r.json()).error).toMatch(/doesn't look like an API key/)
    const h = await (await request.get("/api/health")).json()
    expect(h.ai).toBe(false)
  })

  test("AI routes answer 503 with a reason when no provider is connected", async ({ request }) => {
    const r = await request.post("/api/ai/intent", { data: { text: "a todo list" } })
    expect(r.status()).toBe(503)
    expect((await r.json()).error).toBeTruthy()
  })
})
