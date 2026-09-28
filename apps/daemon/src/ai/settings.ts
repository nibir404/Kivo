import fs from "node:fs"
import path from "node:path"
import { AI_OPTIONS, checkAll, configure, describe, PROVIDERS } from "./ai"

/**
 * A Groq key pasted into the app, for installs without a .env (the desktop app sets KIVO_KEY_FILE
 * to a file in its user-data folder). The file is readable only by this user, the key never goes
 * to the UI, and a key Groq rejects is never saved. Without KIVO_KEY_FILE keys come from .env only.
 */

const KEY_FILE = process.env.KIVO_KEY_FILE ? path.resolve(process.env.KIVO_KEY_FILE) : null
const groq = PROVIDERS.find((p) => p.id === "groq")!
const fromEnv = groq.key

export const keyEditable = () => !!KEY_FILE

function saved(): string {
  if (!KEY_FILE) return ""
  try {
    const v = JSON.parse(fs.readFileSync(KEY_FILE, "utf8")) as { groq?: unknown }
    return typeof v.groq === "string" ? v.groq : ""
  } catch {
    return ""
  }
}

function applyKey(key: string | undefined) {
  groq.key = key || undefined
  // Keep whichever provider the user picked; only the key changes.
  configure(PROVIDERS, { ...AI_OPTIONS, active: describe().active })
}

/** Apply the saved key, if any, over the one from the environment. Call before the first checkAll. */
export function loadSavedKey() {
  const k = saved()
  if (k) applyKey(k)
}

export async function setGroqKey(key: string) {
  if (!KEY_FILE) throw new Error("This Kivo reads its keys from .env — set GROQ_API_KEY there")
  const k = key.trim()
  if (k && !/^[\w.-]{20,200}$/.test(k)) throw new Error("That doesn't look like an API key (Groq keys start with gsk_)")
  const before = groq.key
  applyKey(k || fromEnv)
  const d = await checkAll()
  const p = d.providers.find((x) => x.id === "groq")
  if (k && (p?.status === "unauthorized" || p?.status === "unreachable")) {
    applyKey(before)
    await checkAll()
    throw new Error(p.status === "unauthorized" ? `Groq rejected that key: ${p.message ?? "unauthorized"}` : `Couldn't reach Groq to check the key: ${p.message ?? "network error"}`)
  }
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true })
  if (k) fs.writeFileSync(KEY_FILE, JSON.stringify({ groq: k }), { mode: 0o600 })
  else fs.rmSync(KEY_FILE, { force: true })
  return d
}
