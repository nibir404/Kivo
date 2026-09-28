import { buildMatcher, findInText, globFilter, matchLine, previewHit, replaceInText, splitLines, type MatchOptions } from "@kivo/core/match"
import type { SearchHit, SearchResult } from "@/lib/editor-api"
import { bus } from "../bus"
import { baseName, cleanPath, parentOf, type ProjectFS } from "../fs/types"
import { HttpError, json, readJson, requireString } from "../http"
import { currentFS, currentProject } from "../projects"
import type { Route } from "./types"

/**
 * The explorer's file operations and find/replace in files, over the current project's files —
 * the same answers the daemon's /api/editor routes give. Search is a scan with the shared matcher
 * (@kivo/core/match), so results and replacements match the daemon's exactly.
 */

async function changed(paths: string[]) {
  bus.emit({ t: "fs", project: (await currentProject()).id, paths })
}

function matchOptions(b: Record<string, unknown>): MatchOptions & { include?: string; exclude?: string } {
  const opt = (v: unknown, field: string) => {
    if (v === undefined || v === null || v === "") return undefined
    if (typeof v !== "string" || v.length > 2000) throw new HttpError(400, `"${field}" must be a string`)
    return v
  }
  return {
    query: requireString(b.query, "query", 2000),
    regex: b.regex === true,
    caseSensitive: b.caseSensitive === true,
    wholeWord: b.wholeWord === true,
    include: opt(b.include, "include"),
    exclude: opt(b.exclude, "exclude"),
  }
}

function matcher(q: MatchOptions) {
  try {
    return buildMatcher(q)
  } catch (err) {
    throw new HttpError(400, (err as Error).message)
  }
}

function filterFor(q: { include?: string; exclude?: string }) {
  const inc = globFilter(q.include)
  const exc = globFilter(q.exclude)
  return (p: string) => (!inc || inc(p)) && !(exc && exc(p))
}

/** A searchable text file, or null (binary, too large, unreadable). */
const text = (fs: ProjectFS, rel: string) => fs.read(rel).catch(() => null)

async function search(fs: ProjectFS, b: Record<string, unknown>): Promise<SearchResult> {
  const q = matchOptions(b)
  const re = matcher(q)
  const keep = filterFor(q)
  const max = Math.min(Math.max(1, Math.floor(typeof b.maxResults === "number" ? b.maxResults : 2000)), 10_000)
  const files: { path: string; matches: SearchHit[] }[] = []
  let total = 0
  let truncated = false
  outer: for (const file of await fs.list()) {
    if (!keep(file)) continue
    const t = await text(fs, file)
    if (t === null) continue
    const lines = splitLines(t)
    let hits: SearchHit[] | null = null
    for (let i = 0; i < lines.length; i++) {
      for (const m of matchLine(re, lines[i].text, i + 1)) {
        if (total >= max) {
          truncated = true
          break outer
        }
        if (!hits) files.push({ path: file, matches: (hits = []) })
        hits.push(previewHit(lines[i].text, i + 1, m.col, m.len))
        total++
      }
    }
  }
  return { files, total, truncated, engine: "js" }
}

async function replace(fs: ProjectFS, b: Record<string, unknown>) {
  const q = matchOptions(b)
  if (typeof b.replace !== "string" || b.replace.length > 100_000) throw new HttpError(400, '"replace" must be a string')
  const strings = (v: unknown, field: string) => {
    if (v === undefined) return undefined
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new HttpError(400, `"${field}" must be an array of strings`)
    return v as string[]
  }
  const re = matcher(q)
  const keep = filterFor(q)
  const skip = new Set(strings(b.skip, "skip") ?? [])
  const paths = strings(b.paths, "paths")
  const candidates = paths ? paths.map((p) => cleanPath(p, { write: true })) : (await fs.list()).filter(keep)
  const out: { path: string; count: number }[] = []
  let total = 0
  for (const file of candidates) {
    if (skip.has(file)) continue
    const t = await text(fs, file)
    if (t === null) continue
    if (b.dryRun === true) {
      const count = findInText(re, t).length
      if (count) out.push({ path: file, count })
      total += count
      continue
    }
    const next = replaceInText(re, t, b.replace, !!q.regex)
    if (!next.count) continue
    await fs.write(file, next.text)
    out.push({ path: file, count: next.count })
    total += next.count
  }
  if (b.dryRun !== true && out.length) await changed(out.map((f) => f.path))
  return { files: out, total }
}

