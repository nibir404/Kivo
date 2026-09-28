import { aiAvailable, stream } from "@kivo/ai/client"
import { contextFiles, openapiFor, parseFiles, type BuildEvent } from "@kivo/ai/codegen"
import { CODEGEN_SYSTEM, codegenUser } from "@kivo/ai/prompts"
import { PY_SCAFFOLD } from "@kivo/ai/scaffold"
import { validateBuildSpec } from "@kivo/ai/spec"
import { specToYaml } from "@kivo/core/intent"
import { planFor } from "@kivo/core/plan"
import type { PlanStep } from "@kivo/core/types"
import { bus } from "../bus"
import { HttpError, readJson, requireObject, sse } from "../http"
import { currentFS, currentProject } from "../projects"
import { providerStatus } from "../settings"
import type { Route } from "./types"

/**
 * Building a service in the browser: every code-generation step runs for real (Groq writes the
 * files into the project), exactly as the daemon's pipeline does it. Installing packages, running
 * the tests and booting the service need Python and a process on your computer, so those steps
 * are reported as skipped, with the reason — nothing is simulated.
 */

const NEEDS_DAEMON: Record<string, string> = {
  install: "Skipped — installing packages needs the Kivo daemon on your computer (npm run dev). The code is written; nothing was installed.",
  tests: "Skipped running them — the tests are written, but running them needs the Kivo daemon on your computer.",
  boot: "Skipped — starting the service needs the Kivo daemon on your computer.",
}

const building = new Set<string>()

export const buildRoutes: Route[] = [
  [
    "POST",
    "/api/build",
    async (req) => {
      await providerStatus()
      if (!aiAvailable()) throw new HttpError(503, "Add your Groq API key in Preferences → AI to build in the browser.")
      const spec = validateBuildSpec(requireObject((await readJson(req)).spec, "spec"))
      if (building.has(spec.id)) throw new HttpError(409, `${spec.name} is already being built`)
      const fs = await currentFS()
      const project = await currentProject()
      return sse(req, async (send, signal) => {
        const emit = (e: BuildEvent) => send(e)
        building.add(spec.id)
        try {
          const serviceRel = `services/${spec.id}`
          const py = spec.implementation.language === "python"
          const written: Record<string, string> = {}
          const log = (id: string, text: string) => emit({ t: "log", id, text })
          const save = async (stepId: string, rel: string, content: string) => {
            const full = rel.startsWith(serviceRel + "/") ? rel : `${serviceRel}/${rel.replace(/^\.?\//, "")}`
            if (/^(<<<<<<< SEARCH|>>>>>>> REPLACE)\s*$/m.test(content)) {
              log(stepId, `! refused to write ${full.split("/").pop()}: it contained unapplied edit markers`)
              return
            }
            await fs.write(full, content)
            written[full.slice(serviceRel.length + 1)] = content
            emit({ t: "file", id: stepId, path: full })
            bus.emit({ t: "fs", project: project.id, paths: [full] })
          }

          const generate = async (step: PlanStep) => {
            const scaffold = py ? PY_SCAFFOLD : {}
            const all = step.artifacts.map((a) => a.slice(serviceRel.length + 1))
            for (const rel of all) if (scaffold[rel]) await save(step.id, rel, scaffold[rel])
            const rels = all.filter((r) => !scaffold[r])
            if (!rels.length) return
            const base = codegenUser(spec, step, rels, contextFiles(written))
            for (let attempt = 1; attempt <= 2; attempt++) {
              let finish = "stop"
              const content = await stream(
                [
                  { role: "system", content: CODEGEN_SYSTEM },
                  { role: "user", content: attempt === 1 ? base : `${base}\n\nIMPORTANT: your previous answer was cut off at the output limit. Be much more concise: no docstrings, no comments, minimal code that still meets every requirement.` },
                ],
                (d) => emit({ t: "delta", id: step.id, channel: d.channel, text: d.text }),
                {
                  effort: "low",
                  maxTokens: 6000,
                  signal,
                  onFinish: (r) => (finish = r),
                  onRateLimit: ({ model, waitMs, next }) => log(step.id, waitMs ? `⏳ Rate limit reached on ${model} — waiting ${Math.ceil(waitMs / 1000)}s, then retrying` : `↻ ${model} is rate-limited — switching to ${next}`),
                },
              )
              const files = parseFiles(content, finish === "length")
              if (files.length) {
                if (finish === "length") log(step.id, "! Output hit the token limit — kept only the complete files")
                for (const f of files) if (!scaffold[f.path]) await save(step.id, f.path, f.content)
                return
              }
              log(step.id, finish === "length" ? "! Output was cut off before any file completed — retrying with a more concise request" : "! The model returned no files — retrying")
            }
            throw new Error("The model returned no complete files after a retry.")
          }

          const runStep = async (step: PlanStep): Promise<string | undefined> => {
            switch (step.id) {
              case "understand":
                await save(step.id, "kivo.service.yaml", specToYaml(spec) + "\n")
                return "Service IR written."
              case "api":
                await save(step.id, "openapi.yaml", openapiFor(spec))
                return `Contract derived from the IR: ${spec.api.endpoints.length} endpoints.`
              case "storage": {
                const compose = await fs.read("docker-compose.yml").catch(() => "")
                const db = spec.storage.type.toLowerCase()
                log(step.id, compose.includes(db.slice(0, 6)) ? `✓ docker-compose.yml already declares ${spec.storage.type}` : `! ${spec.storage.type} not in docker-compose.yml — using SQLite for local runs`)
                await save(step.id, ".env.example", `# Local runs default to SQLite. Point at ${spec.storage.type} for production:\nDATABASE_URL=postgresql://tandem:tandem@localhost/tandem\n${spec.cache ? "REDIS_URL=redis://localhost:6379/0\n" : ""}JWT_SECRET=change-me\n`)
                return "DATABASE_URL wired; SQLite by default so it runs without containers."
              }
              case "install":
              case "boot":
                return NEEDS_DAEMON[step.id]
              case "tests":
                await generate(step)
                return NEEDS_DAEMON.tests
              default:
                if (step.executor === "ai") await generate(step)
                return undefined
            }
          }

          let ok = true
          let blocked = false
          if (await fs.stat(serviceRel)) await fs.remove(serviceRel)
          for (const step of planFor(spec)) {
            if (signal.aborted) return
            if (blocked) {
              emit({ t: "step", id: step.id, status: "skipped", note: "Skipped — an earlier step failed." })
              continue
            }
            emit({ t: "step", id: step.id, status: "active" })
            try {
              const note = await runStep(step)
              emit({ t: "step", id: step.id, status: note?.startsWith("Skipped") ? "skipped" : "done", note })
            } catch (err) {
              if (signal.aborted) return
              ok = false
              const message = (err as Error).message
              log(step.id, `✗ ${message}`)
              emit({ t: "step", id: step.id, status: "failed", note: message })
              if (step.id === "understand") blocked = true
            }
          }
          emit({ t: "done", ok })
        } finally {
          building.delete(spec.id)
        }
      })
    },
  ],
]
