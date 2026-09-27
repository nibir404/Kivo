import { execFile } from "node:child_process"
import { languageName, toolchainFor, TOOLCHAINS } from "../src/core/stacks"

/**
 * Preflight for the build pipeline: can this machine actually build a service in this language?
 * Checked before any AI call, so a build never spends tokens only to fail on a missing tool.
 */

export interface ToolchainStatus {
  language: string
  ok: boolean
  version?: string
  message?: string
}

const cache = new Map<string, { at: number; status: ToolchainStatus }>()
const TTL = 60_000

function probe(cmd: string, args: string[]) {
  return new Promise<{ ok: boolean; output: string }>((resolve) => {
    execFile(cmd, args, { timeout: 10_000 }, (err, stdout, stderr) => resolve({ ok: !err, output: `${stdout}${stderr}`.trim() }))
  })
}

async function check(language: string): Promise<ToolchainStatus> {
  if (!toolchainFor(language).buildable) {
    return { language, ok: false, message: `Kivo can plan ${languageName(language)} services, but can't build and test them yet. Python is fully supported.` }
  }
  if (language === "python") {
    const r = await probe("python3", ["--version"])
    if (!r.ok) return { language, ok: false, message: "Python 3 isn't installed or isn't on PATH. Install Python 3.9 or newer (e.g. brew install python@3.12)." }
    const [, major, minor] = r.output.match(/Python (\d+)\.(\d+)/) ?? []
    if (Number(major) < 3 || (Number(major) === 3 && Number(minor) < 9)) return { language, ok: false, version: r.output, message: `${r.output} is too old — Kivo needs Python 3.9 or newer.` }
    return { language, ok: true, version: r.output.replace("Python ", "") }
  }
  return { language, ok: false, message: `No build pipeline for ${languageName(language)}.` }
}

export async function toolchainStatus(language: string, fresh = false): Promise<ToolchainStatus> {
  const hit = cache.get(language)
  if (!fresh && hit && Date.now() - hit.at < TTL) return hit.status
  const status = await check(language)
  cache.set(language, { at: Date.now(), status })
  return status
}

/** Status of every buildable toolchain — shown by the UI before a build starts. */
export async function allToolchains() {
  const langs = Object.keys(TOOLCHAINS).filter((l) => toolchainFor(l).buildable)
  return Object.fromEntries(await Promise.all(langs.map(async (l) => [l, await toolchainStatus(l)] as const)))
}
