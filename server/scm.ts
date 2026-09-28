import { execFile, spawn } from "node:child_process"
import fs from "node:fs"
import type http from "node:http"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { aiAvailable, stream } from "./ai"
import { bus } from "./bus"
import { HttpError, json, readJson, requireString, sse } from "./http"
import { project, projectDir, safePath } from "./workspace"

/**
 * Source control over real git, VS Code style. Everything below the HTTP handler takes the
 * repository directory explicitly, so it can be tested against throwaway repos and never caches
 * the current project (which can change at runtime).
 *
 * Safety: git is only ever run via execFile/spawn with argument arrays and `--` before paths;
 * nothing here forces, hard-resets or cleans. Discarding untracked files moves them to the Trash.
 */

const run = promisify(execFile)
const MAX_TEXT = 2 * 1024 * 1024
const NET_TIMEOUT = 120_000

export interface FileChange {
  path: string
  /** Where a rename/copy came from. */
  orig?: string
  /** One letter for the UI: M A D R C T for changes, U for a conflict, ? for untracked. */
  status: string
  /** The raw two-letter porcelain code (e.g. "UU" = both modified), for tooltips. */
  code: string
}

export interface RepoStatus {
  repo: true
  branch: string | null
  detached: boolean
  /** null while the repository has no commits yet. */
  oid: string | null
  upstream: string | null
  ahead: number
  behind: number
  staged: FileChange[]
  unstaged: FileChange[]
  untracked: FileChange[]
  conflicted: FileChange[]
}

export type StatusResult = RepoStatus | { repo: false }

function gitEnv(extra: Record<string, string> = {}) {
  // No prompt can ever be answered from here: fail fast instead of hanging on a password or passphrase.
  return { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes", ...extra }
}

/** Only Kivo's managed demo commits as "Kivo"; the user's own repos use their identity. */
function identity(dir: string) {
  const p = project()
  return p.managed && path.resolve(p.dir) === path.resolve(dir) ? ["-c", "user.name=Kivo", "-c", "user.email=kivo@localhost"] : []
}

/** git's own error text, minus hints and the "fatal:" noise, so it reads as a sentence in a toast. */
function gitMessage(err: unknown) {
  const e = err as { stderr?: string | Buffer; message?: string }
  const text = String(e.stderr || e.message || err)
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("hint:") && !l.startsWith("Command failed:"))
    .map((l) => l.replace(/^(fatal|error): /, ""))
  return lines.join("\n") || "git failed"
}

async function git(dir: string, args: string[], timeout = 30_000) {
  try {
    const { stdout } = await run("git", [...identity(dir), ...args], { cwd: dir, maxBuffer: 64 * 1024 * 1024, timeout, env: gitEnv() })
    return stdout
  } catch (err) {
    throw new HttpError(400, gitMessage(err))
  }
}

/** Like git(), but null instead of an error (for "does this blob exist?" questions). */
async function gitBuffer(dir: string, args: string[]): Promise<Buffer | null> {
  try {
    const { stdout } = await run("git", args, { cwd: dir, encoding: "buffer", maxBuffer: 64 * 1024 * 1024, timeout: 30_000, env: gitEnv() })
    return stdout
  } catch {
    return null
  }
}

/** Is `dir` itself a repository root? (A folder nested inside some other repo is not treated as one.) */
export const isRepo = (dir: string) => fs.existsSync(path.join(dir, ".git"))

function requireRepo(dir: string) {
  if (!isRepo(dir)) throw new HttpError(409, "This project isn't a git repository yet")
}

/** Refuse paths that escape the repository (the HTTP layer also runs them through safePath). */
function checkPaths(dir: string, paths: string[]) {
  for (const p of paths) {
    const abs = path.resolve(dir, p)
    if (!p || abs === path.resolve(dir) || !abs.startsWith(path.resolve(dir) + path.sep)) throw new HttpError(403, `Path outside the repository: ${p}`)
  }
  return paths
}

const REF = /^[0-9a-f]{4,64}$/i

// ─── Status ────────────────────────────────────────────────────────────────

