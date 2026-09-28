import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, describe, test } from "node:test"
import { HttpError } from "../server/http"
import {
  branches,
  checkBranchName,
  checkout,
  cleanCommitMessage,
  commit,
  commitContext,
  createBranch,
  diffContent,
  discard,
  explainRemoteError,
  init,
  log,
  parseStatus,
  remoteOp,
  showCommit,
  stage,
  status,
  unstage,
  type RepoStatus,
} from "../server/scm"

// Throwaway repositories, each with a local identity so the user's global config is irrelevant.
const ROOT = fs.mkdtempSync(path.join(process.env.KIVO_TEST_TMP ?? os.tmpdir(), "kivo-scm-"))
after(() => fs.rmSync(ROOT, { recursive: true, force: true }))

let n = 0
const sh = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
function repo(opts: { commit?: boolean } = {}) {
  const dir = path.join(ROOT, `r${n++}`)
  fs.mkdirSync(dir)
  sh(dir, "init", "-q", "-b", "main")
  sh(dir, "config", "user.name", "Test")
  sh(dir, "config", "user.email", "test@example.com")
  sh(dir, "config", "commit.gpgsign", "false")
  if (opts.commit !== false) {
    write(dir, "a.txt", "one\n")
    write(dir, "src/b.py", "print('b')\n")
    sh(dir, "add", "-A")
    sh(dir, "commit", "-q", "-m", "initial")
  }
  return dir
}
const write = (dir: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
  fs.writeFileSync(path.join(dir, rel), text)
}
const st = async (dir: string) => {
  const s = await status(dir)
  assert.ok(s.repo)
  return s as RepoStatus
}
const paths = (list: { path: string; status: string }[]) => list.map((f) => `${f.status} ${f.path}`).sort()

describe("status parsing", () => {
  test("porcelain v2 records, including renames and paths with spaces", () => {
    const raw = [
      "# branch.oid 0123456789abcdef0123456789abcdef01234567",
      "# branch.head feature/x",
      "# branch.upstream origin/feature/x",
      "# branch.ab +2 -1",
      "1 M. N... 100644 100644 100644 aaa bbb staged only.txt",
      "1 .M N... 100644 100644 100644 aaa aaa work.txt",
      "2 R. N... 100644 100644 100644 aaa aaa R100 new name.txt",
      "old name.txt",
      "u UU N... 100644 100644 100644 100644 a b c both.txt",
      "? fresh.txt",
      "",
    ].join("\0")
    const s = parseStatus(raw)
    assert.equal(s.branch, "feature/x")
    assert.equal(s.upstream, "origin/feature/x")
    assert.deepEqual([s.ahead, s.behind], [2, 1])
    assert.deepEqual(paths(s.staged), ["M staged only.txt", "R new name.txt"])
    assert.equal(s.staged.find((f) => f.status === "R")?.orig, "old name.txt")
    assert.deepEqual(paths(s.unstaged), ["M work.txt"])
    assert.deepEqual(paths(s.conflicted), ["U both.txt"])
    assert.deepEqual(paths(s.untracked), ["? fresh.txt"])
  })

  test("detached HEAD and a repository with no commits", () => {
    assert.equal(parseStatus("# branch.oid abc\0# branch.head (detached)\0").detached, true)
    const empty = parseStatus("# branch.oid (initial)\0# branch.head main\0")
    assert.equal(empty.oid, null)
    assert.equal(empty.branch, "main")
  })
})

