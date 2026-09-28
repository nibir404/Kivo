import { useEffect, useRef } from "react"
import { useTheme } from "next-themes"
import { FitAddon } from "@xterm/addon-fit"
import { SearchAddon } from "@xterm/addon-search"
import { Unicode11Addon } from "@xterm/addon-unicode11"
import { WebLinksAddon } from "@xterm/addon-web-links"
import { WebglAddon } from "@xterm/addon-webgl"
import { Terminal as XTerm } from "@xterm/xterm"
import "@xterm/xterm/css/xterm.css"
import { handles, useTerminals, type TerminalTab } from "./store"
import { terminalTheme } from "./theme"

const FONT = "'Geist Mono Variable', ui-monospace, SFMono-Regular, Menlo, monospace"
const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
const dim = (s: string) => `\r\n\x1b[2m${s}\x1b[0m\r\n`

/** Search addons by session, for the toolbar's find bar. */
export const searches = new Map<string, SearchAddon>()

type ServerMsg =
  | { t: "ready"; id: string; title: string; replay: string; exited?: number }
  | { t: "o"; d: string }
  | { t: "title"; title: string }
  | { t: "exit"; code: number }
  | { t: "error"; message: string }

/**
 * One shell session, rendered with xterm.js (WebGL when available). The socket reconnects on its
 * own — a restarted daemon or a dropped connection shows "Reconnecting…" and picks up where it was.
 */
