import type http from "node:http"

/** An error with an HTTP status the client should see (400s), as opposed to a crash (500). */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

const MAX_BODY = 5 * 1024 * 1024

/** Read a JSON request body, refusing oversized or malformed payloads with a 4xx instead of throwing. */
export async function readJson<T = Record<string, unknown>>(req: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > MAX_BODY) throw new HttpError(413, "Request body is too large (5 MB max)")
    chunks.push(c as Buffer)
  }
  const text = Buffer.concat(chunks).toString() || "{}"
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new HttpError(400, "Request body is not valid JSON")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400, "Request body must be a JSON object")
  return parsed as T
}

export function json(res: http.ServerResponse, status: number, data: unknown) {
  if (res.headersSent) return
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
  res.end(JSON.stringify(data))
}

/** Server-sent events. Writes after the client has gone away are dropped instead of throwing. */
export function sse(res: http.ServerResponse) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" })
  return (data: unknown) => {
    if (res.writableEnded || res.destroyed) return
    res.write(`data: ${JSON.stringify(data)}\n\n`)
  }
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