/** Parse `git status --porcelain=v2 --branch -z`. */
export function parseStatus(raw: string): RepoStatus {
  const s: RepoStatus = { repo: true, branch: null, detached: false, oid: null, upstream: null, ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [], conflicted: [] }
  const parts = raw.split("\0")
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i]
    if (!line) continue
    if (line.startsWith("# ")) {
      const [, key, ...rest] = line.split(" ")
      const value = rest.join(" ")
      if (key === "branch.oid") s.oid = value === "(initial)" ? null : value
      else if (key === "branch.head") {
        s.detached = value === "(detached)"
        s.branch = s.detached ? null : value
      } else if (key === "branch.upstream") s.upstream = value
      else if (key === "branch.ab") {
        const m = /^\+(\d+) -(\d+)$/.exec(value)
        if (m) [s.ahead, s.behind] = [Number(m[1]), Number(m[2])]
      }
      continue
    }
    const kind = line[0]
    if (kind === "?") {
      s.untracked.push({ path: line.slice(2), status: "?", code: "??" })
      continue
    }
    if (kind === "!") continue
    // Fields are space-separated up to the path, which may itself contain spaces.
    const fieldCount = kind === "1" ? 8 : kind === "2" ? 9 : kind === "u" ? 10 : 0
    if (!fieldCount) continue
    const fields = line.split(" ")
    const code = fields[1]
    const file = fields.slice(fieldCount).join(" ")
    if (kind === "u") {
      s.conflicted.push({ path: file, status: "U", code })
      continue
    }
    const orig = kind === "2" ? parts[++i] : undefined
    const [x, y] = code
    if (x !== ".") s.staged.push({ path: file, orig, status: x, code })
    if (y !== ".") s.unstaged.push({ path: file, status: y, code })
  }
  return s
}

export async function status(dir: string): Promise<StatusResult> {
  if (!isRepo(dir)) return { repo: false }
  // --no-optional-locks: a background refresh must never hold index.lock while the user commits.
  const raw = await git(dir, ["--no-optional-locks", "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"])
  return parseStatus(raw)
}

// ─── Diff content ───────────────────────────────────────────────────────────

export type DiffKind = "working" | "staged" | "commit"

export interface DiffContent {
  path: string
  originalPath?: string
  original: string
  modified: string
  binary?: boolean
  tooLarge?: boolean
  /** The modified side is the file on disk (so the diff editor may edit and save it). */
  editable: boolean
  /** Labels for the two sides. */
  originalLabel: string
  modifiedLabel: string
}

function asText(buf: Buffer | null) {
  if (!buf) return { text: "" }
  if (buf.length > MAX_TEXT) return { text: "", tooLarge: true }
  if (buf.subarray(0, 8192).includes(0)) return { text: "", binary: true }
  return { text: buf.toString("utf8") }
}

const blob = (dir: string, spec: string) => gitBuffer(dir, ["cat-file", "blob", spec])

async function parentOf(dir: string, ref: string) {
  const line = (await git(dir, ["rev-list", "--parents", "-n", "1", ref, "--"])).trim().split(" ")
  return { hash: line[0], parent: line[1] as string | undefined }
}

/** The two sides of a diff: working tree vs index, index vs HEAD, or a commit vs its first parent. */
export async function diffContent(dir: string, kind: DiffKind, file: string, ref?: string): Promise<DiffContent> {
  requireRepo(dir)
  checkPaths(dir, [file])
  let originalPath: string | undefined
  let orig: Buffer | null = null
  let mod: Buffer | null = null
  let originalLabel = ""
  let modifiedLabel = ""
  let editable = false

  if (kind === "commit") {
    if (!ref || !REF.test(ref)) throw new HttpError(400, "A commit hash is required")
    const { hash, parent } = await parentOf(dir, ref)
    if (parent) {
      // Find a rename source, which a pathspec-limited diff can't see.
      const files = await commitFiles(dir, hash, parent)
      originalPath = files.find((f) => f.path === file)?.orig
      orig = await blob(dir, `${parent}:${originalPath ?? file}`)
    }
    mod = await blob(dir, `${hash}:${file}`)
    originalLabel = parent ? parent.slice(0, 7) : "(root)"
    modifiedLabel = hash.slice(0, 7)
  } else {
    const st = await status(dir)
    if (!st.repo) throw new HttpError(409, "This project isn't a git repository yet")
    if (kind === "staged") {
      originalPath = st.staged.find((f) => f.path === file)?.orig
      orig = st.oid ? await blob(dir, `HEAD:${originalPath ?? file}`) : null
      mod = await blob(dir, `:${file}`)
      originalLabel = "HEAD"
      modifiedLabel = "Staged"
    } else {
      const conflicted = st.conflicted.some((f) => f.path === file)
      // A conflicted path has no stage-0 entry; compare against "ours".
      orig = conflicted ? ((await blob(dir, `:2:${file}`)) ?? (st.oid ? await blob(dir, `HEAD:${file}`) : null)) : await blob(dir, `:${file}`)
      const abs = path.join(dir, file)
      const stat = fs.statSync(abs, { throwIfNoEntry: false })
      if (stat?.isFile()) {
        mod = stat.size > MAX_TEXT ? Buffer.alloc(MAX_TEXT + 1) : fs.readFileSync(abs)
        editable = true
      }
      originalLabel = conflicted ? "Ours" : "Index"
      modifiedLabel = "Working Tree"
    }
  }

  const a = asText(orig)
  const b = asText(mod)
  const binary = a.binary || b.binary
  const tooLarge = a.tooLarge || b.tooLarge
  return {
    path: file,
    originalPath,
    original: a.text,
    modified: b.text,
    binary: binary || undefined,
    tooLarge: tooLarge || undefined,
    editable: editable && !binary && !tooLarge,
    originalLabel,
    modifiedLabel,
  }
}

