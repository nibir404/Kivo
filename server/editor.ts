import { execFile, execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import type http from "node:http"
import os from "node:os"
import path from "node:path"
import { buildMatcher, findInText, globFilter, matchLine, previewHit, replaceInText, splitLines, type MatchOptions } from "../src/features/editor/match"
import { bus } from "./bus"
import { HttpError, json, readJson, requireString } from "./http"
import { projectDir } from "./workspace"

/**
 * The editor's daemon side: explorer file operations, find/replace in files, and a watcher that
 * tells the UI when files change on disk. Every operation takes the project directory as an
 * argument (the routes pass the *current* one each time), so the project can change at runtime
 * and the logic is unit-testable on a temp folder.
 */

const IGNORE = new Set([".git", ".venv", "venv", "node_modules", "__pycache__", ".pytest_cache", "dist", "build", ".next", ".turbo", "target", ".gradle", ".idea", "Pods", ".DS_Store"])
const MAX_FILE = 2 * 1024 * 1024
const MAX_FILES = 30_000

// ─── Paths ───────────────────────────────────────────────────────────────────

/**
 * Resolve a project-relative path for a write. Beyond the lexical check (like safePath), the
 * nearest existing ancestor must really live inside the project, so a symlinked folder can't be
 * used to create or move files elsewhere. The project root and .git are never targets.
 */
export function resolveIn(dir: string, rel: unknown, field = "path"): string {
  const r = requireString(rel, field, 1024)
  if (r.includes("\0")) throw new HttpError(400, `"${field}" contains a NUL byte`)
  const abs = path.resolve(dir, r)
  if (abs !== dir && !abs.startsWith(dir + path.sep)) throw new Error("Path outside workspace")
  if (abs === dir) throw new HttpError(400, "That's the project folder itself")
  if (path.relative(dir, abs).split(path.sep).includes(".git")) throw new HttpError(400, "Kivo doesn't change files inside .git")
  let probe = path.dirname(abs)
  while (!fs.existsSync(probe)) probe = path.dirname(probe)
  const real = fs.realpathSync(probe)
  const root = fs.realpathSync(dir)
  if (real !== root && !real.startsWith(root + path.sep)) throw new Error("Path outside workspace")
  return abs
}

const relOf = (dir: string, abs: string) => path.relative(dir, abs).split(path.sep).join("/")

// ─── File operations ─────────────────────────────────────────────────────────

export function createEntry(dir: string, rel: string, kind: "file" | "folder") {
  const abs = resolveIn(dir, rel)
  if (fs.existsSync(abs)) throw new HttpError(409, `${rel} already exists`)
  if (kind === "folder") fs.mkdirSync(abs, { recursive: true })
  else {
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, "", { flag: "wx" })
  }
  return { path: relOf(dir, abs) }
}

export function renameEntry(dir: string, from: string, to: string) {
  const src = resolveIn(dir, from, "from")
  const dst = resolveIn(dir, to, "to")
  if (!fs.lstatSync(src, { throwIfNoEntry: false })) throw new HttpError(404, `${from} doesn't exist`)
  if (src === dst) return { path: relOf(dir, dst) }
  // A case-only rename on a case-insensitive disk "exists" already — that one is allowed.
  const caseOnly = src.toLowerCase() === dst.toLowerCase()
  if (fs.existsSync(dst) && !caseOnly) throw new HttpError(409, `${to} already exists`)
  if (dst.startsWith(src + path.sep)) throw new HttpError(400, "Can't move a folder into itself")
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.renameSync(src, dst)
  return { path: relOf(dir, dst) }
}

/** "name copy.ext", then "name copy 2.ext", … next to the original (Finder's naming). */
export function duplicateEntry(dir: string, rel: string) {
  const src = resolveIn(dir, rel)
  const stat = fs.statSync(src, { throwIfNoEntry: false })
  if (!stat) throw new HttpError(404, `${rel} doesn't exist`)
  const ext = stat.isDirectory() ? "" : path.extname(src)
  const stem = src.slice(0, src.length - ext.length)
  let dst = `${stem} copy${ext}`
  for (let n = 2; fs.existsSync(dst); n++) dst = `${stem} copy ${n}${ext}`
  fs.cpSync(src, dst, { recursive: true, errorOnExist: true, force: false })
  return { path: relOf(dir, dst) }
}

