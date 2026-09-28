import { analyzeRepository, type RepoFile } from "@kivo/core/detect"
import type { ProjectInfo } from "@/lib/api"
import { bus } from "./bus"
import { HandleFS, ensurePermission, folderAccessSupported, type DirHandle } from "./fs/handle"
import { idb } from "./fs/idb"
import { MemoryFS } from "./fs/memory"
import { demoFiles } from "./fs/seed"
import type { ProjectFS } from "./fs/types"
import { HttpError } from "./http"

/**
 * Projects in the browser: the demo (kept in this browser), folders the user picked (read and
 * written in place through the File System Access API), and public GitHub repositories imported
 * into browser storage. One is current; the list and folder handles are remembered in IndexedDB.
 */

interface Stored extends ProjectInfo {
  handle?: DirHandle
}

const REGISTRY = "projects"
const DEMO: Stored = { id: "demo", name: "tandem", dir: "Stored in this browser", kind: "demo", managed: true, openedAt: 0 }

let projects: Stored[] = [DEMO]
let currentId = "demo"
let fs: ProjectFS | null = null
let loaded: Promise<void> | null = null
/** Folders picked in this session but not opened yet (the picker and "open" are two requests). */
const picked = new Map<string, DirHandle>()

const save = () => idb.set(REGISTRY, { current: currentId, projects: projects.filter((p) => p.kind !== "demo") })

async function load() {
  const saved = await idb.get<{ current: string; projects: Stored[] }>(REGISTRY)
  if (saved) {
    projects = [DEMO, ...saved.projects]
    currentId = projects.some((p) => p.id === saved.current) ? saved.current : "demo"
  }
  try {
    fs = await fsFor(current(), false)
  } catch {
    // A folder whose permission lapsed: start in the demo; the user can reopen it from the menu.
    currentId = "demo"
    fs = await fsFor(DEMO, false)
  }
  // Coming back to the tab after editing files elsewhere: re-read the folder.
  window.addEventListener("focus", () => {
    if (fs instanceof HandleFS) {
      fs.invalidate()
      bus.emit({ t: "fs", project: currentId, paths: [] })
    }
  })
}

export const ready = () => (loaded ??= load())

const current = () => projects.find((p) => p.id === currentId) ?? DEMO

export const publicProject = ({ handle: _h, ...p }: Stored): ProjectInfo => p

export async function currentProject() {
  await ready()
  return publicProject(current())
}

/** The current project's files right now (null before the first load) — lets a long run notice a switch. */
export const activeFS = () => fs

export async function currentFS(): Promise<ProjectFS> {
  await ready()
  return fs!
}

export async function listProjects() {
  await ready()
  return [...projects].sort((a, b) => Number(b.id === currentId) - Number(a.id === currentId) || b.openedAt - a.openedAt).map(publicProject)
}

async function fsFor(p: Stored, ask: boolean): Promise<ProjectFS> {
  if (p.kind === "demo") return MemoryFS.open("fs:demo", demoFiles)
  if (p.handle) {
    if (!(await ensurePermission(p.handle, ask))) throw new HttpError(403, `The browser didn't allow Kivo to use "${p.name}". Choose it again to grant access.`)
    return new HandleFS(p.handle)
  }
  return MemoryFS.open(`fs:${p.id}`, async () => ({}))
}

async function makeCurrent(p: Stored, ask = true) {
  fs = await fsFor(p, ask)
  p.openedAt = Date.now()
  currentId = p.id
  await save()
  bus.emit({ t: "project", project: publicProject(p) })
  return publicProject(p)
}

/** The browser's folder picker. Resolves to a token for `open`, or null if the user cancelled. */
export async function pickFolder(): Promise<string | null> {
  if (!folderAccessSupported()) throw new HttpError(501, "This browser can't open folders from your disk. Use Chrome or Edge, or import a GitHub repository instead.")
  try {
    const h = await window.showDirectoryPicker!({ mode: "readwrite", id: "kivo-project" })
    const token = `picked:${crypto.randomUUID()}`
    picked.set(token, h)
    return token
  } catch (err) {
    if ((err as DOMException).name === "AbortError") return null
    throw new HttpError(400, `Couldn't open that folder: ${(err as Error).message}`)
  }
}

export async function openPicked(token: string) {
  await ready()
  const h = picked.get(token)
  if (!h) {
    // A project id also works, so "open" of a known project just switches to it.
    if (projects.some((p) => p.id === token)) return switchTo(token)
    throw new HttpError(400, "Choose a folder first")
  }
  picked.delete(token)
  // The same folder picked again is the same project.
  let p: Stored | undefined
  for (const x of projects) if (x.handle && (await x.handle.isSameEntry(h))) p = x
  if (!p) {
    p = { id: crypto.randomUUID(), name: h.name, dir: `Folder “${h.name}” on this computer`, kind: "local", managed: false, openedAt: Date.now(), handle: h }
    projects.push(p)
  }
  return makeCurrent(p)
}

export async function switchTo(id: string) {
  await ready()
  const p = projects.find((x) => x.id === id)
  if (!p) throw new HttpError(404, "That project isn't in Kivo's list anymore")
  return makeCurrent(p)
}

export async function forget(id: string) {
  await ready()
  if (id === "demo") throw new HttpError(400, "The demo project can't be removed")
  const p = projects.find((x) => x.id === id)
  projects = projects.filter((x) => x.id !== id)
  // An imported repository lives only in this browser: forgetting it frees the storage.
  if (p && !p.handle) await MemoryFS.drop(`fs:${id}`)
  if (currentId === id) await makeCurrent(DEMO, false)
  else await save()
}