// ─── Stage / unstage / discard ─────────────────────────────────────────────

export async function stage(dir: string, paths: string[] | "all") {
  requireRepo(dir)
  // -A so deletions are staged too.
  if (paths === "all") await git(dir, ["add", "-A"])
  else if (paths.length) await git(dir, ["add", "-A", "--", ...checkPaths(dir, paths)])
}

async function hasHead(dir: string) {
  return (await gitBuffer(dir, ["rev-parse", "--verify", "-q", "HEAD"])) !== null
}

export async function unstage(dir: string, paths: string[] | "all") {
  requireRepo(dir)
  if (paths !== "all" && !paths.length) return
  const spec = paths === "all" ? ["."] : checkPaths(dir, paths)
  // Before the first commit there's no HEAD to restore from: unstaging means removing from the index.
  if (await hasHead(dir)) await git(dir, ["restore", "--staged", "--", ...spec])
  else await git(dir, ["rm", "--cached", "-r", "-q", "--ignore-unmatch", "--", ...spec])
}

/** The Trash, only where a plain rename into it is how the OS does it (macOS). */
function defaultTrash() {
  return process.platform === "darwin" ? path.join(os.homedir(), ".Trash") : null
}

function moveToTrash(abs: string, trashDir: string | null) {
  if (!trashDir || !fs.existsSync(trashDir)) throw new HttpError(400, "Kivo can only move untracked files to the Trash on macOS — delete it yourself if you're sure")
  const base = path.basename(abs)
  let target = path.join(trashDir, base)
  for (let n = 2; fs.existsSync(target); n++) target = path.join(trashDir, `${base} ${n}`)
  try {
    fs.renameSync(abs, target)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    throw new HttpError(400, code === "EXDEV" ? `${base} is on another disk, so it can't be moved to the Trash — delete it yourself if you're sure` : `Couldn't move ${base} to the Trash: ${(err as Error).message}`)
  }
  return target
}

/**
 * Throw away working-tree changes: tracked files are restored from the index, untracked files go
 * to the Trash (recoverable). Conflicts are refused — resolve those in the editor.
 */
export async function discard(dir: string, paths: string[], opts: { trashDir?: string | null } = {}) {
  const st = await status(dir)
  if (!st.repo) throw new HttpError(409, "This project isn't a git repository yet")
  checkPaths(dir, paths)
  const untracked = new Set(st.untracked.map((f) => f.path))
  const conflicted = new Set(st.conflicted.map((f) => f.path))
  const bad = paths.find((p) => conflicted.has(p))
  if (bad) throw new HttpError(409, `${bad} has a merge conflict — resolve it instead of discarding`)
  const tracked = paths.filter((p) => !untracked.has(p))
  if (tracked.length) await git(dir, ["restore", "--worktree", "--", ...tracked])
  const trashDir = opts.trashDir === undefined ? defaultTrash() : opts.trashDir
  const trashed: string[] = []
  for (const p of paths.filter((x) => untracked.has(x))) trashed.push(moveToTrash(path.join(dir, p), trashDir))
  return { restored: tracked, trashed }
}

// ─── Commit ────────────────────────────────────────────────────────────────