/** The user's trash folder, or null where Kivo doesn't know one (then delete is refused). */
export function defaultTrash(platform = process.platform): string | null {
  if (platform === "darwin") return path.join(os.homedir(), ".Trash")
  if (platform === "linux") return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "Trash")
  return null
}

function moveAcrossDevices(src: string, dst: string) {
  try {
    fs.renameSync(src, dst)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err
    fs.cpSync(src, dst, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true })
    fs.rmSync(src, { recursive: true, force: true })
  }
}

/**
 * Delete = move to the OS trash, never an unlink. macOS: into ~/.Trash under a unique name.
 * Linux: the freedesktop layout (files/ + info/*.trashinfo), so the desktop's "Restore" works.
 */
export function trashEntry(dir: string, rel: string, opts: { trash?: string | null; platform?: NodeJS.Platform } = {}) {
  const src = resolveIn(dir, rel)
  const stat = fs.lstatSync(src, { throwIfNoEntry: false })
  if (!stat) throw new HttpError(404, `${rel} doesn't exist`)
  const platform = opts.platform ?? process.platform
  const trash = opts.trash === undefined ? defaultTrash(platform) : opts.trash
  if (!trash) throw new HttpError(501, "Kivo doesn't know where the trash is on this system, so it won't delete anything")
  const linux = platform === "linux"
  const filesDir = linux ? path.join(trash, "files") : trash
  fs.mkdirSync(filesDir, { recursive: true })
  const ext = stat.isDirectory() ? "" : path.extname(src)
  const stem = path.basename(src, ext)
  let name = path.basename(src)
  for (let n = 2; fs.existsSync(path.join(filesDir, name)) || (linux && fs.existsSync(path.join(trash, "info", `${name}.trashinfo`))); n++) name = `${stem} ${n}${ext}`
  const info = path.join(trash, "info", `${name}.trashinfo`)
  if (linux) {
    fs.mkdirSync(path.dirname(info), { recursive: true })
    const date = new Date().toISOString().slice(0, 19)
    fs.writeFileSync(info, `[Trash Info]\nPath=${encodeURI(src)}\nDeletionDate=${date}\n`, { flag: "wx" })
  }
  const dst = path.join(filesDir, name)
  try {
    moveAcrossDevices(src, dst)
  } catch (err) {
    if (linux) fs.rmSync(info, { force: true })
    throw err
  }
  return { trashed: dst }
}

/** Show the item in Finder (or the platform's file manager). Absolute paths only, so nothing reads as a flag. */
export function reveal(abs: string) {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", ["-R", abs]] : process.platform === "win32" ? ["explorer", [`/select,${abs}`]] : ["xdg-open", [path.dirname(abs)]]
  return new Promise<void>((resolve, reject) => execFile(cmd, args, { timeout: 5000 }, (err) => (err ? reject(new Error(`Couldn't open the file manager: ${err.message}`)) : resolve())))
}

// ─── Listing ─────────────────────────────────────────────────────────────────

/** Same rules as workspace.listFiles, for any directory: git's view when it's a repo, else a pruned walk. */
export function listProjectFiles(dir: string): string[] {
  if (fs.existsSync(path.join(dir, ".git"))) {
    try {
      const out = execFileSync("git", ["-C", dir, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 })
      return [...new Set(out.split("\0").filter(Boolean))].filter((f) => !f.split("/").includes(".DS_Store") && fs.existsSync(path.join(dir, f))).slice(0, MAX_FILES).sort()
    } catch {
      // fall through to a walk
    }
  }
  const out: string[] = []
  const walk = (abs: string, prefix: string, depth: number) => {
    if (out.length >= MAX_FILES || depth > 12) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (IGNORE.has(e.name) || e.name.endsWith(".db")) continue
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      if (e.isDirectory()) walk(path.join(abs, e.name), rel, depth + 1)
      else if (e.isFile()) out.push(rel)
      if (out.length >= MAX_FILES) return
    }
  }
  walk(dir, "", 0)
  return out.sort()
}

