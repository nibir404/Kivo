import { execFile, spawn } from "node:child_process"
import fs from "node:fs"
import type http from "node:http"
import os from "node:os"
import path from "node:path"
import { bus } from "../events/bus"
import { anyBuilding } from "../build/pipeline"
import { HttpError, json, readJson, requireString, sse } from "../http/http"
import { CLONE_ROOT, forgetProject, listProjects, openProject, project, publicProject, switchProject } from "./workspace"

/**
 * Opening projects: a local folder (native picker on macOS, or a path / in-app folder browser),
 * or a git repository cloned with the user's own git credentials (SSH keys, credential helper,
 * `gh auth`). Nothing here deletes or overwrites anything on disk.
 */

const expand = (p: string) => p.replace(/^~(?=$|[\\/])/, os.homedir())

function changed() {
  bus.emit("event", { t: "project", project: publicProject(project()) })
}

/** "owner/repo", a github.com URL, or any https/ssh git URL → a URL git accepts. Never an option. */
export function normalizeRepoUrl(input: string) {
  const s = input.trim()
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) return `https://github.com/${s.replace(/\.git$/, "")}.git`
  if (/^https:\/\/[^\s]+$/.test(s) || /^ssh:\/\/[^\s]+$/.test(s) || /^git@[\w.-]+:[^\s]+$/.test(s)) return s
  throw new HttpError(400, "Enter a repository like owner/repo, https://github.com/owner/repo, or git@github.com:owner/repo.git")
}

export function repoName(url: string) {
  return (url.split(/[/:]/).pop() ?? "repo").replace(/\.git$/, "").replace(/[^\w.-]/g, "-") || "repo"
}

/** Native "choose folder" dialog. macOS only; elsewhere the UI's folder browser is used. */
function pickFolder(): Promise<string | null> {
  if (process.platform !== "darwin") return Promise.reject(new HttpError(501, "The native folder picker is only available on macOS — browse or paste a path instead."))
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", 'POSIX path of (choose folder with prompt "Open a project in Kivo")'], { timeout: 10 * 60_000 }, (err, stdout, stderr) => {
      if (err) {
        // -128 is "User canceled."
        if (/-128|User canceled/i.test(stderr + err.message)) resolve(null)
        else reject(new Error(stderr.trim() || err.message))
      } else resolve(stdout.trim().replace(/\/$/, "") || null)
    })
  })
}

/** Folders inside `dir` for the in-app browser. Only directories are listed; hidden ones are skipped. */
function listDirs(dir: string) {
  const abs = path.resolve(expand(dir || "~"))
  const entries = fs.readdirSync(abs, { withFileTypes: true })
  const dirs = entries
    .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith("."))
    .map((e) => {
      const full = path.join(abs, e.name)
      let isDir = e.isDirectory()
      if (!isDir) isDir = fs.statSync(full, { throwIfNoEntry: false })?.isDirectory() ?? false
      return isDir ? { name: e.name, path: full, git: fs.existsSync(path.join(full, ".git")) } : null
    })
    .filter(Boolean)
    .sort((a, b) => a!.name.localeCompare(b!.name))
    .slice(0, 500)
  return { path: abs, parent: path.dirname(abs) === abs ? null : path.dirname(abs), home: os.homedir(), git: fs.existsSync(path.join(abs, ".git")), dirs }
}

const cloning = new Set<string>()