export async function commit(dir: string, message: string, opts: { all?: boolean } = {}) {
  const st = await status(dir)
  if (!st.repo) throw new HttpError(409, "This project isn't a git repository yet")
  if (!message.trim()) throw new HttpError(400, "Write a commit message first")
  if (!st.staged.length) {
    if (st.conflicted.length) throw new HttpError(409, "Resolve the merge conflicts (and stage the files) before committing")
    if (!opts.all) throw new HttpError(400, "Nothing is staged")
    if (!st.unstaged.length && !st.untracked.length) throw new HttpError(400, "There are no changes to commit")
    await stage(dir, "all")
  }
  try {
    await run("git", [...identity(dir), "commit", "-q", "-m", message], { cwd: dir, timeout: 60_000, env: gitEnv() })
  } catch (err) {
    const msg = gitMessage(err)
    if (/tell me who you are|unable to auto-detect email/i.test(msg)) {
      throw new HttpError(400, 'git doesn\'t know who you are yet. In a terminal run: git config --global user.name "Your Name" && git config --global user.email you@example.com')
    }
    throw new HttpError(400, msg)
  }
  return { hash: (await git(dir, ["rev-parse", "HEAD"])).trim() }
}

// ─── Branches ──────────────────────────────────────────────────────────────

export interface Branch {
  name: string
  remote: boolean
  current: boolean
  hash: string
  upstream?: string
  date: string
}

export async function branches(dir: string): Promise<Branch[]> {
  requireRepo(dir)
  const out = await git(dir, ["for-each-ref", "--sort=-committerdate", "--format=%(refname)%00%(refname:short)%00%(objectname:short)%00%(upstream:short)%00%(committerdate:relative)%00%(HEAD)", "refs/heads", "refs/remotes"])
  const list: Branch[] = []
  for (const line of out.split("\n")) {
    if (!line) continue
    const [ref, name, hash, upstream, date, head] = line.split("\0")
    if (ref.startsWith("refs/remotes/") && ref.endsWith("/HEAD")) continue
    list.push({ name, remote: ref.startsWith("refs/remotes/"), current: head === "*", hash, upstream: upstream || undefined, date })
  }
  // An unborn branch (no commits yet) has no ref, but it is still the current branch.
  const st = await status(dir)
  if (st.repo && st.branch && !list.some((b) => !b.remote && b.name === st.branch)) list.unshift({ name: st.branch, remote: false, current: true, hash: "", date: "" })
  return list
}

/** Validate (and normalise) a new branch name the way git itself does. */
export async function checkBranchName(dir: string, name: string) {
  const n = name.trim()
  if (!n || n.startsWith("-")) throw new HttpError(400, "That isn't a valid branch name")
  try {
    const { stdout } = await run("git", ["check-ref-format", "--branch", n], { cwd: dir, timeout: 5000, env: gitEnv() })
    return stdout.trim()
  } catch {
    throw new HttpError(400, `"${n}" isn't a valid branch name (no spaces, "..", "~", "^", ":", "?", "*", "[" or trailing "/" / ".lock")`)
  }
}

/** Switch branches. Local changes travel along; git itself refuses if they'd be overwritten. */
export async function checkout(dir: string, name: string) {
  requireRepo(dir)
  if (!name || name.startsWith("-")) throw new HttpError(400, "That isn't a valid branch name")
  const all = await branches(dir)
  const target = all.find((b) => b.name === name)
  if (!target) throw new HttpError(404, `There's no branch called ${name}`)
  if (!target.remote) return void (await git(dir, ["switch", "--no-guess", name]))
  // A remote branch: switch to its local twin, creating a tracking branch if there isn't one.
  const local = name.slice(name.indexOf("/") + 1)
  if (all.some((b) => !b.remote && b.name === local)) await git(dir, ["switch", "--no-guess", local])
  else await git(dir, ["switch", "--track", name])
}

export async function createBranch(dir: string, name: string, opts: { checkout?: boolean } = {}) {
  requireRepo(dir)
  const n = await checkBranchName(dir, name)
  if ((await branches(dir)).some((b) => !b.remote && b.name === n)) throw new HttpError(409, `A branch called ${n} already exists`)
  if (opts.checkout === false) await git(dir, ["branch", "--", n])
  else await git(dir, ["switch", "-c", n])
  return n
}

// ─── History ───────────────────────────────────────────────────────────────

