import { checkAll, configure, GROQ_DEFAULTS } from "@kivo/ai/client"

/**
 * The user's own Groq key for the browser backend. It lives only in this browser's localStorage
 * (never in the deployed files, never sent anywhere but api.groq.com) and is used to call Groq
 * directly from the page.
 */

const KEY = "kivo.groqKey"

function storedKey(): string {
  try {
    return localStorage.getItem(KEY) ?? ""
  } catch {
    return ""
  }
}

function store(key: string) {
  try {
    if (key) localStorage.setItem(KEY, key)
    else localStorage.removeItem(KEY)
  } catch {
    throw new Error("This browser won't let Kivo store the key (site data is blocked)")
  }
}

let checked: ReturnType<typeof checkAll> | null = null

/** Point the shared AI client at Groq with this key and check it against Groq. */
function connectWith(key: string) {
  configure([{ ...GROQ_DEFAULTS, key }], { active: "groq", crossProvider: false })
  checked = checkAll()
  return checked
}

/** Provider status for the stored key (checked once, then cached until the key changes). */
export const providerStatus = () => (checked ??= connectWith(storedKey()))

/**
 * Verify a key with Groq, and only then save it. A key Groq rejects is never stored: the
 * previous one (if any) stays in use. "" removes the stored key.
 */
export async function setKey(key: string) {
  const k = key.trim()
  if (!k) {
    store("")
    return connectWith("")
  }
  if (!/^[\w.-]{20,200}$/.test(k)) throw new Error("That doesn't look like an API key (Groq keys start with gsk_)")
  const d = await connectWith(k)
  const groq = d.providers.find((p) => p.id === "groq")
  if (groq?.status === "unauthorized" || groq?.status === "unreachable") {
    await connectWith(storedKey())
    throw new Error(groq.status === "unauthorized" ? `Groq rejected that key: ${groq.message ?? "unauthorized"}` : `Couldn't reach Groq to check the key: ${groq.message ?? "network error"}`)
  }
  store(k)
  return d
}
