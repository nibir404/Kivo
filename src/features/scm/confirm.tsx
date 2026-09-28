import { useCallback, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"

interface Ask {
  title: string
  description: React.ReactNode
  action: string
  destructive?: boolean
}

/** A promise-returning confirmation dialog: `if (await confirm({...})) …`. Render `dialog` once. */
export function useConfirm() {
  const [ask, setAsk] = useState<Ask | null>(null)
  const resolver = useRef<(ok: boolean) => void>(() => {})

  const confirm = useCallback(
    (a: Ask) =>
      new Promise<boolean>((resolve) => {
        resolver.current = resolve
        setAsk(a)
      }),
    [],
  )

  const close = (ok: boolean) => {
    resolver.current(ok)
    resolver.current = () => {}
    setAsk(null)
  }

  const dialog = (
    <Dialog open={!!ask} onOpenChange={(open) => !open && close(false)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{ask?.title}</DialogTitle>
          <DialogDescription asChild>
            <div className="text-[13px] text-muted-foreground">{ask?.description}</div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button variant={ask?.destructive ? "destructive" : "default"} size="sm" autoFocus onClick={() => close(true)}>
            {ask?.action}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )

  return { confirm, dialog }
}