export interface Commit {
  hash: string
  short: string
  subject: string
  author: string
  date: string
}

export async function log(dir: string, limit = 50): Promise<Commit[]> {
  requireRepo(dir)
  if (!(await hasHead(dir))) return []
  const out = await git(dir, ["log", `-n${limit}`, "--format=%H%x1f%h%x1f%s%x1f%an%x1f%ar%x1e", "--"])
  return out
    .split("\x1e")
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [hash, short, subject, author, date] = r.split("\x1f")
      return { hash, short, subject, author, date }
    })
}

async function commitFiles(dir: string, hash: string, parent?: string): Promise<FileChange[]> {
  const args = parent ? ["diff-tree", "-r", "-M", "--name-status", "-z", parent, hash, "--"] : ["diff-tree", "-r", "--root", "-M", "--name-status", "-z", "--no-commit-id", hash, "--"]
  const parts = (await git(dir, args)).split("\0")
  const files: FileChange[] = []
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i]
    if (!code) continue
    const letter = code[0]
    if (letter === "R" || letter === "C") {
      const orig = parts[++i]
      files.push({ path: parts[++i], orig, status: letter, code })
    } else files.push({ path: parts[++i], status: letter, code })
  }
  return files.filter((f) => f.path)
}

/** A commit's details and the files it changed (merges: against the first parent). */
export async function showCommit(dir: string, ref: string) {
  requireRepo(dir)
  if (!REF.test(ref)) throw new HttpError(400, "A commit hash is required")
  const { hash, parent } = await parentOf(dir, ref)
  const [meta] = (await git(dir, ["show", "-s", "--format=%H%x1f%h%x1f%s%x1f%an%x1f%ar%x1f%b", hash, "--"])).split("\x1e")
  const [, short, subject, author, date, body] = meta.split("\x1f")
  return { hash, short, subject, author, date, body: (body ?? "").trim(), parent, files: await commitFiles(dir, hash, parent) }
}

export async function init(dir: string) {
  if (isRepo(dir)) throw new HttpError(409, "This project is already a git repository")
  await git(dir, ["init", "-q"])
}

// ─── Fetch / pull / push ───────────────────────────────────────────────────

export type RemoteOp = "fetch" | "pull" | "push" | "sync"

/** Turn git's network failures into advice. */
export function explainRemoteError(text: string) {
  if (/permission denied \(publickey\)|host key verification failed|could not read from remote repository/i.test(text) && /ssh|publickey|host key/i.test(text)) {
    return "SSH authentication failed. Check that your SSH key is added to your Git host and loaded (ssh-add), then try again."
  }
  if (/authentication failed|could not read username|terminal prompts disabled|invalid username or password|403|401/i.test(text)) {
    return "Authentication failed. Sign in once from a terminal (for GitHub: gh auth login) or set up SSH keys, then try again."
  }
  if (/repository not found|does not appear to be a git repository/i.test(text)) return "The remote repository wasn't found, or you don't have access to it."
  if (/could not resolve host|network is unreachable|connection timed out|operation timed out|failed to connect|connection refused/i.test(text)) return "Couldn't reach the remote. Check your network connection."
  if (/divergent branches|need to specify how to reconcile/i.test(text)) {
    return "Your branch and its upstream have diverged. Choose how to reconcile them in a terminal (git pull --rebase, or git pull --no-rebase to merge)."
  }
  if (/\[rejected\]|non-fast-forward|fetch first/i.test(text)) return "The remote has commits you don't have yet. Pull first, then push."
  if (/no tracking information|has no upstream/i.test(text)) return "This branch has no upstream yet — publish it first."
  if (/conflict/i.test(text)) return "Pull produced merge conflicts. Resolve them under Merge Changes, stage the files, then commit."
  return null
}