describe("working with a real repository", () => {
  test("staged, unstaged, untracked and renamed files", async () => {
    const dir = repo()
    write(dir, "a.txt", "two\n")
    write(dir, "new/c.txt", "c\n")
    sh(dir, "mv", "src/b.py", "src/renamed.py")
    const s = await st(dir)
    assert.equal(s.branch, "main")
    assert.deepEqual(paths(s.unstaged), ["M a.txt"])
    assert.deepEqual(paths(s.untracked), ["? new/c.txt"])
    assert.deepEqual(paths(s.staged), ["R src/renamed.py"])
    assert.equal(s.staged[0].orig, "src/b.py")
  })

  test("stage, unstage, stage all, unstage all", async () => {
    const dir = repo()
    write(dir, "a.txt", "two\n")
    write(dir, "d.txt", "d\n")
    fs.rmSync(path.join(dir, "src/b.py"))
    await stage(dir, ["a.txt"])
    assert.deepEqual(paths((await st(dir)).staged), ["M a.txt"])
    await unstage(dir, ["a.txt"])
    assert.deepEqual((await st(dir)).staged, [])
    await stage(dir, "all")
    assert.deepEqual(paths((await st(dir)).staged), ["A d.txt", "D src/b.py", "M a.txt"])
    await unstage(dir, "all")
    const s = await st(dir)
    assert.deepEqual(s.staged, [])
    assert.deepEqual(paths(s.untracked), ["? d.txt"])
  })

  test("unstaging before the first commit", async () => {
    const dir = repo({ commit: false })
    write(dir, "x.txt", "x\n")
    await stage(dir, ["x.txt"])
    assert.deepEqual(paths((await st(dir)).staged), ["A x.txt"])
    await unstage(dir, ["x.txt"])
    const s = await st(dir)
    assert.deepEqual(s.staged, [])
    assert.deepEqual(paths(s.untracked), ["? x.txt"])
  })

  test("paths outside the repository are refused", async () => {
    const dir = repo()
    await assert.rejects(stage(dir, ["../escape.txt"]), (e: unknown) => e instanceof HttpError && e.status === 403)
    await assert.rejects(diffContent(dir, "working", "../../etc/passwd"), (e: unknown) => e instanceof HttpError && e.status === 403)
  })

  test("commit staged, and 'stage all & commit' when nothing is staged", async () => {
    const dir = repo()
    write(dir, "a.txt", "two\n")
    await assert.rejects(commit(dir, "msg"), /Nothing is staged/)
    await assert.rejects(commit(dir, "  ", { all: true }), /commit message/)
    const { hash } = await commit(dir, "feat: change a", { all: true })
    assert.match(hash, /^[0-9a-f]{40}$/)
    const s = await st(dir)
    assert.deepEqual([s.staged, s.unstaged, s.untracked], [[], [], []])
    const commits = await log(dir)
    assert.deepEqual(
      commits.map((c) => c.subject),
      ["feat: change a", "initial"],
    )
    await assert.rejects(commit(dir, "again", { all: true }), /no changes/)
  })

  test("first commit in an empty repository", async () => {
    const dir = repo({ commit: false })
    assert.deepEqual(await log(dir), [])
    assert.equal((await st(dir)).oid, null)
    write(dir, "readme.md", "# hi\n")
    await commit(dir, "chore: first", { all: true })
    assert.equal((await log(dir)).length, 1)
  })

  test("discard: tracked files are restored, untracked files go to the trash", async () => {
    const dir = repo()
    const trash = path.join(ROOT, `trash${n++}`)
    fs.mkdirSync(trash)
    write(dir, "a.txt", "changed\n")
    write(dir, "junk.txt", "junk\n")
    const result = await discard(dir, ["a.txt", "junk.txt"], { trashDir: trash })
    assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "one\n")
    assert.equal(fs.existsSync(path.join(dir, "junk.txt")), false)
    assert.deepEqual(fs.readdirSync(trash), ["junk.txt"])
    assert.deepEqual(result.restored, ["a.txt"])
    // Without a usable trash, untracked files are refused rather than deleted.
    write(dir, "keep.txt", "k\n")
    await assert.rejects(discard(dir, ["keep.txt"], { trashDir: null }), /Trash/)
    assert.ok(fs.existsSync(path.join(dir, "keep.txt")))
  })

  test("branches: create (validated), list, checkout", async () => {
    const dir = repo()
    assert.equal(await checkBranchName(dir, "feature/login"), "feature/login")
    for (const bad of ["has space", "a..b", "-rf", "end.lock", "x~1", ""]) await assert.rejects(checkBranchName(dir, bad), (e: unknown) => e instanceof HttpError && e.status === 400, bad)
    await createBranch(dir, "feature/login")
    assert.equal((await st(dir)).branch, "feature/login")
    await assert.rejects(createBranch(dir, "main"), /already exists/)
    const list = await branches(dir)
    assert.deepEqual(list.filter((b) => !b.remote).map((b) => b.name).sort(), ["feature/login", "main"])
    assert.equal(list.find((b) => b.current)?.name, "feature/login")
    await checkout(dir, "main")
    assert.equal((await st(dir)).branch, "main")
    await assert.rejects(checkout(dir, "nope"), /no branch/)
  })

  test("checkout carries local changes but git refuses to overwrite them", async () => {
    const dir = repo()
    await createBranch(dir, "other")
    write(dir, "a.txt", "on other\n")
    await commit(dir, "other a", { all: true })
    await checkout(dir, "main")
    write(dir, "a.txt", "local edit\n")
    await assert.rejects(checkout(dir, "other"), /overwritten/)
    assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "local edit\n")
    assert.equal((await st(dir)).branch, "main")
  })

  test("branch list in a repository with no commits", async () => {
    const dir = repo({ commit: false })
    const list = await branches(dir)
    assert.deepEqual(list.map((b) => [b.name, b.current]), [["main", true]])
  })
})

