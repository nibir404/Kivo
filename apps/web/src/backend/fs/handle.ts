import { HttpError } from "../http"
import { baseName, decodeText, ignored, MAX_FILES, notFound, parentOf, type ProjectFS } from "./types"

/**
 * A real folder on the user's disk, through the File System Access API (Chrome, Edge, Opera).
 * The browser asks the user before Kivo can read it, and again before it can write; nothing
 * outside the picked folder is reachable.
 */

// The parts of the File System Access API that TypeScript's DOM library doesn't declare yet.
type PermissionMode = { mode: "read" | "readwrite" }
export interface DirHandle extends FileSystemDirectoryHandle {
  queryPermission?(d: PermissionMode): Promise<PermissionState>
  requestPermission?(d: PermissionMode): Promise<PermissionState>
}
declare global {
  interface Window {
    showDirectoryPicker?: (o?: { mode?: "read" | "readwrite"; id?: string }) => Promise<DirHandle>
  }
}

export const folderAccessSupported = () => typeof window !== "undefined" && typeof window.showDirectoryPicker === "function"

/** Make sure Kivo may read and write the folder; asks the user if the browser hasn't granted it yet. */
export async function ensurePermission(h: DirHandle, ask: boolean) {
  const mode: PermissionMode = { mode: "readwrite" }
  // Handles without a permission API (e.g. the origin-private file system) are always usable.
  if (!h.queryPermission) return true
  if ((await h.queryPermission(mode)) === "granted") return true
  if (!ask) return false
  return (await h.requestPermission?.(mode)) === "granted"
}

const fsError = (err: unknown, rel: string): never => {
  const e = err as DOMException
  if (e?.name === "NotFoundError" || e?.name === "TypeMismatchError") throw notFound(rel)
  if (e?.name === "NotAllowedError" || e?.name === "SecurityError") throw new HttpError(403, "The browser didn't allow Kivo to use this folder. Open it again from the project menu to grant access.")
  if (e?.name === "InvalidModificationError") throw new HttpError(409, `${rel} can't be changed that way`)
  throw err
}

export class HandleFS implements ProjectFS {
  readonly root: DirHandle
  private cache: { files: string[]; dirs: string[] } | null = null

  constructor(root: DirHandle) {
    this.root = root
  }

  /** Forget the cached listing (after our own writes, or when the page regains focus). */
  invalidate() {
    this.cache = null
  }

  private async dir(rel: string, create = false): Promise<DirHandle> {
    let d = this.root
    if (!rel) return d
    for (const seg of rel.split("/")) d = (await d.getDirectoryHandle(seg, { create }).catch((e) => fsError(e, rel))) as DirHandle
    return d
  }

  private async walk() {
    if (this.cache) return this.cache
    const files: string[] = []
    const dirs: string[] = []
    const visit = async (d: DirHandle, prefix: string, depth: number) => {
      if (files.length >= MAX_FILES || depth > 12) return
      for await (const [name, h] of d.entries()) {
        if (ignored(name)) continue
        const rel = prefix ? `${prefix}/${name}` : name
        if (h.kind === "directory") {
          dirs.push(rel)
          await visit(h as DirHandle, rel, depth + 1)
        } else files.push(rel)
        if (files.length >= MAX_FILES) return
      }
    }
    await visit(this.root, "", 0)
    this.cache = { files: files.sort(), dirs: dirs.sort() }
    return this.cache
  }

  async list() {
    return (await this.walk()).files
  }

  async dirs() {
    return (await this.walk()).dirs
  }

  async stat(rel: string) {
    const parent = await this.dir(parentOf(rel)).catch(() => null)
    if (!parent) return null
    const name = baseName(rel)
    if (await parent.getFileHandle(name).then(() => true, () => false)) return "file" as const
    if (await parent.getDirectoryHandle(name).then(() => true, () => false)) return "dir" as const
    return null
  }

  async read(rel: string) {
    try {
      const fh = await (await this.dir(parentOf(rel))).getFileHandle(baseName(rel))
      return decodeText(new Uint8Array(await (await fh.getFile()).arrayBuffer()))
    } catch (err) {
      if (err instanceof HttpError) throw err
      return fsError(err, rel)
    }
  }

  async write(rel: string, content: string) {
    try {
      const fh = await (await this.dir(parentOf(rel), true)).getFileHandle(baseName(rel), { create: true })
      const w = await fh.createWritable()
      await w.write(content)
      await w.close()
    } catch (err) {
      return fsError(err, rel)
    } finally {
      this.invalidate()
    }
  }

  async mkdir(rel: string) {
    await this.dir(rel, true)
    this.invalidate()
  }

  async remove(rel: string) {
    try {
      await (await this.dir(parentOf(rel))).removeEntry(baseName(rel), { recursive: true })
    } catch (err) {
      return fsError(err, rel)
    } finally {
      this.invalidate()
    }
  }

  /** There's no move in the standard API everywhere, so rename is copy-then-delete. */
  async rename(from: string, to: string) {
    await this.copy(from, to)
    await this.remove(from)
  }

  async copy(from: string, to: string) {
    const kind = await this.stat(from)
    if (!kind) throw notFound(from)
    const copyFile = async (src: string, dst: string) => {
      const fh = await (await this.dir(parentOf(src))).getFileHandle(baseName(src))
      const data = await (await fh.getFile()).arrayBuffer()
      const out = await (await this.dir(parentOf(dst), true)).getFileHandle(baseName(dst), { create: true })
      const w = await out.createWritable()
      await w.write(data)
      await w.close()
    }
    try {
      if (kind === "file") await copyFile(from, to)
      else {
        const walk = async (src: string, dst: string) => {
          await this.dir(dst, true)
          for await (const [name, h] of (await this.dir(src)).entries()) {
            if (h.kind === "directory") await walk(`${src}/${name}`, `${dst}/${name}`)
            else await copyFile(`${src}/${name}`, `${dst}/${name}`)
          }
        }
        await walk(from, to)
      }
    } catch (err) {
      if (err instanceof HttpError) throw err
      return fsError(err, from)
    } finally {
      this.invalidate()
    }
  }
}