function spawnGit(dir: string, args: string[], onLine: (line: string) => void, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("git", [...identity(dir), ...args], { cwd: dir, env: gitEnv(), stdio: ["ignore", "pipe", "pipe"] })
    let tail = ""
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
    }, NET_TIMEOUT)
    const onAbort = () => child.kill("SIGTERM")
    signal?.addEventListener("abort", onAbort, { once: true })
    const feed = (chunk: Buffer) => {
      const text = chunk.toString()
      tail = (tail + text).slice(-8000)
      // Progress meters redraw with \r; each redraw is its own line for the UI.
      for (const l of text.split(/[\r\n]+/)) if (l.trim()) onLine(l.trimEnd())
    }
    child.stdout.on("data", feed)
    child.stderr.on("data", feed)
    child.on("error", (err) => {
      clearTimeout(timer)
      reject(new HttpError(500, `Couldn't run git: ${err.message}`))
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      if (code === 0) return resolve()
      if (timedOut) return reject(new HttpError(504, `git ${args[0]} timed out after ${NET_TIMEOUT / 1000}s`))
      if (signal?.aborted) return reject(new HttpError(499, "Cancelled"))
      reject(new HttpError(400, explainRemoteError(tail) ?? (gitMessage({ stderr: tail }).split("\n").slice(-3).join("\n") || `git ${args[0]} failed`)))
    })
  })
}

async function remotes(dir: string) {
  return (await git(dir, ["remote"])).split("\n").filter(Boolean)
}

/**
 * Fetch, pull, push, or sync (pull then push). A branch without an upstream is published with
 * `push -u <remote> <branch>`. Never forces.
 */
export async function remoteOp(dir: string, op: RemoteOp, onLine: (line: string) => void, signal?: AbortSignal) {
  const st = await status(dir)
  if (!st.repo) throw new HttpError(409, "This project isn't a git repository yet")
  const rs = await remotes(dir)
  if (!rs.length) throw new HttpError(400, "This repository has no remote. Add one in a terminal: git remote add origin <url>")
  if (op === "fetch") return spawnGit(dir, ["fetch", "--prune", "--progress"], onLine, signal)
  if (op !== "pull" && (st.detached || !st.branch)) throw new HttpError(400, "You're not on a branch (detached HEAD) — switch to a branch to push")
  if (!st.oid && op !== "pull") throw new HttpError(400, "Make a commit before pushing")
  const publish = async () => {
    const remote = rs.includes("origin") ? "origin" : rs[0]
    onLine(`Publishing ${st.branch} to ${remote}…`)
    await spawnGit(dir, ["push", "--progress", "-u", remote, st.branch!], onLine, signal)
  }
  if (op === "pull") {
    if (!st.upstream) throw new HttpError(400, "This branch has no upstream yet — publish it first")
    return spawnGit(dir, ["pull", "--progress"], onLine, signal)
  }
  if (!st.upstream) return publish()
  if (op === "sync") await spawnGit(dir, ["pull", "--progress"], onLine, signal)
  await spawnGit(dir, ["push", "--progress"], onLine, signal)
}

// ─── AI commit message ─────────────────────────────────────────────────────

const DIFF_BUDGET = 6000