describe("diff content", () => {
  test("working tree vs index, staged vs HEAD", async () => {
    const dir = repo()
    write(dir, "a.txt", "staged\n")
    await stage(dir, ["a.txt"])
    write(dir, "a.txt", "working\n")
    const w = await diffContent(dir, "working", "a.txt")
    assert.deepEqual([w.original, w.modified, w.editable], ["staged\n", "working\n", true])
    const s = await diffContent(dir, "staged", "a.txt")
    assert.deepEqual([s.original, s.modified, s.editable], ["one\n", "staged\n", false])
  })

  test("new, deleted and renamed files", async () => {
    const dir = repo()
    write(dir, "new.txt", "fresh\n")
    const untracked = await diffContent(dir, "working", "new.txt")
    assert.deepEqual([untracked.original, untracked.modified], ["", "fresh\n"])
    await stage(dir, ["new.txt"])
    const added = await diffContent(dir, "staged", "new.txt")
    assert.deepEqual([added.original, added.modified], ["", "fresh\n"])
    fs.rmSync(path.join(dir, "a.txt"))
    const deleted = await diffContent(dir, "working", "a.txt")
    assert.deepEqual([deleted.original, deleted.modified, deleted.editable], ["one\n", "", false])
    sh(dir, "mv", "src/b.py", "src/c.py")
    const renamed = await diffContent(dir, "staged", "src/c.py")
    assert.deepEqual([renamed.originalPath, renamed.original, renamed.modified], ["src/b.py", "print('b')\n", "print('b')\n"])
  })

  test("staged new file in a repository with no commits", async () => {
    const dir = repo({ commit: false })
    write(dir, "x.txt", "x\n")
    await stage(dir, "all")
    const d = await diffContent(dir, "staged", "x.txt")
    assert.deepEqual([d.original, d.modified], ["", "x\n"])
  })

  test("binary files are flagged, not dumped", async () => {
    const dir = repo()
    fs.writeFileSync(path.join(dir, "img.bin"), Buffer.from([0, 1, 2, 3]))
    const d = await diffContent(dir, "working", "img.bin")
    assert.equal(d.binary, true)
    assert.equal(d.modified, "")
    assert.equal(d.editable, false)
  })

  test("commits: files changed and each file against the parent", async () => {
    const dir = repo()
    write(dir, "a.txt", "two\n")
    sh(dir, "mv", "src/b.py", "src/moved.py")
    write(dir, "added.txt", "added\n")
    // Something is already staged (the rename), so commit only takes what's staged: stage the rest.
    await stage(dir, "all")
    const { hash } = await commit(dir, "second")
    const c = await showCommit(dir, hash)
    assert.equal(c.subject, "second")
    assert.deepEqual(paths(c.files), ["A added.txt", "M a.txt", "R src/moved.py"])
    const a = await diffContent(dir, "commit", "a.txt", hash)
    assert.deepEqual([a.original, a.modified], ["one\n", "two\n"])
    const moved = await diffContent(dir, "commit", "src/moved.py", hash)
    assert.equal(moved.originalPath, "src/b.py")
    assert.equal(moved.original, "print('b')\n")
    // The root commit has no parent: everything is an addition.
    const root = (await log(dir)).at(-1)!
    const first = await showCommit(dir, root.hash)
    assert.deepEqual(paths(first.files), ["A a.txt", "A src/b.py"])
    assert.equal((await diffContent(dir, "commit", "a.txt", root.hash)).original, "")
    await assert.rejects(showCommit(dir, "not-a-hash; rm"), (e: unknown) => e instanceof HttpError && e.status === 400)
  })

  test("merge conflicts show under conflicts and diff against 'ours'", async () => {
    const dir = repo()
    await createBranch(dir, "theirs")
    write(dir, "a.txt", "theirs\n")
    await commit(dir, "theirs", { all: true })
    await checkout(dir, "main")
    write(dir, "a.txt", "ours\n")
    await commit(dir, "ours", { all: true })
    assert.throws(() => sh(dir, "merge", "theirs"))
    const s = await st(dir)
    assert.deepEqual(paths(s.conflicted), ["U a.txt"])
    assert.equal(s.conflicted[0].code, "UU")
    const d = await diffContent(dir, "working", "a.txt")
    assert.equal(d.original, "ours\n")
    assert.match(d.modified, /<<<<<<<[\s\S]*>>>>>>>/)
    await assert.rejects(discard(dir, ["a.txt"]), /conflict/)
    await assert.rejects(commit(dir, "x"), /conflicts/)
  })
})

