import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { buildMatcher, findInText, globToRegExp, replaceInText } from "../src/match"

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
