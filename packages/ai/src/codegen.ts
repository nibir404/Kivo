import type { ServiceSpec } from "@kivo/core/types"

/**
 * The host-independent half of a build: what the pipeline streams to the UI, and how model output
 * becomes files and edits. The daemon runs the full pipeline (installs, tests, boot); the browser
 * runs the code-generation steps only.
 */

export type BuildEvent =
  | { t: "step"; id: string; status: "active" | "done" | "failed" | "skipped"; note?: string }
  | { t: "delta"; id: string; channel: "reasoning" | "content"; text: string }
  | { t: "log"; id: string; text: string }
  | { t: "file"; id: string; path: string }
  | { t: "tests"; results: { name: string; status: "pass" | "fail" }[] }
  | { t: "url"; url: string; routes: string[] }
  | { t: "done"; ok: boolean; commit?: string }
  | { t: "error"; message: string }

const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1)

/**
 * Split model output on "=== FILE: path ===" headers. END markers are optional (models drop them);
 * if the response was truncated, the last block is incomplete and is discarded.
 */
export function parseFiles(text: string, truncated = false) {
  const headers = [...text.matchAll(/^=== FILE: (.+?) ===\s*$/gm)]
  const out: { path: string; content: string }[] = []
  headers.forEach((h, i) => {
    const start = h.index! + h[0].length
    const end = i + 1 < headers.length ? headers[i + 1].index! : text.length
    const raw = text.slice(start, end)
    const hasEnd = /^=== END FILE ===\s*$/m.test(raw)
    if (truncated && i === headers.length - 1 && !hasEnd) return
    let content = raw
      .replace(/^=== END FILE ===[\s\S]*$/m, "")
      .replace(/^\r?\n/, "")
      .replace(/^```[\w-]*\n/, "")
      .replace(/\n```\s*$/, "")
      .trimEnd()
    content += "\n"
    const p = h[1].trim().replace(/^`|`$/g, "")
    if (!p.includes("..") && content.trim()) out.push({ path: p, content })
  })
  return out
}

export function parseEdits(text: string) {
  const out: { path: string; search: string; replace: string }[] = []
  const blocks = text.split(/^=== EDIT: (.+?) ===\s*$/m)
  for (let i = 1; i < blocks.length; i += 2) {
    const p = blocks[i].trim()
    for (const m of blocks[i + 1].matchAll(/<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n?>>>>>>> REPLACE/g)) {
      out.push({ path: p, search: m[1], replace: m[2] })
    }
  }
  return out
}

const CORE_FILES = /^(db|models|main|router|schemas)\.py$/

/**
 * Keep prompts inside the free-tier token budget: core modules in full, everything else
 * reduced to its public surface (imports, signatures, top-level names).
 */
export function contextFiles(files: Record<string, string>, failure = "", repairing = false) {
  const out: Record<string, string> = {}
  const code = Object.entries(files).filter(([p]) => p.endsWith(".py"))
  if (!repairing) {
    for (const [p, c] of code) out[p] = CORE_FILES.test(p) || failure.includes(baseName(p)) ? c : surface(c)
    return out
  }
  // Repairs can only edit what they can see verbatim: fill a character budget with full files by priority.
  const rank = ([p]: [string, string]) =>
    (failure.includes(baseName(p)) ? 0 : 10) + (p.startsWith("tests/conftest") ? 1 : p.startsWith("tests/") ? 2 : /^(router|db)\.py$/.test(p) ? 3 : /^models\.py$/.test(p) ? 4 : 6)
  let budget = 14_000
  for (const [p, c] of [...code].sort((a, b) => rank(a) - rank(b))) {
    if (c.length <= budget) {
      out[p] = c
      budget -= c.length
    } else out[`${p} (SIGNATURES ONLY — do not edit)`] = surface(c)
  }
  return out
}

function surface(code: string) {
  return code
    .split("\n")
    .filter((l) => /^(from |import |class |def |async def |@|[A-Z_][A-Z0-9_]* ?=|    def |    async def )/.test(l))
    .join("\n")
}

export function openapiFor(spec: ServiceSpec) {
  const lines = ["openapi: 3.1.0", "info:", `  title: ${spec.name}`, "  version: 0.1.0", `  description: "${spec.purpose.replace(/"/g, "'")}"`, "paths:"]
  const byPath = new Map<string, typeof spec.api.endpoints>()
  for (const e of spec.api.endpoints) byPath.set(e.path, [...(byPath.get(e.path) ?? []), e])
  for (const [p, eps] of byPath) {
    lines.push(`  ${p}:`)
    for (const e of eps) {
      lines.push(`    ${e.method.toLowerCase()}:`, `      summary: "${e.summary.replace(/"/g, "'")}"`, `      x-kivo-requirement: ${e.requirement}`)
      if (e.auth) lines.push("      security: [{ bearer: [] }]")
      lines.push("      responses:", '        "200": { description: OK }')
    }
  }
  lines.push("components:", "  securitySchemes:", "    bearer: { type: http, scheme: bearer, bearerFormat: JWT }")
  return lines.join("\n") + "\n"
}
