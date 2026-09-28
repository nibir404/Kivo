import { execFile, execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { analyzeRepository, type RepoFile } from "@kivo/core/detect"
import { REPO_ROOT, SEED_PROJECT } from "../paths"

/**
 * Projects are real directories on disk: the built-in demo, any folder the user opens, or a
 * repository they clone. Exactly one is current; file access, the terminal, git and analysis
 * all work against it. The demo is Kivo-managed (its own git identity, auto-commits, Kivo's
 * Python venv on PATH); a user's project is theirs — their git identity, their tools, no
 * commits made on their behalf.
 */

const run = promisify(execFile)
const expand = (p: string) => p.replace(/^~(?=$|[\\/])/, os.homedir())

/** Kivo's own data (demo project, venv, project list). Defaults to the checkout; KIVO_HOME moves it. */
export const WORKSPACES = process.env.KIVO_HOME ? path.resolve(expand(process.env.KIVO_HOME)) : path.join(REPO_ROOT, ".kivo-workspace")
export const VENV = path.join(WORKSPACES, ".venv")
/** Where "Clone from GitHub" puts repositories unless the user picks somewhere else. */
export const CLONE_ROOT = path.resolve(expand(process.env.KIVO_PROJECTS_DIR ?? "~/Kivo"))
const DEMO_NAME = process.env.KIVO_PROJECT ?? "tandem"
const DEMO_DIR = path.join(WORKSPACES, DEMO_NAME)
const REGISTRY = path.join(WORKSPACES, "projects.json")

export interface ProjectInfo {
  id: string
  name: string
  dir: string
  kind: "demo" | "local" | "git"
  /** Kivo-managed (the demo): Kivo's venv and git identity apply, builds auto-commit. */
  managed: boolean
  remote?: string
  openedAt: number
}

const DEMO: ProjectInfo = { id: "demo", name: DEMO_NAME, dir: DEMO_DIR, kind: "demo", managed: true, openedAt: 0 }

let projects: ProjectInfo[] = [DEMO]
let current: ProjectInfo = DEMO

export const project = () => current
export const projectDir = () => current.dir
export const listProjects = () => [...projects].sort((a, b) => Number(b.id === current.id) - Number(a.id === current.id) || b.openedAt - a.openedAt)

function save() {
  try {
    fs.mkdirSync(WORKSPACES, { recursive: true })
    fs.writeFileSync(REGISTRY, JSON.stringify({ current: current.id, projects: projects.filter((p) => p.kind !== "demo") }, null, 2))
  } catch (err) {
    console.warn("[kivo] couldn't save the project list:", (err as Error).message)
  }
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(REGISTRY, "utf8")) as { current?: string; projects?: ProjectInfo[] }
    const saved = (raw.projects ?? []).filter((p) => p && typeof p.dir === "string" && fs.existsSync(p.dir)).map((p) => ({ ...p, managed: false }))
    projects = [DEMO, ...saved]
    current = projects.find((p) => p.id === raw.current) ?? DEMO
  } catch {
    // first run, or an unreadable file: start with the demo
  }
}

/** Refuse folders that can't sensibly be a project (the filesystem root, the home directory itself). */
function checkProjectDir(dir: string) {
  const abs = path.resolve(expand(dir))
  const stat = fs.statSync(abs, { throwIfNoEntry: false })
  if (!stat) throw new Error(`${abs} doesn't exist`)
  if (!stat.isDirectory()) throw new Error(`${abs} is a file, not a folder`)
  if (abs === path.parse(abs).root) throw new Error("Pick a project folder, not the whole disk")
  if (abs === os.homedir()) throw new Error("Pick a project folder inside your home folder, not the home folder itself")
  fs.accessSync(abs, fs.constants.R_OK)
  return fs.realpathSync(abs)
}

function remoteOf(dir: string) {
  try {
    return execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).trim() || undefined
  } catch {
    return undefined
  }
}

/** Make a folder the current project (adding it to the list if it's new). */
export function openProject(dir: string): ProjectInfo {
  const abs = checkProjectDir(dir)
  if (abs === fs.realpathSync(DEMO_DIR)) return switchProject("demo")
  let p = projects.find((x) => x.dir === abs)
  if (!p) {
    const remote = remoteOf(abs)
    p = { id: crypto.randomUUID(), name: path.basename(abs), dir: abs, kind: remote ? "git" : "local", managed: false, remote, openedAt: Date.now() }
    projects.push(p)
  }
  p.openedAt = Date.now()
  current = p
  save()
  return p
}

export function switchProject(id: string): ProjectInfo {
  const p = projects.find((x) => x.id === id)
  if (!p) throw new Error("That project isn't in Kivo's list anymore")
  if (!fs.existsSync(p.dir)) throw new Error(`${p.dir} no longer exists`)
  p.openedAt = Date.now()
  current = p
  save()
  return p
}

/** Forget a project (the folder on disk is untouched). The demo can't be removed. */
export function forgetProject(id: string) {
  if (id === "demo") throw new Error("The demo project can't be removed")
  projects = projects.filter((p) => p.id !== id)
  if (current.id === id) current = DEMO
  save()
}

