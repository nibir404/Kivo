import { execFile } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { promisify } from "node:util"
import { analyzeRepository, type RepoFile } from "../src/core/detect"

/**
 * The project workspace is a real directory on disk. Everything Kivo builds is written here,
 * the terminal opens here, and every build is committed to its git history.
 */

const run = promisify(execFile)
const ROOT = path.resolve(import.meta.dirname, "..")
export const WORKSPACES = path.join(ROOT, ".kivo-workspace")
export const PROJECT = process.env.KIVO_PROJECT ?? "tandem"
export const PROJECT_DIR = path.join(WORKSPACES, PROJECT)
export const VENV = path.join(WORKSPACES, ".venv")

const IGNORE = new Set([".git", ".venv", "node_modules", "__pycache__", ".pytest_cache", "dist", ".DS_Store"])
const MANIFEST = /(package\.json|pyproject\.toml|requirements\.txt|docker-compose\.ya?ml|Dockerfile|\.env\.example|tsconfig\.json|app\.json)$/

export async function ensureWorkspace() {
  if (fs.existsSync(PROJECT_DIR)) return
  fs.mkdirSync(WORKSPACES, { recursive: true })
  fs.cpSync(path.join(import.meta.dirname, "seed-project"), PROJECT_DIR, { recursive: true })
  fs.writeFileSync(path.join(PROJECT_DIR, ".gitignore"), ".venv/\n__pycache__/\n.pytest_cache/\n*.db\n.env\n")
  await git(["init", "-q", "-b", "main"])
  await git(["add", "-A"])
  await git(["commit", "-q", "-m", "Initial project"])
}

export function git(args: string[]) {
  return run("git", ["-c", "user.name=Kivo", "-c", "user.email=kivo@localhost", ...args], { cwd: PROJECT_DIR, maxBuffer: 10 * 1024 * 1024 })
}

/** Resolve a workspace-relative path, refusing anything that escapes the project directory. */
export function safePath(rel: string) {
  const abs = path.resolve(PROJECT_DIR, rel)
  if (abs !== PROJECT_DIR && !abs.startsWith(PROJECT_DIR + path.sep)) throw new Error("Path outside workspace")
  return abs
}

export function listFiles(dir = PROJECT_DIR, prefix = ""): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE.has(e.name) || e.name.endsWith(".db")) continue
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...listFiles(path.join(dir, e.name), rel))
    else out.push(rel)
  }
  return out.sort()
}

export function readFile(rel: string) {
  const abs = safePath(rel)
  if (fs.statSync(abs).size > 512 * 1024) throw new Error("File too large to open")
  return fs.readFileSync(abs, "utf8")
}

export function writeFile(rel: string, content: string) {
  const abs = safePath(rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
}

export function analyze() {
  const files: RepoFile[] = listFiles().map((p) => {
    const abs = path.join(PROJECT_DIR, p)
    const text = fs.statSync(abs).size < 256 * 1024 ? fs.readFileSync(abs, "utf8") : ""
    return { path: p, content: MANIFEST.test(p) ? text : undefined, lines: text.split("\n").length }
  })
  return { ...analyzeRepository(files), files: files.map((f) => f.path) }
}