/**
 * Folders that hold no files — invisible in a file list, but the explorer must show a folder the
 * user just created. Only looks inside folders that already contain listed files (plus the root),
 * so ignored trees like node_modules are never walked.
 */
export function emptyDirs(dir: string, files: string[]): string[] {
  const known = new Set([""])
  for (const f of files) {
    const segs = f.split("/")
    for (let i = 1; i < segs.length; i++) known.add(segs.slice(0, i).join("/"))
  }
  const found: string[] = []
  const isEmptyTree = (abs: string, depth: number): boolean => {
    if (depth > 6) return false
    try {
      return fs.readdirSync(abs, { withFileTypes: true }).every((e) => e.isDirectory() && isEmptyTree(path.join(abs, e.name), depth + 1))
    } catch {
      return false
    }
  }
  const collect = (rel: string, depth: number) => {
    if (found.length > 2000 || depth > 6) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isDirectory() || IGNORE.has(e.name)) continue
      const child = rel ? `${rel}/${e.name}` : e.name
      if (known.has(child)) continue
      if (isEmptyTree(path.join(dir, child), 0)) {
        found.push(child)
        collect(child, depth + 1)
      }
    }
  }
  for (const k of known) collect(k, 0)
  return found.sort()
}

// ─── Find in files ───────────────────────────────────────────────────────────

export interface SearchQuery extends MatchOptions {
  include?: string
  exclude?: string
  maxResults?: number
  engine?: "auto" | "rg" | "git" | "js"
}

export interface Hit {
  line: number
  col: number
  len: number
  /** Context around the match for the results list (trimmed for very long lines). */
  before: string
  text: string
  after: string
}

export interface SearchResult {
  files: { path: string; matches: Hit[] }[]
  total: number
  truncated: boolean
  engine: "rg" | "git" | "js"
}

const hit = previewHit

/** Collects hits in arrival order, grouped by file, and knows when the cap is reached. */
class Collector {
  files = new Map<string, Hit[]>()
  total = 0
  truncated = false
  constructor(private max: number) {}
  add(file: string, h: Hit) {
    if (this.total >= this.max) {
      this.truncated = true
      return false
    }
    let list = this.files.get(file)
    if (!list) this.files.set(file, (list = []))
    list.push(h)
    this.total++
    return true
  }
  result(engine: SearchResult["engine"]): SearchResult {
    return { files: [...this.files].map(([p, matches]) => ({ path: p, matches })), total: this.total, truncated: this.truncated, engine }
  }
}

/** A searchable text file, or null. Symlinks are skipped so search/replace can't reach outside the project. */
function readText(abs: string): string | null {
  try {
    const st = fs.lstatSync(abs)
    if (!st.isFile() || st.size > MAX_FILE) return null
    const buf = fs.readFileSync(abs)
    if (buf.subarray(0, 8192).includes(0)) return null
    return buf.toString("utf8")
  } catch {
    return null
  }
}

/** Run a searcher and hand it stdout line by line; `onLine` returns false to stop early. */
function streamLines(cmd: string, args: string[], cwd: string, onLine: (line: string) => boolean, argv0?: string) {
  return new Promise<{ code: number | null; stderr: string; stopped: boolean }>((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], argv0, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })
    let buf = ""
    let stderr = ""
    let stopped = false
    const timer = setTimeout(() => {
      stopped = true
      child.kill()
    }, 20_000)
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      if (stopped) return
      buf += chunk
      let i: number
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (!onLine(line)) {
          stopped = true
          child.kill()
          return
        }
      }
    })
    child.stderr.on("data", (c) => (stderr += c).length > 4000 && (stderr = stderr.slice(-4000)))
    child.on("error", (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (!stopped && buf) onLine(buf)
      resolve({ code, stderr, stopped })
    })
  })
}