async function clone(req: http.IncomingMessage, res: http.ServerResponse) {
  const b = await readJson(req)
  const url = normalizeRepoUrl(requireString(b.url, "url", 500))
  const parent = path.resolve(expand(typeof b.parent === "string" && b.parent.trim() ? b.parent : CLONE_ROOT))
  const name = typeof b.name === "string" && /^[\w.-]{1,100}$/.test(b.name) ? b.name : repoName(url)
  const dest = path.join(parent, name)
  const branch = typeof b.branch === "string" && /^[\w./-]{1,200}$/.test(b.branch) && !b.branch.startsWith("-") ? b.branch : undefined
  if (fs.existsSync(dest)) throw new HttpError(409, `${dest} already exists — open it instead, or choose another name.`)
  if (cloning.has(dest)) throw new HttpError(409, "That repository is already being cloned")
  fs.mkdirSync(parent, { recursive: true })

  const ac = new AbortController()
  res.on("close", () => ac.abort())
  const send = sse(res)
  send({ t: "start", url, dest })
  cloning.add(dest)
  const args = ["clone", "--progress", ...(branch ? ["--branch", branch] : []), "--", url, dest]
  // The user's own environment, so their SSH agent and credential helpers work; never prompt on a TTY we don't have.
  const child = spawn("git", args, { env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes" }, signal: ac.signal })
  let tail = ""
  child.stderr.on("data", (d: Buffer) => {
    const text = d.toString()
    tail = (tail + text).slice(-4000)
    for (const line of text.split(/\r|\n/).map((l) => l.trim()).filter(Boolean)) {
      const m = line.match(/^(Receiving objects|Resolving deltas|Counting objects|Compressing objects|Updating files):\s+(\d+)%/)
      send(m ? { t: "progress", phase: m[1], percent: Number(m[2]) } : { t: "log", line })
    }
  })
  const code: number = await new Promise((resolve) => {
    child.on("error", () => resolve(127))
    child.on("close", (c) => resolve(c ?? 1))
  })
  cloning.delete(dest)
  if (code !== 0) {
    if (fs.existsSync(dest) && ac.signal.aborted) fs.rmSync(dest, { recursive: true, force: true })
    const auth = /Authentication failed|could not read Username|Permission denied \(publickey\)|terminal prompts disabled|Repository not found/i.test(tail)
    send({
      t: "error",
      message: code === 127 ? "git isn't installed. On macOS: xcode-select --install" : auth ? "Git couldn't authenticate. For a private repository, sign in first: run `gh auth login` in the terminal, or add an SSH key to GitHub, then try again." : tail.trim().split("\n").pop() || `git clone exited with code ${code}`,
    })
    return res.end()
  }
  const p = openProject(dest)
  changed()
  send({ t: "done", project: publicProject(p) })
  res.end()
}

/** Handles /api/projects*. Returns false for anything else. */
export async function handleProjects(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  const p = url.pathname
  if (!p.startsWith("/api/projects")) return false
  // A build writes into the current project; switching underneath it would split its files across two.
  if (req.method === "POST" && (p === "/api/projects/open" || p === "/api/projects/switch" || p === "/api/projects/clone") && anyBuilding())
    throw new HttpError(409, "A build is running — wait for it to finish before switching projects.")

  if (p === "/api/projects" && req.method === "GET") {
    json(res, 200, { current: publicProject(project()), projects: listProjects().map(publicProject), cloneRoot: CLONE_ROOT, platform: process.platform })
    return true
  }
  if (p === "/api/projects/open" && req.method === "POST") {
    const b = await readJson(req)
    try {
      const opened = openProject(requireString(b.path, "path", 4096))
      changed()
      json(res, 200, { project: publicProject(opened) })
    } catch (err) {
      if (err instanceof HttpError) throw err
      throw new HttpError(400, (err as Error).message)
    }
    return true
  }
  if (p === "/api/projects/switch" && req.method === "POST") {
    const b = await readJson(req)
    try {
      const sw = switchProject(requireString(b.id, "id", 64))
      changed()
      json(res, 200, { project: publicProject(sw) })
    } catch (err) {
      throw new HttpError(404, (err as Error).message)
    }
    return true
  }
  if (p === "/api/projects" && req.method === "DELETE") {
    try {
      forgetProject(requireString(url.searchParams.get("id"), "id", 64))
    } catch (err) {
      throw new HttpError(400, (err as Error).message)
    }
    changed()
    json(res, 200, { ok: true })
    return true
  }
  if (p === "/api/projects/pick" && req.method === "POST") {
    const picked = await pickFolder()
    json(res, 200, { path: picked })
    return true
  }
  if (p === "/api/projects/dirs" && req.method === "GET") {
    try {
      json(res, 200, listDirs(url.searchParams.get("path") ?? "~"))
    } catch (err) {
      throw new HttpError(400, `Can't list that folder: ${(err as Error).message}`)
    }
    return true
  }
  if (p === "/api/projects/clone" && req.method === "POST") {
    await clone(req, res)
    return true
  }
  return false
}
