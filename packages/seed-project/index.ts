import fs from "node:fs"
import path from "node:path"

/** Where the demo project's files live. The daemon copies this folder into its workspace on first run. */
export const SEED_DIR = path.join(import.meta.dirname, "files")

/** Every demo file as text, keyed by project-relative path (the web app bundles this for the in-browser demo). */
export function readSeedFiles(dir = SEED_DIR): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (abs: string, rel: string) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.name === ".DS_Store") continue
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(path.join(abs, e.name), r)
      else if (e.isFile()) out[r] = fs.readFileSync(path.join(abs, e.name), "utf8")
    }
  }
  walk(dir, "")
  return out
}