const rgChecked = new Map<string, boolean>()
/** ripgrep, if installed. KIVO_RG may point at a specific binary. */
async function rgAvailable(bin: string) {
  if (!rgChecked.has(bin)) rgChecked.set(bin, await new Promise<boolean>((r) => execFile(bin, ["--version"], { timeout: 3000 }, (err) => r(!err))))
  return rgChecked.get(bin)!
}

async function searchRg(dir: string, q: SearchQuery, keep: (p: string) => boolean, out: Collector) {
  const bin = process.env.KIVO_RG || "rg"
  const args = ["--json", "--hidden", "--no-messages", "--max-filesize", "2M", "-g", "!*.db"]
  for (const name of IGNORE) args.push("-g", `!${name}`)
  args.push(q.caseSensitive ? "-s" : "-i")
  if (!q.regex) args.push("-F")
  if (q.wholeWord) args.push("-w")
  args.push("-e", q.query, "--", ".")
  const r = await streamLines(bin, args, dir, (line) => {
    if (!line.startsWith('{"type":"match"')) return true
    const ev = JSON.parse(line) as { data: { path: { text?: string }; lines: { text?: string }; line_number: number; submatches: { start: number; end: number }[] } }
    const file = ev.data.path.text?.replace(/^\.\//, "")
    const text = ev.data.lines.text?.replace(/\r?\n$/, "")
    if (!file || text === undefined || !keep(file)) return true
    // rg reports byte offsets; the editor needs UTF-16 columns.
    const bytes = Buffer.from(text, "utf8")
    const col = (b: number) => bytes.subarray(0, b).toString("utf8").length
    for (const s of ev.data.submatches) {
      const c = col(s.start)
      if (!out.add(file, hit(text, ev.data.line_number, c, col(s.end) - c))) return false
    }
    return true
  })
  // 1 = no matches. Anything else unexpected (e.g. a regex rg's engine rejects) → let the caller fall back.
  if (!r.stopped && r.code !== 0 && r.code !== 1) throw new Error(`rg failed: ${r.stderr.trim().split("\n")[0] ?? r.code}`)
}

async function searchGit(dir: string, q: SearchQuery, re: RegExp, keep: (p: string) => boolean, out: Collector) {
  const args = ["-C", dir, "grep", "-n", "-I", "-z", "--no-color", "--untracked", q.regex ? "-P" : "-F"]
  if (!q.caseSensitive) args.push("-i")
  if (q.wholeWord) args.push("-w")
  args.push("-e", q.query, "--")
  const r = await streamLines("git", args, dir, (line) => {
    // -z: path NUL line NUL text
    const a = line.indexOf("\0")
    const b = line.indexOf("\0", a + 1)
    if (a < 0 || b < 0) return true
    const file = line.slice(0, a)
    if (!keep(file)) return true
    const n = Number(line.slice(a + 1, b))
    const text = line.slice(b + 1).replace(/\r$/, "")
    // git gives lines, not columns of every match: find them with the shared matcher.
    for (const m of matchLine(re, text, n)) if (!out.add(file, hit(text, n, m.col, m.len))) return false
    return true
  })
  if (!r.stopped && r.code !== 0 && r.code !== 1) throw new Error(`git grep failed: ${r.stderr.trim().split("\n")[0] ?? r.code}`)
}

function searchJs(dir: string, re: RegExp, keep: (p: string) => boolean, out: Collector) {
  for (const file of listProjectFiles(dir)) {
    if (!keep(file)) continue
    const text = readText(path.join(dir, file))
    if (text === null) continue
    const lines = splitLines(text)
    for (let i = 0; i < lines.length; i++) for (const m of matchLine(re, lines[i].text, i + 1)) if (!out.add(file, hit(lines[i].text, i + 1, m.col, m.len))) return
  }
}

function filterFor(q: { include?: string; exclude?: string }) {
  const inc = globFilter(q.include)
  const exc = globFilter(q.exclude)
  return (p: string) => (!inc || inc(p)) && !(exc && exc(p))
}

/**
 * Find in files: ripgrep when installed, else `git grep` in a repository, else a scan in JS.
 * Include/exclude globs are applied here (not by the tools), so they mean the same thing whichever
 * engine ran. A tool failure (e.g. a regex its engine doesn't support) falls back to the next.
 */
export async function searchFiles(dir: string, q: SearchQuery): Promise<SearchResult> {
  let re: RegExp
  try {
    re = buildMatcher(q)
  } catch (err) {
    throw new HttpError(400, (err as Error).message)
  }
  const max = Math.min(Math.max(1, Math.floor(q.maxResults ?? 2000)), 10_000)
  const keep = filterFor(q)
  const engine = q.engine ?? "auto"
  if (engine === "rg" || (engine === "auto" && (await rgAvailable(process.env.KIVO_RG || "rg")))) {
    const out = new Collector(max)
    try {
      await searchRg(dir, q, keep, out)
      return out.result("rg")
    } catch (err) {
      if (engine === "rg") throw err
    }
  }
  if (engine === "git" || (engine === "auto" && fs.existsSync(path.join(dir, ".git")))) {
    const out = new Collector(max)
    try {
      await searchGit(dir, q, re, keep, out)
      return out.result("git")
    } catch (err) {
      if (engine === "git") throw err
    }
  }
  const out = new Collector(max)
  searchJs(dir, re, keep, out)
  return out.result("js")
}

export interface ReplaceQuery extends MatchOptions {
  include?: string
  exclude?: string
  replace: string
  /** Only these files (per-file replace). Otherwise every file the filters allow. */
  paths?: string[]
  /** Files to leave alone on disk — the editor applies the change to their unsaved buffers itself. */
  skip?: string[]
  dryRun?: boolean
}

/** Replace across files with the shared matcher; `dryRun` reports the counts the confirm dialog shows. */
export function replaceInFiles(dir: string, q: ReplaceQuery) {
  let re: RegExp
  try {
    re = buildMatcher(q)
  } catch (err) {
    throw new HttpError(400, (err as Error).message)
  }
  const keep = filterFor(q)
  const skip = new Set(q.skip ?? [])
  const candidates = q.paths ? q.paths.map((p) => relOf(dir, resolveIn(dir, p))) : listProjectFiles(dir).filter(keep)
  const files: { path: string; count: number }[] = []
  let total = 0
  for (const file of candidates) {
    if (skip.has(file)) continue
    const abs = path.join(dir, file)
    const text = readText(abs)
    if (text === null) continue
    if (q.dryRun) {
      const count = findInText(re, text).length
      if (count) files.push({ path: file, count })
      total += count
      continue
    }
    const next = replaceInText(re, text, q.replace, !!q.regex)
    if (!next.count) continue
    fs.writeFileSync(abs, next.text)
    files.push({ path: file, count: next.count })
    total += next.count
  }
  return { files, total }
}

// ─── Watching ────────────────────────────────────────────────────────────────

let watcher: fs.FSWatcher | null = null
let watchedDir = ""
let pending = new Set<string>()
let flushTimer: NodeJS.Timeout | null = null
let rearmTimer: NodeJS.Timeout | null = null

const ignoredPath = (rel: string) => rel.split(/[\\/]/).some((seg) => IGNORE.has(seg)) || rel.endsWith(".db") || rel.endsWith(".db-journal")

function arm() {
  const dir = projectDir()
  if (watcher && dir === watchedDir) return
  watcher?.close()
  watcher = null
  watchedDir = dir
  pending = new Set()
  try {
    // Recursive watching is native on macOS (FSEvents) and Windows; Node 22 emulates it on Linux.
    watcher = fs.watch(dir, { recursive: true }, (_event, name) => {
      if (projectDir() !== watchedDir) return arm()
      const rel = name ? String(name).split(path.sep).join("/") : ""
      if (rel && ignoredPath(rel)) return
      pending.add(rel)
      flushTimer ??= setTimeout(() => {
        flushTimer = null
        const paths = [...pending].filter(Boolean)
        pending = new Set()
        bus.emit("event", { t: "fs", project: watchedDir, paths: paths.slice(0, 500), overflow: paths.length > 500 })
      }, 150)
    })
    watcher.on("error", () => {
      // e.g. the folder was deleted: drop the watcher; the re-arm check tries again.
      watcher?.close()
      watcher = null
    })
  } catch (err) {
    console.warn(`[kivo] can't watch ${dir} for changes: ${(err as Error).message}`)
  }
}

/** Start watching the current project, and follow it when the user opens another one. */
export function startWatcher() {
  if (rearmTimer) return
  arm()
  rearmTimer = setInterval(arm, 2000)
  rearmTimer.unref()
}

export function stopWatcher() {
  watcher?.close()
  watcher = null
  if (rearmTimer) clearInterval(rearmTimer)
  rearmTimer = null
}

// ─── Routes ──────────────────────────────────────────────────────────────────

const optString = (v: unknown, field: string, max = 2000) => {
  if (v === undefined || v === null || v === "") return undefined
  if (typeof v !== "string" || v.length > max) throw new HttpError(400, `"${field}" must be a string`)
  return v
}

const optStrings = (v: unknown, field: string) => {
  if (v === undefined) return undefined
  if (!Array.isArray(v) || v.length > 50_000 || v.some((x) => typeof x !== "string")) throw new HttpError(400, `"${field}" must be an array of strings`)
  return v as string[]
}

function matchOptions(b: Record<string, unknown>) {
  return {
    query: requireString(b.query, "query", 2000),
    regex: b.regex === true,
    caseSensitive: b.caseSensitive === true,
    wholeWord: b.wholeWord === true,
    include: optString(b.include, "include"),
    exclude: optString(b.exclude, "exclude"),
  }
}

/** Handles this feature's /api routes. Returns false for anything it doesn't own. */
export async function handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  startWatcher()
  if (!url.pathname.startsWith("/api/editor/")) return false
  const route = url.pathname.slice("/api/editor/".length)
  const dir = projectDir()

  if (route === "dirs" && req.method === "GET") {
    json(res, 200, { dirs: emptyDirs(dir, listProjectFiles(dir)) })
    return true
  }
  if (req.method !== "POST") return false
  const b = await readJson(req)

  switch (route) {
    case "create": {
      if (b.kind !== "file" && b.kind !== "folder") throw new HttpError(400, '"kind" must be "file" or "folder"')
      json(res, 200, createEntry(dir, requireString(b.path, "path", 1024), b.kind))
      return true
    }
    case "rename":
      json(res, 200, renameEntry(dir, requireString(b.from, "from", 1024), requireString(b.to, "to", 1024)))
      return true
    case "duplicate":
      json(res, 200, duplicateEntry(dir, requireString(b.path, "path", 1024)))
      return true
    case "trash":
      json(res, 200, trashEntry(dir, requireString(b.path, "path", 1024)))
      return true
    case "reveal": {
      const rel = requireString(b.path, "path", 1024)
      const abs = rel === "." ? dir : resolveIn(dir, rel)
      if (!fs.existsSync(abs)) throw new HttpError(404, `${rel} doesn't exist`)
      await reveal(abs)
      json(res, 200, { ok: true })
      return true
    }
    case "search": {
      const max = typeof b.maxResults === "number" ? b.maxResults : undefined
      json(res, 200, await searchFiles(dir, { ...matchOptions(b), maxResults: max }))
      return true
    }
    case "replace": {
      if (typeof b.replace !== "string" || b.replace.length > 100_000) throw new HttpError(400, '"replace" must be a string')
      json(res, 200, replaceInFiles(dir, { ...matchOptions(b), replace: b.replace, paths: optStrings(b.paths, "paths"), skip: optStrings(b.skip, "skip"), dryRun: b.dryRun === true }))
      return true
    }
  }
  return false
}
