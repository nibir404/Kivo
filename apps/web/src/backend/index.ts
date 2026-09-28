import { HttpError, json } from "./http"
import { agentControl, agentRoutes } from "./routes/agent"
import { aiRoutes } from "./routes/ai"
import { buildRoutes } from "./routes/build"
import { coreRoutes } from "./routes/core"
import { editorRoutes } from "./routes/editor"
import type { Route } from "./routes/types"
import { providerStatus } from "./settings"

/**
 * Kivo's browser backend: the daemon's HTTP API, answered inside the page for the hosted web app.
 * Same routes, same request and response shapes, same errors — so the UI works unchanged. What
 * genuinely needs a computer (a shell, git, running Python) answers 501 with a clear reason.
 */

const ROUTES: Route[] = [...coreRoutes, ...editorRoutes, ...aiRoutes, ...agentRoutes, ...buildRoutes]

const NEEDS_DAEMON: [RegExp, string][] = [
  [/^\/api\/scm\//, "Source control (git) needs the Kivo daemon on your computer (npm run dev)."],
  [/^\/api\/terminals/, "The terminal needs the Kivo daemon on your computer (npm run dev)."],
]

export function createBackend() {
  void providerStatus()
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    try {
      const route = ROUTES.find(([m, p]) => m === req.method && p === url.pathname)
      if (route) return await route[2](req, url)
      const control = await agentControl(req, url)
      if (control) return control
      for (const [re, message] of NEEDS_DAEMON) if (re.test(url.pathname)) return json(501, { error: message })
      return json(404, { error: "not found" })
    } catch (err) {
      if (err instanceof HttpError) return json(err.status, { error: err.message })
      if ((err as Error).name === "AbortError") throw err
      console.error(`[kivo] ${req.method} ${url.pathname} failed:`, err)
      return json(500, { error: (err as Error).message })
    }
  }
}
