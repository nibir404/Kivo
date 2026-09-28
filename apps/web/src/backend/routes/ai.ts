import { cleanCompletion, COMPLETE_SYSTEM, completionPrompt } from "@kivo/ai/agent"
import { aiAvailable, CompletionRateLimited, parseJsonLoose, quickComplete, stream, type Msg } from "@kivo/ai/client"
import { chatSystem, EDIT_SYSTEM, editUser, INTENT_SYSTEM, intentUser } from "@kivo/ai/prompts"
import { normalizeSpec, parseServices, projectContext, resolveStack, sanitizeStack } from "@kivo/ai/spec"
import { HttpError, json, readJson, requireString, sse } from "../http"
import { analyze, currentProject } from "../projects"
import { providerStatus } from "../settings"
import type { Route } from "./types"

/** Plan (intent → spec), Ask, inline edits and autocomplete — Groq called from the page with the user's key. */

async function requireAi() {
  await providerStatus()
  if (!aiAvailable()) throw new HttpError(503, "Add your Groq API key in Preferences → AI to use Kivo's AI in the browser.")
}

const EXT_LANG: Record<string, string> = { py: "Python 3.9 (typing.Optional, no X | Y unions)", ts: "TypeScript", tsx: "TypeScript + React", js: "JavaScript", java: "Java", kt: "Kotlin", go: "Go", rs: "Rust", sql: "SQL" }

async function editNote(file: string) {
  const lang = EXT_LANG[file.split(".").pop() ?? ""]
  return `Project: ${(await currentProject()).name}. ${lang ? `This file is ${lang}.` : ""}`.trim()
}

export const aiRoutes: Route[] = [
  [
    "POST",
    "/api/ai/intent",
    async (req) => {
      await requireAi()
      const b = await readJson(req)
      const text = requireString(b.text, "text", 4000)
      const stack = resolveStack(text, sanitizeStack(b.stack))
      const context = projectContext(await analyze(), parseServices(b.services))
      return sse(req, async (send, signal) => {
        const content = await stream(
          [
            { role: "system", content: INTENT_SYSTEM },
            { role: "user", content: intentUser(text, stack, context) },
          ],
          (d) => send({ t: "delta", ...d }),
          { json: true, effort: "medium", signal, onRateLimit: (r) => send({ t: "wait", ...r }) },
        )
        send({ t: "result", spec: normalizeSpec(parseJsonLoose(content), text, stack) })
      })
    },
  ],
  [
    "POST",
    "/api/ai/chat",
    async (req) => {
      await requireAi()
      const b = await readJson(req)
      if (!Array.isArray(b.messages)) throw new HttpError(400, '"messages" must be an array')
      const messages = (b.messages as Msg[]).filter((m) => (m?.role === "user" || m?.role === "assistant") && typeof m.content === "string").slice(-12)
      return sse(req, async (send, signal) => {
        await stream([{ role: "system", content: chatSystem(String(b.level ?? "intermediate"), String(b.context ?? "").slice(0, 40_000)) }, ...messages], (d) => send({ t: "delta", ...d }), {
          effort: "low",
          maxTokens: 2048,
          signal,
          onRateLimit: (r) => send({ t: "wait", ...r }),
        })
        send({ t: "done" })
      })
    },
  ],
  [
    "POST",
    "/api/ai/edit",
    async (req) => {
      await requireAi()
      const b = await readJson(req)
      const file = requireString(b.path, "path", 1024)
      const content = typeof b.content === "string" ? b.content : ""
      const from = Math.max(0, Math.min(Number(b.from) || 0, content.length))
      const to = Math.max(from, Math.min(Number(b.to) || 0, content.length))
      const instruction = requireString(b.instruction, "instruction", 4000)
      const projectNote = await editNote(file)
      return sse(req, async (send, signal) => {
        await stream(
          [
            { role: "system", content: EDIT_SYSTEM },
            { role: "user", content: editUser({ path: file, before: content.slice(0, from), region: content.slice(from, to), after: content.slice(to), instruction, previous: typeof b.previous === "string" ? b.previous : undefined, projectNote }) },
          ],
          (d) => send({ t: "delta", ...d }),
          { effort: "low", maxTokens: 3000, signal, onRateLimit: (r) => send({ t: "wait", ...r }) },
        )
        send({ t: "done" })
      })
    },
  ],
  [
    "POST",
    "/api/ai/complete",
    async (req) => {
      await providerStatus()
      if (!aiAvailable()) return json(503, { error: "No AI provider is available" })
      const b = await readJson(req)
      const prefix = typeof b.prefix === "string" ? b.prefix.slice(-1500) : ""
      const suffix = typeof b.suffix === "string" ? b.suffix.slice(0, 500) : ""
      const file = typeof b.path === "string" ? b.path.slice(0, 300) : "untitled"
      const language = typeof b.language === "string" ? b.language.slice(0, 40) : ""
      if (!prefix.trim()) return json(200, { completion: "" })
      try {
        const r = await quickComplete(
          [
            { role: "system", content: COMPLETE_SYSTEM },
            { role: "user", content: completionPrompt(file, language, prefix, suffix) },
          ],
          { signal: req.signal, maxTokens: 512 },
        )
        return json(200, { completion: cleanCompletion(r.text, prefix, suffix), model: r.model })
      } catch (err) {
        if (err instanceof CompletionRateLimited) return json(429, { error: "rate limited", retryAfterMs: err.waitMs })
        if (req.signal.aborted) throw err
        return json(502, { error: (err as Error).message })
      }
    },
  ],
]