describe("non-repositories", () => {
  test("status says so, other actions refuse, init makes a repository", async () => {
    const dir = path.join(ROOT, `plain${n++}`)
    fs.mkdirSync(dir)
    assert.deepEqual(await status(dir), { repo: false })
    await assert.rejects(stage(dir, "all"), (e: unknown) => e instanceof HttpError && e.status === 409)
    await assert.rejects(log(dir), (e: unknown) => e instanceof HttpError && e.status === 409)
    await init(dir)
    const s = await status(dir)
    assert.equal(s.repo, true)
    await assert.rejects(init(dir), /already/)
  })
})

describe("remotes", () => {
  test("publish sets the upstream, then pull and push over a local bare remote", async () => {
    const bare = path.join(ROOT, `bare${n++}.git`)
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare])
    const dir = repo()
    await assert.rejects(remoteOp(dir, "push", () => {}), /no remote/)
    sh(dir, "remote", "add", "origin", bare)
    const lines: string[] = []
    await remoteOp(dir, "sync", (l) => lines.push(l))
    assert.ok(lines.some((l) => l.includes("Publishing main")))
    let s = await st(dir)
    assert.equal(s.upstream, "origin/main")
    // A second clone pushes a commit; sync here pulls it in, then pushes our own.
    const other = path.join(ROOT, `clone${n++}`)
    execFileSync("git", ["clone", "-q", bare, other])
    sh(other, "config", "user.name", "Other")
    sh(other, "config", "user.email", "o@example.com")
    write(other, "theirs.txt", "t\n")
    sh(other, "add", "-A")
    sh(other, "commit", "-q", "-m", "theirs")
    sh(other, "push", "-q")
    await remoteOp(dir, "fetch", () => {})
    s = await st(dir)
    assert.equal(s.behind, 1)
    write(dir, "ours.txt", "o\n")
    await commit(dir, "ours", { all: true })
    sh(dir, "config", "pull.rebase", "false")
    await remoteOp(dir, "sync", () => {})
    s = await st(dir)
    assert.deepEqual([s.ahead, s.behind], [0, 0])
    assert.ok(fs.existsSync(path.join(dir, "theirs.txt")))
  })

  test("network and auth failures become advice", () => {
    assert.match(explainRemoteError("fatal: could not read Username for 'https://github.com': terminal prompts disabled")!, /gh auth login/)
    assert.match(explainRemoteError("git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.")!, /SSH/)
    assert.match(explainRemoteError(" ! [rejected] main -> main (fetch first)")!, /Pull first/)
    assert.equal(explainRemoteError("something else"), null)
  })
})

describe("AI commit message", () => {
  test("context prefers the staged diff and is kept small", async () => {
    const dir = repo()
    write(dir, "a.txt", "x\n".repeat(10_000))
    write(dir, "src/b.py", "print('staged')\n")
    await stage(dir, ["src/b.py"])
    const staged = await commitContext(dir)
    assert.match(staged, /staged/)
    assert.match(staged, /src\/b\.py/)
    assert.doesNotMatch(staged, /a\.txt/)
    await unstage(dir, "all")
    const all = await commitContext(dir)
    assert.match(all, /not staged yet/)
    assert.ok(all.length < 8000, `context is ${all.length} chars`)
    assert.match(all, /truncated/)
  })

  test("model output is cleaned up", () => {
    assert.equal(cleanCommitMessage("```\nfeat: add x\n```"), "feat: add x")
    assert.equal(cleanCommitMessage('Commit message: "fix: y"'), "fix: y")
  })
})
