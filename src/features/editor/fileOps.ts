import { toast } from "sonner"
import { editorApi } from "@/lib/editor-api"
import { useUi } from "@/shell/capture"
import { useTerminals } from "@/shell/terminal/store"
import { openFile } from "@/state/runners"
import { useKivo } from "@/state/store"
import { useEditor } from "./store"
import { closeUnder, refreshTree, renameOpen } from "./tabs"

/** Explorer actions: each talks to the daemon, then brings the tree and the open tabs up to date. */

export const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name)
export const parentOf = (path: string) => path.split("/").slice(0, -1).join("/")
export const baseName = (path: string) => path.split("/").pop() ?? path

const fail = (what: string) => (err: unknown) => {
  toast.error(what, { description: (err as Error).message })
  return null
}

/** Names typed in the explorer: nested paths ("a/b.ts") are fine, empty / dot segments are not. */
export function checkName(name: string): string | null {
  const n = name.trim()
  if (!n) return "A name is required"
  if (n.split("/").some((seg) => !seg || seg === "." || seg === "..")) return "Not a valid name"
  if (/[\0]/.test(n)) return "Not a valid name"
  return null
}

export async function createIn(dir: string, name: string, kind: "file" | "folder") {
  const r = await editorApi.create(join(dir, name.trim()), kind).catch(fail(`Couldn't create ${name}`))
  if (!r) return null
  await refreshTree()
  const ed = useEditor.getState()
  ed.expandTo(kind === "folder" ? join(r.path, "x") : r.path)
  ed.select(r.path)
  if (kind === "file") await openFile(r.path)
  return r.path
}

export async function renameTo(from: string, to: string) {
  if (from === to) return from
  const r = await editorApi.rename(from, to).catch(fail(`Couldn't rename ${baseName(from)}`))
  if (!r) return null
  renameOpen(from, r.path)
  useEditor.getState().expandTo(r.path)
  useEditor.getState().select(r.path)
  await refreshTree()
  return r.path
}

export async function duplicate(path: string) {
  const r = await editorApi.duplicate(path).catch(fail(`Couldn't duplicate ${baseName(path)}`))
  if (!r) return
  await refreshTree()
  useEditor.getState().select(r.path)
  // Straight into renaming the copy, as Finder does.
  useEditor.getState().setEdit({ kind: "rename", path: r.path })
}

/** Callers confirm first; this moves the entry to the OS trash and closes its tabs. */
export async function trash(path: string) {
  const r = await editorApi.trash(path).catch(fail(`Couldn't delete ${baseName(path)}`))
  if (!r) return
  closeUnder(path)
  if (useEditor.getState().selected === path) useEditor.getState().select(null)
  await refreshTree()
  toast.success(`Moved ${baseName(path)} to the Trash`)
}

export const reveal = (path: string) => editorApi.reveal(path || ".").catch(fail("Couldn't show it in Finder"))

export function projectRoot(): string | undefined {
  const s = useKivo.getState() as unknown as { ai?: { projectInfo?: { dir?: string } }; analysis?: { project?: { dir?: string } } }
  return s.analysis?.project?.dir ?? s.ai?.projectInfo?.dir
}

export async function copyText(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(`Copied ${label}`)
  } catch {
    toast.error("Couldn't copy to the clipboard")
  }
}

export function copyPath(path: string, absolute: boolean) {
  const root = projectRoot()
  if (absolute && root) return copyText(path ? `${root}/${path}` : root, "path")
  return copyText(path || ".", "relative path")
}

/** A new terminal tab that starts in this folder. */
export function openInTerminal(dir: string) {
  useKivo.getState().setBottomTab("terminal")
  useUi.setState((s) => ({ bottomOpenTick: s.bottomOpenTick + 1 }))
  useTerminals.getState().newTab(dir || undefined)
}
