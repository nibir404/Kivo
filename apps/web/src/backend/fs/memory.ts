import { HttpError } from "../http"
import { idb } from "./idb"
import { ignored, notFound, parentOf, type ProjectFS } from "./types"

/**
 * The demo project in the browser: files in memory, saved to IndexedDB so edits survive a reload.
 * A write resolves only once IndexedDB has it, so "Saved" means saved even if the tab closes next. Seeded from @kivo/seed-project on first use; `reset` restores it.
 */
export class MemoryFS implements ProjectFS {
  private files = new Map<string, string>()
  private folders = new Set<string>()
  private saving: Promise<void> | null = null
  private dirty = false
  private key: string

  private constructor(key: string) {
    this.key = key
  }

  /** One instance per store, so a reopen never reads IndexedDB behind a save that's still pending. */
  private static open_ = new Map<string, Promise<MemoryFS>>()

  static open(key: string, seed: () => Promise<Record<string, string>>): Promise<MemoryFS> {
    let fs = MemoryFS.open_.get(key)
    if (!fs) {
      fs = MemoryFS.load(key, seed)
      MemoryFS.open_.set(key, fs)
      fs.catch(() => MemoryFS.open_.delete(key))
    }
    return fs
  }

  private static async load(key: string, seed: () => Promise<Record<string, string>>) {
    const fs = new MemoryFS(key)
    const saved = await idb.get<{ files: [string, string][]; folders: string[] }>(key)
    if (saved) {
      fs.files = new Map(saved.files)
      fs.folders = new Set(saved.folders)
    } else {
      for (const [p, text] of Object.entries(await seed())) fs.files.set(p, text)
      await idb.set(key, { files: [...fs.files], folders: [] })
    }
    return fs
  }

  /** Forget a store entirely (an imported repository the user removed). */
  static async drop(key: string) {
    const fs = await MemoryFS.open_.get(key)
    await fs?.saving
    MemoryFS.open_.delete(key)
    await idb.del(key)
  }

  /** Throw away the user's edits and go back to the seed. */
  async reset(seed: () => Promise<Record<string, string>>) {
    this.files = new Map(Object.entries(await seed()))
    this.folders = new Set()
    await this.persist()
  }

  /** Store the current state. Changes made while a save is running are picked up by one more save, which every caller waits for. */
  private persist(): Promise<void> {
    this.dirty = true
    this.saving ??= (async () => {
      try {
        while (this.dirty) {
          this.dirty = false
          await idb.set(this.key, { files: [...this.files], folders: [...this.folders] })
        }
      } finally {
        this.saving = null
      }
    })()
    return this.saving
  }

  private allDirs() {
    const out = new Set(this.folders)
    for (const f of this.files.keys()) for (let p = parentOf(f); p; p = parentOf(p)) out.add(p)
    return out
  }

  private under = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`)

  async list() {
    return [...this.files.keys()].filter((f) => !f.split("/").some(ignored)).sort()
  }

  async dirs() {
    return [...this.allDirs()].sort()
  }

  async stat(rel: string) {
    if (this.files.has(rel)) return "file" as const
    return this.allDirs().has(rel) ? ("dir" as const) : null
  }

  async read(rel: string) {
    const t = this.files.get(rel)
    if (t === undefined) throw (await this.stat(rel)) === "dir" ? new HttpError(400, `${rel} is a folder`) : notFound(rel)
    return t
  }

  async write(rel: string, content: string) {
    if (this.allDirs().has(rel)) throw new HttpError(409, `${rel} is a folder`)
    this.files.set(rel, content)
    await this.persist()
  }

  async mkdir(rel: string) {
    if (this.files.has(rel)) throw new HttpError(409, `${rel} is a file`)
    for (let p = rel; p; p = parentOf(p)) this.folders.add(p)
    await this.persist()
  }

  async remove(rel: string) {
    for (const f of [...this.files.keys()]) if (this.under(f, rel)) this.files.delete(f)
    for (const d of [...this.folders]) if (this.under(d, rel)) this.folders.delete(d)
    await this.persist()
  }

  async rename(from: string, to: string) {
    const move = (p: string) => to + p.slice(from.length)
    for (const [f, t] of [...this.files]) {
      if (!this.under(f, from)) continue
      this.files.delete(f)
      this.files.set(move(f), t)
    }
    for (const d of [...this.folders]) {
      if (!this.under(d, from)) continue
      this.folders.delete(d)
      this.folders.add(move(d))
    }
    await this.persist()
  }

  async copy(from: string, to: string) {
    const kind = await this.stat(from)
    if (kind === "file") this.files.set(to, this.files.get(from)!)
    else {
      for (const [f, t] of [...this.files]) if (this.under(f, from)) this.files.set(to + f.slice(from.length), t)
      this.folders.add(to)
    }
    await this.persist()
  }
}
