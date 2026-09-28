/**
 * The daemon the e2e suites talk to: the real one (`npm start`), with the UI it serves, on its own
 * port and with its own throwaway data, so tests never touch your projects or ~/Kivo. AI is off
 * (no keys) so results don't depend on a network model; key handling uses a temp key file.
 */
import fs from "node:fs"
import path from "node:path"

const tmp = path.resolve(import.meta.dirname, ".tmp/daemon")
fs.rmSync(tmp, { recursive: true, force: true })
fs.mkdirSync(tmp, { recursive: true })

Object.assign(process.env, {
  KIVO_DAEMON_PORT: process.env.E2E_DAEMON_PORT ?? "4390",
  KIVO_UI_PORT: process.env.E2E_DAEMON_PORT ?? "4390",
  KIVO_HOME: path.join(tmp, "home"),
  KIVO_PROJECTS_DIR: path.join(tmp, "projects"),
  KIVO_KEY_FILE: path.join(tmp, "keys.json"),
  GROQ_API_KEY: "",
  PUKU_API_KEY: "",
  OPENAI_COMPAT_API_KEY: "",
})
if (!process.argv.includes("--serve")) process.argv.push("--serve")

await import("../apps/daemon/src/index.ts")
