import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { tourSteps } from "../src/shell/tour/steps"

const base = { inBrowser: false, primaryMode: "Build", software: true, aiReady: false }

describe("guided tour", () => {
  test("starts by saying what Kivo is and ends with a way forward", () => {
    const s = tourSteps(base)
    assert.equal(s[0].kind, "intro")
    assert.equal(s.at(-1)!.kind, "finish")
    assert.deepEqual(
      s.filter((x) => !x.kind).map((x) => x.id),
      ["workspace", "modes", "describe", "context", "level", "command", "project", "ai"],
    )
    for (const x of s.filter((x) => !x.kind)) assert.ok(x.targets?.length, `${x.id} spotlights something`)
    assert.equal(new Set(s.map((x) => x.id)).size, s.length)
  })

  test("speaks the workspace's language", () => {
    const data = tourSteps({ ...base, primaryMode: "Train", software: false })
    assert.equal(data.find((x) => x.id === "modes")!.points![0].label, "Train")
    const home = data.find((x) => x.id === "describe")!
    assert.deepEqual(home.targets, ["main"], "no describe box outside Software")
    assert.match(home.title, /train home/)
  })

  test("the AI and project stops match where Kivo runs", () => {
    const hosted = tourSteps({ ...base, inBrowser: true })
    assert.match(hosted.find((x) => x.id === "ai")!.body, /Groq API key — it stays in this browser/)
    assert.match(hosted.find((x) => x.id === "project")!.body, /import a public GitHub repository/)
    assert.match(tourSteps(base).find((x) => x.id === "ai")!.body, /\.env/)
    assert.equal(tourSteps({ ...base, aiReady: true }).find((x) => x.id === "ai")!.title, "AI is connected")
  })

  test("plain language: no step leans on jargon before explaining it", () => {
    const text = tourSteps(base).map((x) => `${x.title} ${x.body} ${x.points?.map((p) => p.text).join(" ") ?? ""}`).join(" ")
    for (const word of ["daemon", "endpoint", "repo ", "LLM", "IR", "codegen", "CLI"]) assert.ok(!text.includes(word), word)
  })
})
