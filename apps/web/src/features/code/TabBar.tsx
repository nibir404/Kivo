import { useEffect, useState } from "react"
import { FileCode2, FileDiff, X } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut, ContextMenuTrigger } from "@/components/ui/context-menu"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { isDiffTab } from "@/features/scm/DiffView"
import { copyPath, reveal } from "@/features/editor/fileOps"
import { useEditor } from "@/features/editor/store"
import { cn } from "@/lib/utils"
import { saveFile } from "@/state/runners"
import { useKivo } from "@/state/store"
import { closeMany, doClose, requestClose, tabFile, tabLabel, usePending } from "./tabActions"
import { inBrowser } from "@/lib/transport"

/**
 * Editor tabs: dirty dot, close button, middle-click close, a context menu (close others / to the
 * right / saved / all), and the save / don't save / cancel prompt for tabs with unsaved edits.
 */

export function TabBar() {
  const openFiles = useKivo((s) => s.openFiles)
  const activeFile = useKivo((s) => s.activeFile)
  const fileCache = useKivo((s) => s.fileCache)
  const setActiveFile = useKivo((s) => s.setActiveFile)
  const dirty = (p: string) => !!fileCache[p] && fileCache[p].content !== fileCache[p].saved

  // Two tabs with the same name show their folder, as VS Code does.
  const names = new Map<string, number>()
  for (const p of openFiles) names.set(tabLabel(p), (names.get(tabLabel(p)) ?? 0) + 1)

  useEffect(() => {
    if (activeFile) document.querySelector(`[data-tab="${CSS.escape(activeFile)}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [activeFile])

  return (
    <>
      <div className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b bg-sidebar [scrollbar-width:none]" role="tablist">
        {openFiles.map((p, i) => {
          const label = tabLabel(p)
          const folder = (names.get(label) ?? 0) > 1 ? tabFile(p).split("/").slice(-2, -1)[0] : null
          const Icon = isDiffTab(p) ? FileDiff : FileCode2
          return (
            <ContextMenu key={p}>
              <ContextMenuTrigger asChild>
                <div
                  data-tab={p}
                  role="tab"
                  aria-selected={p === activeFile}
                  data-active={p === activeFile || undefined}
                  className="group relative flex shrink-0 cursor-pointer items-center gap-1.5 border-r pr-1.5 pl-3 font-mono text-[12px] text-muted-foreground select-none hover:text-foreground data-active:bg-background data-active:text-foreground data-active:after:absolute data-active:after:inset-x-0 data-active:after:top-0 data-active:after:h-px data-active:after:bg-foreground/60"
                  onClick={() => setActiveFile(p)}
                  onAuxClick={(e) => e.button === 1 && requestClose(p)}
                  onMouseDown={(e) => e.button === 1 && e.preventDefault()}
                  title={isDiffTab(p) ? `${tabFile(p)} — ${label}` : p}
                >
                  <Icon className="size-3 shrink-0 opacity-70" />
                  <span className={cn(isDiffTab(p) && "italic")}>{label}</span>
                  {folder && <span className="text-[10.5px] text-muted-foreground">{folder}</span>}
                  <button
                    aria-label={`Close ${label}`}
                    className={cn("flex size-4 items-center justify-center rounded-sm hover:bg-accent", !dirty(p) && "opacity-0 group-hover:opacity-100 group-data-active:opacity-100")}
                    onClick={(e) => {
                      e.stopPropagation()
                      requestClose(p)
                    }}
                  >
                    {dirty(p) ? <span className="size-1.5 rounded-full bg-foreground group-hover:hidden" /> : null}
                    <X className={cn("size-3", dirty(p) && "hidden group-hover:block")} />
                  </button>
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-56">
                <ContextMenuItem onSelect={() => requestClose(p)}>
                  Close <ContextMenuShortcut>⌃W</ContextMenuShortcut>
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => closeMany(openFiles.filter((x) => x !== p))}>Close Others</ContextMenuItem>
                <ContextMenuItem disabled={i === openFiles.length - 1} onSelect={() => closeMany(openFiles.slice(i + 1))}>
                  Close to the Right
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => closeMany(openFiles.filter((x) => !dirty(x)))}>Close Saved</ContextMenuItem>
                <ContextMenuItem onSelect={() => closeMany(openFiles)}>Close All</ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => copyPath(tabFile(p), true)}>Copy Path</ContextMenuItem>
                <ContextMenuItem onSelect={() => copyPath(tabFile(p), false)}>Copy Relative Path</ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem
                  onSelect={() => {
                    const ed = useEditor.getState()
                    ed.setView("explorer")
                    ed.expandTo(tabFile(p))
                    ed.select(tabFile(p))
                  }}
                >
                  Reveal in Explorer
                </ContextMenuItem>
                {!inBrowser && <ContextMenuItem onSelect={() => reveal(tabFile(p))}>Reveal in Finder</ContextMenuItem>}
              </ContextMenuContent>
            </ContextMenu>
          )
        })}
      </div>
      <ClosePrompt />
    </>
  )
}

function ClosePrompt() {
  const path = usePending((s) => s.path)
  const set = usePending((s) => s.set)
  const [saving, setSaving] = useState(false)
  const name = path ? tabLabel(path) : ""

  const saveAndClose = async () => {
    if (!path) return
    setSaving(true)
    try {
      await saveFile(path)
      doClose(path)
      set(null)
    } catch (err) {
      toast.error("Save failed", { description: (err as Error).message })
    }
    setSaving(false)
  }

  return (
    <Dialog open={!!path} onOpenChange={(o) => !o && set(null)}>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Save changes to {name}?</DialogTitle>
          <DialogDescription>Your changes will be lost if you don't save them.</DialogDescription>
        </DialogHeader>
        <DialogFooter className="sm:justify-between">
          <Button
            variant="ghost"
            onClick={() => {
              if (path) doClose(path)
              set(null)
            }}
          >
            Don't Save
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => set(null)}>
              Cancel
            </Button>
            <Button autoFocus onClick={saveAndClose} disabled={saving}>
              Save
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
