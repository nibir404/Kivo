import { HttpError } from "@kivo/ai/errors"

/** Response helpers for the browser backend: the same shapes (and error bodies) the daemon sends. */

export { HttpError }

export const json = (status: number, data: unknown) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } })

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text()
  if (!text) return {}
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    throw new HttpError(400, "Request body is not valid JSON")
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, "Request body must be a JSON object")
  return v as Record<string, unknown>
}

export function requireString(v: unknown, field: string, max = 200_000): string {
  if (typeof v !== "string" || !v.trim()) throw new HttpError(400, `"${field}" must be a non-empty string`)
  if (v.length > max) throw new HttpError(400, `"${field}" is too long`)
  return v
}

export function requireObject<T>(v: unknown, field: string): T {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, `"${field}" must be an object`)
  return v as T
}

/**
 * A server-sent event stream, like the daemon's. `run` gets `send` and the request's abort signal
 * (the UI aborting the fetch aborts the work). A failure after the stream started becomes a
 * `{ t: "error" }` frame, which the client turns into a rejected promise.
 */
export function sse(req: Request, run: (send: (data: unknown) => void, signal: AbortSignal) => Promise<void>): Response {
  const enc = new TextEncoder()
  const ac = new AbortController()
  req.signal.addEventListener("abort", () => ac.abort(), { once: true })
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true
      const send = (data: unknown) => {
        if (open) controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`))
      }
      try {
        await run(send, ac.signal)
      } catch (err) {
        if (!ac.signal.aborted) send({ t: "error", message: (err as Error).message })
      } finally {
        open = false
        try {
          controller.close()
        } catch {
          // already closed by a cancel
        }
      }
    },
    cancel() {
      ac.abort()
    },
  })
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } })
}
