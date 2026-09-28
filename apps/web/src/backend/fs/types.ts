import { HttpError } from "../http"

/**
 * A project's files as the browser backend sees them. Two implementations: the demo, kept in
 * IndexedDB (`MemoryFS`), and a real folder on the user's disk picked with the File System Access
 * API (`HandleFS`). Paths are always project-relative with "/" separators, already checked by
 * `cleanPath`.
 */
export interface ProjectFS {
  /** Every file, sorted; dependency and build folders are skipped (like the daemon's listing). */
  list(): Promise<string[]>
  /** Every folder (for showing empty ones in the explorer). */
  dirs(): Promise<string[]>
  stat(rel: string): Promise<"file" | "dir" | null>
  read(rel: string): Promise<string>
  write(rel: string, content: string): Promise<void>
  mkdir(rel: string): Promise<void>
  /** Deletes a file or a folder with everything in it. */
  remove(rel: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  copy(from: string, to: string): Promise<void>
}

/** Same skip list as the daemon's file listing. */
export const IGNORE = new Set([".git", ".venv", "venv", "node_modules", "__pycache__", ".pytest_cache", "dist", "build", ".next", ".turbo", "target", ".gradle", ".idea", "Pods", ".DS_Store"])
export const MAX_FILES = 30_000
export const MAX_FILE_BYTES = 2 * 1024 * 1024

export const ignored = (name: string) => IGNORE.has(name) || name.endsWith(".db")

/**
 * Normalize a client-supplied path: relative, no "..", no NUL, "/" separators. Writes may not
 * target .git or the project root itself.
 */
export function cleanPath(rel: unknown, { field = "path", write = false, allowRoot = false } = {}): string {
  if (typeof rel !== "string" || !rel.trim()) throw new HttpError(400, `"${field}" must be a non-empty string`)
  if (rel.includes("\0")) throw new HttpError(400, `"${field}" contains a NUL byte`)
  if (rel.length > 1024) throw new HttpError(400, `"${field}" is too long`)
  const parts: string[] = []
  for (const seg of rel.replace(/\\/g, "/").split("/")) {
    if (!seg || seg === ".") continue
    if (seg === "..") {
      if (!parts.length) throw new HttpError(403, "Path outside workspace")
      parts.pop()
    } else parts.push(seg)
  }
  if (rel.trim().startsWith("/")) throw new HttpError(403, "Path outside workspace")
  const out = parts.join("/")
  if (!out) {
    if (allowRoot) return "."
    throw new HttpError(400, "That's the project folder itself")
  }
  if (write && parts.includes(".git")) throw new HttpError(400, "Kivo doesn't change files inside .git")
  return out
}

export const parentOf = (rel: string) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "")
export const baseName = (rel: string) => rel.slice(rel.lastIndexOf("/") + 1)

/** Text only: binary files (a NUL in the first 8 KB) and oversized ones are refused, like the daemon. */
export function decodeText(bytes: Uint8Array): string {
  if (bytes.length > MAX_FILE_BYTES) throw new HttpError(413, "File too large to open (2 MB max)")
  if (bytes.subarray(0, 8192).includes(0)) throw new HttpError(415, "This is a binary file")
  return new TextDecoder().decode(bytes)
}

export const notFound = (rel: string) => new HttpError(404, `${rel} doesn't exist`)