/** Folders with no files in them (the explorer shows them; a file list can't). */
async function emptyDirs(fs: ProjectFS) {
  const files = await fs.list()
  const withFiles = new Set<string>()
  for (const f of files) for (let p = parentOf(f); p; p = parentOf(p)) withFiles.add(p)
  return (await fs.dirs()).filter((d) => !withFiles.has(d) && !d.split("/").some((s) => s === "node_modules" || s === ".git"))
}

async function freeName(fs: ProjectFS, rel: string, isDir: boolean) {
  const name = baseName(rel)
  const dot = isDir ? -1 : name.lastIndexOf(".")
  const ext = dot > 0 ? name.slice(dot) : ""
  const stem = rel.slice(0, rel.length - ext.length)
  let dst = `${stem} copy${ext}`
  for (let n = 2; await fs.stat(dst); n++) dst = `${stem} copy ${n}${ext}`
  return dst
}

export const editorRoutes: Route[] = [
  ["GET", "/api/editor/dirs", async () => json(200, { dirs: await emptyDirs(await currentFS()) })],
  [
    "POST",
    "/api/editor/create",
    async (req) => {
      const b = await readJson(req)
      if (b.kind !== "file" && b.kind !== "folder") throw new HttpError(400, '"kind" must be "file" or "folder"')
      const rel = cleanPath(b.path, { write: true })
      const fs = await currentFS()
      if (await fs.stat(rel)) throw new HttpError(409, `${rel} already exists`)
      if (b.kind === "folder") await fs.mkdir(rel)
      else await fs.write(rel, "")
      await changed([rel])
      return json(200, { path: rel })
    },
  ],
  [
    "POST",
    "/api/editor/rename",
    async (req) => {
      const b = await readJson(req)
      const from = cleanPath(b.from, { field: "from", write: true })
      const to = cleanPath(b.to, { field: "to", write: true })
      const fs = await currentFS()
      if (!(await fs.stat(from))) throw new HttpError(404, `${from} doesn't exist`)
      if (from === to) return json(200, { path: to })
      if (to.startsWith(`${from}/`)) throw new HttpError(400, "Can't move a folder into itself")
      if ((await fs.stat(to)) && from.toLowerCase() !== to.toLowerCase()) throw new HttpError(409, `${to} already exists`)
      await fs.rename(from, to)
      await changed([from, to])
      return json(200, { path: to })
    },
  ],
  [
    "POST",
    "/api/editor/duplicate",
    async (req) => {
      const rel = cleanPath((await readJson(req)).path, { write: true })
      const fs = await currentFS()
      const kind = await fs.stat(rel)
      if (!kind) throw new HttpError(404, `${rel} doesn't exist`)
      const dst = await freeName(fs, rel, kind === "dir")
      await fs.copy(rel, dst)
      await changed([dst])
      return json(200, { path: dst })
    },
  ],
  [
    "POST",
    "/api/editor/trash",
    async (req) => {
      // A browser has no system trash to move things to: this deletes, after the UI's confirmation says so.
      const rel = cleanPath((await readJson(req)).path, { write: true })
      const fs = await currentFS()
      if (!(await fs.stat(rel))) throw new HttpError(404, `${rel} doesn't exist`)
      await fs.remove(rel)
      await changed([rel])
      return json(200, { trashed: "" })
    },
  ],
  ["POST", "/api/editor/reveal", async () => json(501, { error: "Showing a file in Finder needs the Kivo daemon on your computer." })],
  ["POST", "/api/editor/search", async (req) => json(200, await search(await currentFS(), await readJson(req)))],
  ["POST", "/api/editor/replace", async (req) => json(200, await replace(await currentFS(), await readJson(req)))],
]