/** Put the demo back to how it shipped. */
export async function resetDemo() {
  await ready()
  const demo = await MemoryFS.open("fs:demo", demoFiles)
  await demo.reset(demoFiles)
  if (currentId === "demo") fs = demo
  bus.emit({ t: "fs", project: "demo", paths: [] })
}

// ─── Importing from GitHub ────────────────────────────────────────────────────

const MAX_IMPORT_FILES = 3000
const MAX_IMPORT_BYTES = 40 * 1024 * 1024
const BINARY = /\.(png|jpe?g|gif|webp|ico|bmp|tiff?|psd|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|class|so|dylib|dll|exe|bin|o|a|wasm|mp[34]|mov|avi|webm|ogg|wav|flac|ttf|otf|woff2?|eot|sqlite|db|pyc|lockb)$/i

/** "owner/repo", or a github.com URL (https or ssh) → owner and repo. */
export function parseGitHub(input: string) {
  const s = input.trim().replace(/\.git$/, "").replace(/\/+$/, "")
  const m = s.match(/^(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:)?([\w.-]+)\/([\w.-]+)$/)
  if (!m) throw new HttpError(400, "In the browser Kivo can import public GitHub repositories: enter owner/repo or https://github.com/owner/repo")
  return { owner: m[1], repo: m[2] }
}

async function gh<T>(url: string, signal: AbortSignal): Promise<T> {
  const res = await fetch(url, { headers: { Accept: "application/vnd.github+json" }, signal })
  if (res.status === 404) throw new HttpError(404, "Repository not found. In the browser Kivo can only import public repositories.")
  if (res.status === 403 || res.status === 429) throw new HttpError(429, "GitHub's rate limit for this network is used up (60 requests an hour without signing in). Try again later.")
  if (!res.ok) throw new HttpError(502, `GitHub answered ${res.status}`)
  return res.json() as Promise<T>
}

type ImportEvent = { t: "progress"; phase: string; percent: number } | { t: "log"; line: string }

/** Download a public repository's text files into browser storage and make it the current project. */
export async function importGitHub(input: string, opts: { name?: string; branch?: string; signal: AbortSignal; onEvent: (e: ImportEvent) => void }) {
  await ready()
  const { owner, repo } = parseGitHub(input)
  const meta = await gh<{ default_branch: string; full_name: string; html_url: string }>(`https://api.github.com/repos/${owner}/${repo}`, opts.signal)
  const branch = opts.branch?.trim() || meta.default_branch
  const tree = await gh<{ tree: { path: string; type: string; size?: number }[]; truncated: boolean }>(`https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`, opts.signal)
  const blobs = tree.tree.filter((e) => e.type === "blob" && !BINARY.test(e.path) && (e.size ?? 0) <= 2 * 1024 * 1024 && !e.path.split("/").some((s) => s === "node_modules" || s === ".git"))
  if (blobs.length > MAX_IMPORT_FILES) throw new HttpError(413, `${meta.full_name} has ${blobs.length} text files — more than the browser can hold comfortably (${MAX_IMPORT_FILES}). Open it with the Kivo daemon instead.`)
  const bytes = blobs.reduce((a, b) => a + (b.size ?? 0), 0)
  if (bytes > MAX_IMPORT_BYTES) throw new HttpError(413, `${meta.full_name} is ${Math.round(bytes / 1e6)} MB of text — too large for browser storage. Open it with the Kivo daemon instead.`)
  opts.onEvent({ t: "log", line: `Importing ${blobs.length} files from ${meta.full_name}@${branch}${tree.truncated ? " (GitHub truncated the listing)" : ""}` })

  const id = crypto.randomUUID()
  const files: Record<string, string> = {}
  let done = 0
  const queue = [...blobs]
  const worker = async () => {
    for (let e = queue.shift(); e; e = queue.shift()) {
      const res = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${e.path.split("/").map(encodeURIComponent).join("/")}`, { signal: opts.signal })
      if (res.ok) {
        const buf = new Uint8Array(await res.arrayBuffer())
        if (!buf.subarray(0, 8192).includes(0)) files[e.path] = new TextDecoder().decode(buf)
      }
      done++
      if (done % 10 === 0 || done === blobs.length) opts.onEvent({ t: "progress", phase: "Downloading files", percent: Math.round((done / blobs.length) * 100) })
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker))
  await MemoryFS.open(`fs:${id}`, async () => files)
  const p: Stored = { id, name: opts.name?.trim() || repo, dir: `github.com/${meta.full_name} (stored in this browser)`, kind: "git", managed: false, remote: meta.html_url, openedAt: Date.now() }
  projects.push(p)
  return makeCurrent(p)
}

// ─── Detection ────────────────────────────────────────────────────────────────

const MANIFEST = /(^|\/)(package\.json|pyproject\.toml|requirements[^/]*\.txt|docker-compose\.ya?ml|compose\.ya?ml|Dockerfile[^/]*|\.env\.example|tsconfig\.json|app\.json|pubspec\.yaml|Cargo\.toml|go\.mod|pom\.xml|build\.gradle(\.kts)?|platformio\.ini|MLproject|dbt_project\.yml|Chart\.yaml|tailwind\.config\.\w+)$/

/** The same analysis the daemon runs: only manifests are read. */
export async function analyze() {
  const f = await currentFS()
  const paths = await f.list()
  let manifests = 0
  const files: RepoFile[] = await Promise.all(
    paths.map(async (p) => {
      const isManifest = MANIFEST.test(p) || /k8s\/.*\.ya?ml$/.test(p)
      const content = isManifest && manifests++ < 400 ? await f.read(p).catch(() => undefined) : undefined
      return { path: p, content, lines: content ? content.split("\n").length : 40 }
    }),
  )
  return { ...analyzeRepository(files), files: paths, project: await currentProject() }
}
