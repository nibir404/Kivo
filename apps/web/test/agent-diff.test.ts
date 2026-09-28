import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { diffStats, hunks, lineDiff } from "../src/features/agent/diff"

describe("diff", () => {
  test("line diff and hunks", () => {
    const d = lineDiff("a\nb\nc\nd\ne\nf\ng\nh\ni\nj", "a\nb\nc\nd\nE\nf\ng\nh\ni\nj")
    assert.deepEqual(diffStats(d), { added: 1, removed: 1 })
    const h = hunks(d, 1)
    assert.equal(h[0].type, "gap")
    assert.deepEqual(
      h.filter((l) => l.type !== "gap").map((l) => (l as { text: string }).text),
      ["d", "e", "E", "f"],
    )
  })
  test("new file is all additions", () => {
    assert.deepEqual(diffStats(lineDiff("", "x\ny")), { added: 2, removed: 0 })
  })
})