export async function ensureWorkspace() {
  load()
  if (!fs.existsSync(DEMO_DIR)) {
    fs.mkdirSync(WORKSPACES, { recursive: true })
    fs.cpSync(SEED_PROJECT, DEMO_DIR, { recursive: true })
    fs.writeFileSync(path.join(DEMO_DIR, ".gitignore"), ".venv/\n__pycache__/\n.pytest_cache/\n*.db\n.env\n")
  }
  // Checked separately from the directory, so a first run without git is repaired on the next start.
  if (fs.existsSync(path.join(DEMO_DIR, ".git"))) return
  try {
    await gitIn(DEMO, ["init", "-q", "-b", "main"])
    await gitIn(DEMO, ["add", "-A"])
    await gitIn(DEMO, ["commit", "-q", "-m", "Initial project"])
  } catch (err) {
    fs.rmSync(path.join(DEMO_DIR, ".git"), { recursive: true, force: true })
    console.warn(`[kivo] git isn't available (${(err as Error).message.split("\n")[0]}) — builds won't be versioned until it is. On macOS: xcode-select --install`)
  }
}

function gitIn(p: ProjectInfo, args: string[]) {
  // Only the demo commits as "Kivo"; in the user's own repos git uses their identity and config.
  const identity = p.managed ? ["-c", "user.name=Kivo", "-c", "user.email=kivo@localhost"] : []
  return run("git", [...identity, ...args], { cwd: p.dir, maxBuffer: 20 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })
}

/** Run git in the current project. */
export const git = (args: string[]) => gitIn(current, args)

export const isGitRepo = () => fs.existsSync(path.join(current.dir, ".git"))

/** Resolve a project-relative path, refusing anything that escapes the project directory. */
export function safePath(rel: string) {
  const dir = current.dir
  const abs = path.resolve(dir, rel)
  if (abs !== dir && !abs.startsWith(dir + path.sep)) throw new Error("Path outside workspace")
  return abs
}

const IGNORE = new Set([".git", ".venv", "venv", "node_modules", "__pycache__", ".pytest_cache", "dist", "build", ".next", ".turbo", "target", ".gradle", ".idea", "Pods", ".DS_Store"])
const MAX_FILES = 30_000

/**
 * Every file in the project, relative and sorted. In a git repository this is `git ls-files`
 * (tracked + untracked, honouring .gitignore); otherwise a walk that skips build and dependency
 * folders. Capped, so opening a huge folder can't hang the daemon.
 */
export function listFiles(): string[] {
  const dir = current.dir
  if (fs.existsSync(path.join(dir, ".git"))) {
    try {
      const out = execFileSync("git", ["-C", dir, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 })
      const files = [...new Set(out.split("\0").filter(Boolean))].filter((f) => !f.split("/").some((seg) => seg === ".DS_Store") && fs.existsSync(path.join(dir, f)))
      return files.slice(0, MAX_FILES).sort()
    } catch {
      // fall back to a walk (e.g. git missing, or a broken repo)
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

export function readFile(rel: string) {
  const abs = safePath(rel)
  if (fs.statSync(abs).size > 2 * 1024 * 1024) throw new Error("File too large to open (2 MB max)")
  const buf = fs.readFileSync(abs)
  // A NUL byte in the first 8 KB means it's binary — don't hand the editor garbage.
  if (buf.subarray(0, 8192).includes(0)) throw new Error("This is a binary file")
  return buf.toString("utf8")
}

export function writeFile(rel: string, content: string) {
  const abs = safePath(rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
}

const MANIFEST = /(^|\/)(package\.json|pyproject\.toml|requirements[^/]*\.txt|docker-compose\.ya?ml|compose\.ya?ml|Dockerfile[^/]*|\.env\.example|tsconfig\.json|app\.json|pubspec\.yaml|Cargo\.toml|go\.mod|pom\.xml|build\.gradle(\.kts)?|platformio\.ini|MLproject|dbt_project\.yml|Chart\.yaml|tailwind\.config\.\w+)$/

/** Detection over the project. Only manifests are read; line counts are estimated from file size. */
export function analyze() {
  const dir = current.dir
  const paths = listFiles()
  let manifests = 0
  const files: RepoFile[] = paths.map((p) => {
    const abs = path.join(dir, p)
    const size = fs.statSync(abs, { throwIfNoEntry: false })?.size ?? 0
    const isManifest = MANIFEST.test(p) || /k8s\/.*\.ya?ml$/.test(p)
    const content = isManifest && size < 256 * 1024 && manifests++ < 400 ? fs.readFileSync(abs, "utf8") : undefined
    return { path: p, content, lines: Math.max(1, Math.round(size / 36)) }
  })
  return { ...analyzeRepository(files), files: paths, project: publicProject(current) }
}

/** What the browser may know about a project. */
export const publicProject = (p: ProjectInfo) => ({ id: p.id, name: p.name, dir: p.dir, kind: p.kind, managed: p.managed, remote: p.remote, openedAt: p.openedAt })
