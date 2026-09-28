import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, test } from "node:test"

// Keep Kivo's real project list untouched: these tests get their own Kivo home.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "kivo-projects-"))
process.env.KIVO_HOME = home
const ws = await import("../server/workspace")
const { normalizeRepoUrl, repoName } = await import("../server/projects")

describe("projects", () => {
  test("repository inputs become git URLs, and can never be options", () => {
    assert.equal(normalizeRepoUrl("octocat/Hello-World"), "https://github.com/octocat/Hello-World.git")
    assert.equal(normalizeRepoUrl("https://github.com/a/b"), "https://github.com/a/b")
    assert.equal(normalizeRepoUrl("git@github.com:a/b.git"), "git@github.com:a/b.git")
    for (const bad of ["--upload-pack=touch /tmp/x", "-c core.sshCommand=x", "file:///etc", "a b/c", ""]) assert.throws(() => normalizeRepoUrl(bad), bad)
    assert.equal(repoName("https://github.com/a/my-repo.git"), "my-repo")
    assert.equal(repoName("git@github.com:a/b.git"), "b")
  })

  test("the demo is current until a folder is opened", async () => {
    await ws.ensureWorkspace()
    assert.equal(ws.project().kind, "demo")
    assert.ok(ws.project().managed)
    assert.ok(ws.listFiles().length > 0)
  })

  test("opening a folder makes it current, unmanaged, and scopes file access to it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kivo-proj-"))
    fs.writeFileSync(path.join(dir, "package.json"), '{"dependencies":{"react":"19"}}')
    fs.mkdirSync(path.join(dir, "node_modules/x"), { recursive: true })
    fs.writeFileSync(path.join(dir, "node_modules/x/index.js"), "")
    const p = ws.openProject(dir)
    assert.equal(ws.projectDir(), fs.realpathSync(dir))
    assert.equal(p.managed, false)
    assert.deepEqual(ws.listFiles(), ["package.json"], "dependency folders are skipped")
    assert.throws(() => ws.safePath("../outside"), /outside workspace/)
    assert.ok(ws.analyze().detections.some((d) => d.tech === "React"))
    // Re-opening doesn't duplicate it, and it's remembered on disk.
    ws.openProject(dir)
    assert.equal(ws.listProjects().filter((x) => x.dir === fs.realpathSync(dir)).length, 1)
    const saved = JSON.parse(fs.readFileSync(path.join(home, "projects.json"), "utf8"))
    assert.equal(saved.current, p.id)
  })

  test("git repositories list tracked + untracked files and honour .gitignore", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kivo-git-"))
    const { execFileSync } = await import("node:child_process")
    execFileSync("git", ["init", "-q"], { cwd: dir })
    fs.writeFileSync(path.join(dir, ".gitignore"), "secret.txt\n")
    fs.writeFileSync(path.join(dir, "a.py"), "print(1)\n")
    fs.writeFileSync(path.join(dir, "secret.txt"), "x")
    ws.openProject(dir)
    assert.deepEqual(ws.listFiles(), [".gitignore", "a.py"])
    assert.equal(ws.project().kind, "local", "no remote yet")
  })

  test("the root, the home folder and missing paths are refused", () => {
    assert.throws(() => ws.openProject("/"), /whole disk/)
    assert.throws(() => ws.openProject("~"), /home folder/)
    assert.throws(() => ws.openProject("/definitely/not/here"), /doesn't exist/)
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kivo-f-")), "f.txt")
    fs.writeFileSync(file, "")
    assert.throws(() => ws.openProject(file), /not a folder/)
  })

  test("binary files aren't opened as text", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kivo-bin-"))
    fs.writeFileSync(path.join(dir, "img.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01]))
    ws.openProject(dir)
    assert.throws(() => ws.readFile("img.bin"), /binary/)
  })

  test("switching back to the demo and forgetting a project", () => {
    const opened = ws.listProjects().find((p) => p.kind !== "demo")!
    ws.switchProject("demo")
    assert.equal(ws.project().kind, "demo")
    ws.forgetProject(opened.id)
    assert.ok(!ws.listProjects().some((p) => p.id === opened.id))
    assert.throws(() => ws.forgetProject("demo"))
  })
})
