import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { cleanPath, decodeText } from "../src/backend/fs/types"
import { parseGitHub } from "../src/backend/projects"

describe("browser backend", () => {
  test("paths stay inside the project", () => {
    assert.equal(cleanPath("src/./app.py"), "src/app.py")
    assert.equal(cleanPath("src/a/../b.py"), "src/b.py")
    assert.equal(cleanPath("src\\win.py"), "src/win.py")
    for (const bad of ["../x", "a/../../x", "/etc/passwd"]) assert.throws(() => cleanPath(bad), /outside workspace/, bad)
    assert.throws(() => cleanPath("."), /project folder itself/)
    assert.equal(cleanPath(".", { allowRoot: true }), ".")
    assert.throws(() => cleanPath(".git/config", { write: true }), /inside \.git/)
    assert.equal(cleanPath(".git/config"), ".git/config", "reading .git is fine; writing isn't")
    assert.throws(() => cleanPath("a\0b"), /NUL/)
    assert.throws(() => cleanPath(42), /non-empty string/)
  })

  test("binary and oversized files aren't opened as text", () => {
    assert.equal(decodeText(new TextEncoder().encode("héllo")), "héllo")
    assert.throws(() => decodeText(new Uint8Array([0x89, 0x50, 0, 1])), /binary/)
    assert.throws(() => decodeText(new Uint8Array(2 * 1024 * 1024 + 1)), /too large/)
  })

  test("GitHub imports accept owner/repo and github.com URLs only", () => {
    assert.deepEqual(parseGitHub("octocat/Hello-World"), { owner: "octocat", repo: "Hello-World" })
    assert.deepEqual(parseGitHub("https://github.com/octocat/Spoon-Knife.git"), { owner: "octocat", repo: "Spoon-Knife" })
    assert.deepEqual(parseGitHub("git@github.com:a/b"), { owner: "a", repo: "b" })
    for (const bad of ["https://gitlab.com/a/b", "a", "a/b/c", "https://github.com/a/b?x=1"]) assert.throws(() => parseGitHub(bad), /public GitHub repositories/, bad)
  })
})
