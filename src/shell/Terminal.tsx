import { useEffect, useRef, useState } from "react"
import { useTheme } from "next-themes"
import { FitAddon } from "@xterm/addon-fit"
import { Terminal as XTerm } from "@xterm/xterm"
import "@xterm/xterm/css/xterm.css"
import { RotateCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useKivo } from "@/state/store"
import { useUi } from "./capture"

/** xterm only understands hex/rgb, while our tokens are OKLCH — resolve through a canvas pixel. */
function toRgb(color: string) {
  const c = document.createElement("canvas")
  c.width = c.height = 1
  const ctx = c.getContext("2d")!
  ctx.fillStyle = color
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
  return `rgb(${r}, ${g}, ${b})`
}

function themeFromTokens() {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string) => toRgb(css.getPropertyValue(name).trim())
  return {
    background: v("--background"),
    foreground: v("--foreground"),
    cursor: v("--foreground"),
    cursorAccent: v("--background"),
    selectionBackground: "rgba(120,140,200,0.35)",
  }
}

/**
 * A real, interactive shell in the project workspace (via the daemon's pty).
 * Stays mounted while hidden so the session survives tab switches.
 */
export function Terminal({ visible }: { visible: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<XTerm | null>(null)
  const fit = useRef<FitAddon | null>(null)
  const ws = useRef<WebSocket | null>(null)
  const [status, setStatus] = useState<"connecting" | "open" | "closed">("connecting")
  const [session, setSession] = useState(0)
  const daemon = useKivo((s) => s.daemon)
  const { resolvedTheme } = useTheme()
  const terminalCmd = useUi((s) => s.terminalCmd)
  const sent = useRef(0)

  // Commands queued from elsewhere in Kivo ("Run in terminal") are typed into the live shell.
  useEffect(() => {
    if (!terminalCmd || terminalCmd.id === sent.current) return
    const trySend = (attempt = 0) => {
      const socket = ws.current
      if (socket?.readyState === WebSocket.OPEN) {
        sent.current = terminalCmd.id
        socket.send(terminalCmd.cmd + "\r")
        term.current?.focus()
      } else if (attempt < 40) setTimeout(() => trySend(attempt + 1), 150)
    }
    trySend()
  }, [terminalCmd])

  useEffect(() => {
    if (!host.current || !daemon) return
    const t = new XTerm({
      fontFamily: "'Geist Mono Variable', ui-monospace, monospace",
      fontSize: 12.5,
      lineHeight: 1.25,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000,
      theme: themeFromTokens(),
    })
    const f = new FitAddon()
    t.loadAddon(f)
    t.open(host.current)
    term.current = t
    fit.current = f

    const proto = location.protocol === "https:" ? "wss" : "ws"
    const socket = new WebSocket(`${proto}://${location.host}/ws/terminal`)
    ws.current = socket
    setStatus("connecting")
    const sendSize = () => socket.readyState === socket.OPEN && socket.send(`\u0000resize:${t.cols}x${t.rows}`)
    socket.onopen = () => {
      setStatus("open")
      try {
        f.fit()
      } catch {
        // host not measurable yet
      }
      sendSize()
    }
    socket.onmessage = (m) => t.write(typeof m.data === "string" ? m.data : "")
    socket.onclose = () => {
      setStatus("closed")
      t.write("\r\n\x1b[2m[session ended]\x1b[0m\r\n")
    }
    const input = t.onData((d) => socket.readyState === socket.OPEN && socket.send(d))
    const resize = t.onResize(sendSize)

    const ro = new ResizeObserver(() => {
      if (host.current && host.current.offsetWidth > 0) {
        try {
          f.fit()
        } catch {
          // ignore transient layout
        }
      }
    })
    ro.observe(host.current)

    return () => {
      ro.disconnect()
      input.dispose()
      resize.dispose()
      socket.close()
      t.dispose()
      term.current = null
    }
  }, [daemon, session])

  useEffect(() => {
    // Wait a frame so the new theme class has applied before reading tokens.
    requestAnimationFrame(() => {
      if (term.current) term.current.options.theme = themeFromTokens()
    })
  }, [resolvedTheme])

  useEffect(() => {
    if (visible && term.current) {
      requestAnimationFrame(() => {
        try {
          fit.current?.fit()
        } catch {
          // ignore
        }
        term.current?.focus()
      })
    }
  }, [visible])

  if (!daemon) {
    return <div className="p-3 font-mono text-[12px] text-muted-foreground">Terminal needs the Kivo daemon. Start it with `npm run dev`.</div>
  }

  return (
    <div className="relative h-full">
      <div ref={host} className="h-full w-full px-2 pt-1.5" />
      {status === "closed" && (
        <Button size="xs" variant="outline" className="absolute top-2 right-3" onClick={() => setSession((n) => n + 1)}>
          <RotateCw /> New session
        </Button>
      )}
    </div>
  )
}