/** What the model sees: the staged diff (or, if nothing is staged, every change), kept small. */
export async function commitContext(dir: string) {
  const st = await status(dir)
  if (!st.repo) throw new HttpError(409, "This project isn't a git repository yet")
  const staged = st.staged.length > 0
  if (!staged && !st.unstaged.length && !st.untracked.length) throw new HttpError(400, "There are no changes to describe")
  const base = staged ? ["diff", "--cached"] : ["diff"]
  const stat = (await git(dir, [...base, "--stat=100", "--"])).trim()
  let diff = await git(dir, [...base, "--no-color", "--no-ext-diff", "-U2", "--"])
  if (diff.length > DIFF_BUDGET) diff = diff.slice(0, DIFF_BUDGET) + "\n… (diff truncated — see the stat above for the rest)"
  const untracked = !staged && st.untracked.length ? `\nNew untracked files:\n${st.untracked.slice(0, 40).map((f) => `  ${f.path}`).join("\n")}` : ""
  const recent = (await log(dir, 5)).map((c) => `  ${c.subject}`).join("\n")
  return [
    `Branch: ${st.branch ?? "(detached)"}`,
    recent ? `Recent commit subjects (match their style if it's consistent):\n${recent}` : "",
    `Changes (${staged ? "staged" : "not staged yet"}):\n${stat || "(no tracked changes)"}${untracked}`,
    diff ? `Diff:\n${diff}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")
}

const COMMIT_SYSTEM = `You write git commit messages in the Conventional Commits style.
First line: type(optional scope): summary — imperative mood, lower-case type (feat, fix, refactor, docs, test, chore, style, perf, build, ci), at most 72 characters, no trailing period.
If the change needs explaining, add a blank line and at most 3 short "- " bullet lines saying what changed and why.
Output only the commit message: no code fences, no quotes, no preamble.`

/** Strip what models add despite being told not to (fences, quotes, "Commit message:"). */
export function cleanCommitMessage(text: string) {
  return text
    .replace(/^```[a-z]*\n?|```$/gim, "")
    .replace(/^(commit message:)\s*/i, "")
    .trim()
    .replace(/^"(.*)"$/s, "$1")
    .trim()
}

// ─── HTTP ──────────────────────────────────────────────────────────────────

function pathList(v: unknown): string[] | "all" {
  if (v === "all") return "all"
  if (!Array.isArray(v) || !v.length) throw new HttpError(400, '"paths" must be a non-empty array of file paths (or "all")')
  if (v.length > 10_000) throw new HttpError(400, "Too many paths")
  return v.map((p, i) => {
    const rel = requireString(p, `paths[${i}]`, 4096)
    safePath(rel)
    return rel
  })
}

const changed = () => bus.emit("event", { t: "scm" })

/** Handles /api/scm/*. Returns false for anything it doesn't own. */
export async function handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith("/api/scm/")) return false
  const route = url.pathname.slice("/api/scm/".length)
  const dir = projectDir()
  const method = req.method ?? "GET"
  const q = (k: string) => url.searchParams.get(k) ?? ""
  const reply = (data: unknown) => {
    json(res, 200, data)
    return true
  }

  if (method === "GET") {
    if (route === "status") return reply(await status(dir))
    if (route === "diff") {
      const kind = q("kind") as DiffKind
      if (!["working", "staged", "commit"].includes(kind)) throw new HttpError(400, '"kind" must be working, staged or commit')
      return reply(await diffContent(dir, kind, requireString(q("path"), "path", 4096), q("ref") || undefined))
    }
    if (route === "branches") return reply({ branches: await branches(dir) })
    if (route === "log") return reply({ commits: await log(dir) })
    if (route === "commit") return reply(await showCommit(dir, requireString(q("ref"), "ref", 64)))
    return false
  }
  if (method !== "POST") return false

  const b = await readJson(req)
  switch (route) {
    case "init":
      await init(dir)
      break
    case "stage":
    case "unstage": {
      const paths = pathList(b.paths)
      await (route === "stage" ? stage : unstage)(dir, paths)
      break
    }
    case "discard": {
      // The UI asks first; the explicit flag means a stray request can't throw work away.
      if (b.confirm !== true) throw new HttpError(400, 'Discarding changes needs "confirm": true')
      const paths = pathList(b.paths)
      if (paths === "all") throw new HttpError(400, "List the files to discard")
      const result = await discard(dir, paths)
      changed()
      return reply(result)
    }
    case "commit": {
      const result = await commit(dir, requireString(b.message, "message", 20_000), { all: b.all === true })
      changed()
      return reply(result)
    }
    case "checkout":
      await checkout(dir, requireString(b.branch, "branch", 250))
      break
    case "branch": {
      const name = await createBranch(dir, requireString(b.name, "name", 250), { checkout: b.checkout !== false })
      changed()
      return reply({ name })
    }
    case "remote": {
      const op = b.op as RemoteOp
      if (!["fetch", "pull", "push", "sync"].includes(op)) throw new HttpError(400, '"op" must be fetch, pull, push or sync')
      const ac = new AbortController()
      res.on("close", () => ac.abort())
      const send = sse(res)
      try {
        await remoteOp(dir, op, (line) => send({ t: "line", line }), ac.signal)
        send({ t: "done" })
      } catch (err) {
        send({ t: "error", message: (err as Error).message })
      }
      changed()
      res.end()
      return true
    }
    case "commit-message": {
      if (!aiAvailable()) throw new HttpError(503, "No AI provider is available — configure one in .env (see .env.example)")
      const context = await commitContext(dir)
      const ac = new AbortController()
      res.on("close", () => ac.abort())
      const send = sse(res)
      const text = await stream(
        [
          { role: "system", content: COMMIT_SYSTEM },
          { role: "user", content: context },
        ],
        (d) => d.channel === "content" && send({ t: "delta", text: d.text }),
        { effort: "low", maxTokens: 1024, signal: ac.signal, onRateLimit: (r) => send({ t: "wait", ...r }) },
      )
      send({ t: "done", message: cleanCommitMessage(text) })
      res.end()
      return true
    }
    default:
      return false
  }
  changed()
  return reply({ ok: true })
}