export function TerminalSession({ tab, visible }: { tab: TerminalTab; visible: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<XTerm | null>(null)
  const fit = useRef<FitAddon | null>(null)
  const { resolvedTheme } = useTheme()
  const fontSize = useTerminals((s) => s.fontSize)
  const id = tab.id

  useEffect(() => {
    const el = host.current
    if (!el) return
    const store = useTerminals.getState
    let disposed = false
    let ws: WebSocket | null = null
    let retry = 0
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let attachedOnce = false
    let ended = false

    const t = new XTerm({
      fontFamily: FONT,
      fontSize: store().fontSize,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: "bar",
      allowProposedApi: true,
      scrollback: 10_000,
      smoothScrollDuration: 0,
      macOptionClickForcesSelection: true,
      rightClickSelectsWord: isMac,
      // Keeps every ANSI colour readable on our background (e.g. blue directories in `ls`).
      minimumContrastRatio: 4.5,
      drawBoldTextInBrightColors: true,
      theme: terminalTheme(),
    })
    const f = new FitAddon()
    const search = new SearchAddon()
    t.loadAddon(f)
    t.loadAddon(search)
    t.loadAddon(new Unicode11Addon())
    t.unicode.activeVersion = "11"
    t.loadAddon(new WebLinksAddon((e, uri) => (e.metaKey || e.ctrlKey) && window.open(uri, "_blank", "noopener,noreferrer")))
    t.open(el)
    try {
      const gl = new WebglAddon()
      gl.onContextLoss(() => gl.dispose()) // falls back to the DOM renderer
      t.loadAddon(gl)
    } catch {
      // no WebGL (e.g. a VM without GPU) — the DOM renderer is fine
    }
    term.current = t
    fit.current = f
    searches.set(id, search)

    const send = (msg: unknown) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg))
    const sendSize = () => send({ t: "resize", cols: t.cols, rows: t.rows })
    const refit = () => {
      if (!el.offsetWidth || !el.offsetHeight) return
      try {
        f.fit()
      } catch {
        // not measurable during a layout transition
      }
    }

    const handle = {
      input: (d: string) => send({ t: "input", d }),
      focus: () => t.focus(),
      clear: () => t.clear(),
      isOpen: () => ws?.readyState === WebSocket.OPEN && !ended,
    }
    handles.set(id, handle)

    const connect = () => {
      if (disposed) return
      refit()
      const proto = location.protocol === "https:" ? "wss" : "ws"
      const q = new URLSearchParams({ id, cols: String(t.cols), rows: String(t.rows) })
      if (tab.cwd) q.set("cwd", tab.cwd)
      const socket = new WebSocket(`${proto}://${location.host}/ws/terminal?${q}`)
      ws = socket
      socket.onmessage = (ev) => {
        let m: ServerMsg
        try {
          m = JSON.parse(ev.data)
        } catch {
          return
        }
        if (m.t === "o") t.write(m.d)
        else if (m.t === "ready") {
          retry = 0
          if (m.replay) {
            // Same shell as before (reload / reconnect): redraw it exactly from its recent output.
            t.reset()
            t.write(m.replay)
          } else if (attachedOnce) t.write(dim("── The Kivo daemon restarted, so this is a new shell. ──"))
          attachedOnce = true
          ended = m.exited !== undefined
          store().update(id, { status: ended ? "exited" : "open", title: m.title || "shell", exitCode: m.exited })
          refit()
          sendSize()
          for (const cmd of store().takeQueued(id)) send({ t: "input", d: cmd + "\r" })
        } else if (m.t === "title") store().update(id, { title: m.title || "shell" })
        else if (m.t === "exit") {
          ended = true
          t.write(dim(`[process exited with code ${m.code}]`))
          store().update(id, { status: "exited", exitCode: m.code })
        } else if (m.t === "error") {
          ended = true
          t.write(`\r\n\x1b[31m${m.message}\x1b[0m\r\n`)
          store().update(id, { status: "error" })
        }
      }
      socket.onclose = (ev) => {
        if (disposed || ws !== socket) return
        if (ev.code === 4000) return store().update(id, { status: "taken" })
        if (ended || ev.code === 4001 || ev.code === 4002) return
        store().update(id, { status: "reconnecting" })
        retryTimer = setTimeout(connect, Math.min(5000, 250 * 2 ** retry++))
      }
    }

    const input = t.onData((d) => send({ t: "input", d }))
    const binary = t.onBinary((d) => send({ t: "input", d }))
    const resize = t.onResize(sendSize)

    // Editor-style keys a terminal user expects, handled before xterm sees them.
    t.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true
      const cmd = isMac ? e.metaKey : e.ctrlKey && e.shiftKey
      const key = e.key.toLowerCase()
      const consume = (seq?: string) => {
        e.preventDefault()
        if (seq) send({ t: "input", d: seq })
        return false
      }
      if (isMac && e.metaKey && key === "k") return consume(void t.clear())
      if (cmd && key === "f") return consume(void store().setSearchOpen(true))
      if (!isMac && e.ctrlKey && e.shiftKey && key === "c") {
        if (t.hasSelection()) navigator.clipboard?.writeText(t.getSelection()).catch(() => {})
        return consume()
      }
      if (!isMac && e.ctrlKey && e.shiftKey && key === "v") return false // the browser's paste event reaches xterm
      if (isMac && e.metaKey && key === "a") return consume(void t.selectAll())
      if (isMac && e.metaKey && e.key === "Backspace") return consume("\x15")
      if (isMac && e.metaKey && e.key === "ArrowLeft") return consume("\x01")
      if (isMac && e.metaKey && e.key === "ArrowRight") return consume("\x05")
      if (e.altKey && !e.metaKey && !e.ctrlKey && e.key === "ArrowLeft") return consume("\x1bb")
      if (e.altKey && !e.metaKey && !e.ctrlKey && e.key === "ArrowRight") return consume("\x1bf")
      if (cmd && (e.key === "=" || e.key === "+")) return consume(void store().setFontSize(store().fontSize + 1))
      if (cmd && e.key === "-") return consume(void store().setFontSize(store().fontSize - 1))
      if (cmd && e.key === "0") return consume(void store().setFontSize(12.5))
      return true
    })

    const ro = new ResizeObserver(() => requestAnimationFrame(refit))
    ro.observe(el)

    // Measure with the real web font, not a fallback, or columns come out wrong.
    document.fonts
      .load(`12px ${FONT}`)
      .catch(() => {})
      .finally(() => {
        if (disposed) return
        t.options.fontFamily = FONT
        refit()
        connect()
      })

    return () => {
      disposed = true
      clearTimeout(retryTimer)
      ro.disconnect()
      input.dispose()
      binary.dispose()
      resize.dispose()
      ws?.close(1000)
      searches.delete(id)
      if (handles.get(id) === handle) handles.delete(id)
      t.dispose()
      term.current = null
    }
    // tab.cwd only matters for the first spawn; a session is identified by its id alone.
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // Wait a frame so the new theme class has applied before reading tokens.
    const raf = requestAnimationFrame(() => {
      if (term.current) term.current.options.theme = terminalTheme()
    })
    return () => cancelAnimationFrame(raf)
  }, [resolvedTheme])

  useEffect(() => {
    const t = term.current
    if (!t || t.options.fontSize === fontSize) return
    t.options.fontSize = fontSize
    try {
      fit.current?.fit()
    } catch {
      // hidden
    }
  }, [fontSize])

  useEffect(() => {
    if (!visible) return
    const raf = requestAnimationFrame(() => {
      try {
        fit.current?.fit()
      } catch {
        // ignore
      }
      // Only take focus when the panel is actually open — a folded terminal must not swallow keystrokes.
      if ((host.current?.offsetHeight ?? 0) > 40) term.current?.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [visible])

  return <div ref={host} className="kivo-terminal h-full w-full pt-1 pl-3" />
}
