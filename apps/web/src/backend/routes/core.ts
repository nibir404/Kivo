import { aiAvailable, currentModel } from "@kivo/ai/client"
import { bus } from "../bus"
import { cleanPath } from "../fs/types"
import { HttpError, json, readJson, requireString, sse } from "../http"
import { analyze, currentFS, currentProject, forget, importGitHub, listProjects, openPicked, pickFolder, resetDemo, switchTo } from "../projects"
import { providerStatus, setKey } from "../settings"
import type { Route } from "./types"

/** Health, providers, the project and its files — the daemon's core routes, in the browser. */

async function health() {
  const d = await providerStatus()
  const p = await currentProject()
  // No toolchains here: the browser can't run builds' installs, tests or servers (the build says so per step).
  return { ...d, ai: aiAvailable(), model: currentModel(), project: p.name, projectInfo: p, toolchains: {}, mode: "browser" as const }
}

const NEEDS_DAEMON = "needs the Kivo daemon on your computer (npm run dev)"

export const coreRoutes: Route[] = [
  ["GET", "/api/health", async () => json(200, await health())],
  ["GET", "/api/providers", async () => json(200, await providerStatus())],
  [
    "POST",
    "/api/providers/active",
    async (req) => {
      const b = await readJson(req)
      if (b.id !== "groq") throw new HttpError(400, "In the browser Kivo uses Groq with your own key")
      return json(200, await providerStatus())
    },
  ],
  [
    "POST",
    "/api/settings/key",
    async (req) => {
      const b = await readJson(req)
      if (typeof b.key !== "string") throw new HttpError(400, '"key" must be a string')
      try {
        return json(200, await setKey(b.key))
      } catch (err) {
        throw new HttpError(400, (err as Error).message)
      }
    },
  ],
  ["GET", "/api/project", async () => json(200, await analyze())],
  ["GET", "/api/fs/tree", async () => json(200, { files: await (await currentFS()).list() })],
  [
    "GET",
    "/api/fs/read",
    async (_req, url) => {
      const rel = cleanPath(url.searchParams.get("path"))
      return json(200, { path: rel, content: await (await currentFS()).read(rel) })
    },
  ],
  [
    "PUT",
    "/api/fs/write",
    async (req) => {
      const b = await readJson(req)
      const rel = cleanPath(b.path, { write: true })
      if (typeof b.content !== "string") throw new HttpError(400, '"content" must be a string')
      await (await currentFS()).write(rel, b.content)
      bus.emit({ t: "fs", project: (await currentProject()).id, paths: [rel] })
      return json(200, { ok: true })
    },
  ],
  ["GET", "/api/git/log", async () => json(200, { log: "" })],
  ["GET", "/api/terminals", async () => json(200, { terminals: [] })],
  ["DELETE", "/api/terminals", async () => json(200, { ok: true })],
  ["POST", "/api/proxy", async () => json(501, { error: `Calling a running service ${NEEDS_DAEMON}.` })],

  // ─── Projects ────────────────────────────────────────────────────────────
  ["GET", "/api/projects", async () => json(200, { current: await currentProject(), projects: await listProjects(), cloneRoot: "", platform: "browser" })],
  ["POST", "/api/projects/pick", async () => json(200, { path: await pickFolder() })],
  ["POST", "/api/projects/open", async (req) => json(200, { project: await openPicked(requireString((await readJson(req)).path, "path", 200)) })],
  ["POST", "/api/projects/switch", async (req) => json(200, { project: await switchTo(requireString((await readJson(req)).id, "id", 64)) })],
  [
    "DELETE",
    "/api/projects",
    async (_req, url) => {
      await forget(requireString(url.searchParams.get("id"), "id", 64))
      return json(200, { ok: true })
    },
  ],
  [
    "POST",
    "/api/projects/reset-demo",
    async () => {
      await resetDemo()
      return json(200, { ok: true })
    },
  ],
  ["GET", "/api/projects/dirs", async () => json(501, { error: "In the browser, choose a folder with the browser's own picker." })],
  [
    "POST",
    "/api/projects/clone",
    async (req) => {
      const b = await readJson(req)
      const url = requireString(b.url, "url", 500)
      return sse(req, async (send, signal) => {
        send({ t: "start", url, dest: "this browser" })
        const project = await importGitHub(url, { name: typeof b.name === "string" ? b.name : undefined, branch: typeof b.branch === "string" ? b.branch : undefined, signal, onEvent: send })
        send({ t: "done", project })
      })
    },
  ],
]
