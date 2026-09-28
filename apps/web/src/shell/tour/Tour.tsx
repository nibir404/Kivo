import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { ArrowLeft, ArrowRight, Check, ClipboardCheck, MessageSquareText, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { workspace } from "@/features/workspace/registry"
import { inBrowser } from "@/lib/transport"
import { cn } from "@/lib/utils"
import { useKivo } from "@/state/store"
import { useUi } from "../capture"
import { KivoMark } from "../TopBar"
import { tourSteps, type Side, type TourStep } from "./steps"
import { useTour } from "./store"

const CARD_W = 340
const GAP = 14
const PAD = 6
const MARGIN = 12

type Box = { top: number; left: number; width: number; height: number }

/** The first `data-tour` target that is actually on screen (collapsed panels have no size). */
function findTarget(step: TourStep): HTMLElement | null {
  for (const name of step.targets ?? []) {
    const el = document.querySelector<HTMLElement>(`[data-tour="${name}"]`)
    if (!el) continue
    const r = el.getBoundingClientRect()
    if (r.width >= 8 && r.height >= 8 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth) return el
  }
  return null
}

function sameBox(a: Box | null, b: Box | null) {
  if (!a || !b) return a === b
  return Math.abs(a.top - b.top) < 0.5 && Math.abs(a.left - b.left) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5
}

function edgeSafe(b: Box): Box {
  const top = Math.max(2, b.top)
  const left = Math.max(2, b.left)
  return { top, left, width: Math.min(b.left + b.width, innerWidth - 2) - left, height: Math.min(b.top + b.height, innerHeight - 2) - top }
}

/** Where the card goes next to the spotlight: the preferred side if it fits, else the roomiest one. */
function placeCard(box: Box, cardH: number, prefer: Side = "bottom") {
  const vw = innerWidth
  const vh = innerHeight
  const w = Math.min(CARD_W, vw - MARGIN * 2)
  const room: Record<Side, number> = {
    bottom: vh - (box.top + box.height) - GAP,
    top: box.top - GAP,
    right: vw - (box.left + box.width) - GAP,
    left: box.left - GAP,
  }
  const fits = (s: Side) => (s === "top" || s === "bottom" ? room[s] >= cardH + MARGIN : room[s] >= w + MARGIN)
  const side = fits(prefer) ? prefer : ((["bottom", "right", "left", "top"] as Side[]).find(fits) ?? null)
  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(v, max))
  if (!side) return { top: clamp(vh - cardH - MARGIN, MARGIN, vh), left: (vw - w) / 2, width: w } // nowhere beside it: dock at the bottom
  if (side === "bottom" || side === "top") {
    const top = side === "bottom" ? box.top + box.height + GAP : box.top - GAP - cardH
    return { top, left: clamp(box.left + box.width / 2 - w / 2, MARGIN, vw - w - MARGIN), width: w }
  }
  const left = side === "right" ? box.left + box.width + GAP : box.left - GAP - w
  return { top: clamp(box.top + box.height / 2 - cardH / 2, MARGIN, vh - cardH - MARGIN), left, width: w }
}

/**
 * A short guided tour for people new to Kivo (and to software): what it is, then a spotlight on each
 * part of the screen with one plain-language explanation. Shown once on the first visit; replay it
 * from the avatar menu, ⌘K or the welcome screen.
 */
export function Tour() {
  const open = useTour((s) => s.open)
  return open ? <TourOverlay /> : null
}

function TourOverlay() {
  const close = useTour((s) => s.close)
  const discipline = useKivo((s) => s.discipline)
  const aiReady = useKivo((s) => !!s.ai?.ai)
  const steps = useMemo(() => tourSteps({ inBrowser, primaryMode: workspace(discipline).primaryMode, software: discipline === "software", aiReady }), [discipline, aiReady])
  const [i, setI] = useState(0)
  const step = steps[i]
  const [box, setBox] = useState<Box | null>(null)
  const card = useRef<HTMLDivElement>(null)
  const primary = useRef<HTMLButtonElement>(null)
  const [cardH, setCardH] = useState(220)
  // The screen the user was on: the tour moves around, and puts them back when it ends.
  const startMode = useRef(useKivo.getState().mode)

  const finish = useCallback(() => {
    const s = useKivo.getState()
    const firstRun = !s.toured
    s.setToured(true)
    close()
    if (s.mode !== startMode.current) s.setMode(startMode.current)
    // First visit: the tour leads into setup (AI key, explanation level, where to start).
    if (firstRun && !s.welcomed) setTimeout(() => useKivo.getState().setDialog("welcome"), 150)
  }, [close])
  const next = useCallback(() => (i < steps.length - 1 ? setI(i + 1) : finish()), [i, steps.length, finish])
  const back = useCallback(() => setI((v) => Math.max(0, v - 1)), [])

  // Get the screen ready for this step.
  useEffect(() => {
    const s = useKivo.getState()
    if (step.prepare === "build-mode" && s.mode !== "build") s.setMode("build")
    // On narrow screens the panel is a sheet over everything; point at its button instead of opening it.
    if (step.prepare === "open-context" && innerWidth >= 960) useUi.getState().openRight()
    if (s.dialog) s.setDialog(null)
    if (s.commandOpen) s.setCommandOpen(false)
  }, [step])

  // Follow the target while it moves (panels resizing, the window changing size, lazy views loading).
  useLayoutEffect(() => {
    let raf = 0
    let last: Box | null | undefined // undefined: nothing measured yet for this step
    let scrolled = false
    const tick = () => {
      const el = step.kind ? null : findTarget(step)
      if (el && !scrolled) {
        el.scrollIntoView({ block: "nearest", inline: "nearest" })
        scrolled = true
      }
      const r = el?.getBoundingClientRect()
      // Padded around the target, but kept on screen so the outline shows at the window's edges.
      const b = r ? edgeSafe({ top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 }) : null
      if (last === undefined || !sameBox(b, last)) setBox((last = b))
      raf = requestAnimationFrame(tick)
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [step])

  // The card's height decides which side of the target it fits on.
  useLayoutEffect(() => {
    const el = card.current
    if (!el) return
    const ro = new ResizeObserver(() => setCardH(el.offsetHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    primary.current?.focus({ preventScroll: true })
  }, [i])

  // Arrow keys step through, Esc leaves. Captured so the app's own shortcuts don't fire underneath.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish()
      else if (e.key === "ArrowRight") next()
      else if (e.key === "ArrowLeft") back()
      else if (e.key === "Tab") {
        // Keep focus inside the card.
        const f = card.current?.querySelectorAll<HTMLElement>("button")
        if (!f?.length) return
        const first = f[0]
        const last = f[f.length - 1]
        if (!card.current!.contains(document.activeElement)) first.focus()
        else if (e.shiftKey && document.activeElement === first) last.focus()
        else if (!e.shiftKey && document.activeElement === last) first.focus()
        else return
      } else if (e.key === "Enter" && !card.current?.contains(document.activeElement)) next()
      else if (e.key === "Enter" || e.key === " ") return
      else if (!(e.metaKey || e.ctrlKey || e.key === "?")) return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [next, back, finish])

  const centered = !box
  const pos = box ? placeCard(box, cardH, step.side) : null
  const anchored = steps.filter((s) => !s.kind)
  const n = anchored.indexOf(step)

  return (
    <div className="fixed inset-0 z-[70]" role="presentation">
      {/* Dim everything; the spotlight is a hole cut by a giant shadow around the target. Clicks outside do nothing. */}
      {box ? (
        <div
          aria-hidden
          className="pointer-events-none fixed rounded-xl ring-2 ring-white/80 transition-all duration-300 ease-out motion-reduce:transition-none"
          style={{ ...box, boxShadow: "0 0 0 9999px rgb(0 0 0 / 0.55)" }}
        />
      ) : (
        <div aria-hidden className="kivo-fade fixed inset-0 bg-black/55" />
      )}

      <div
        ref={card}
        role="dialog"
        aria-modal="true"
        aria-labelledby="kivo-tour-title"
        aria-describedby="kivo-tour-body"
        className={cn(
          "fixed rounded-2xl border bg-popover text-popover-foreground shadow-2xl outline-none",
          centered ? "top-1/2 left-1/2 max-h-[calc(100dvh-2rem)] w-[min(460px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto" : "transition-[top,left] duration-300 ease-out motion-reduce:transition-none",
        )}
        style={pos ?? undefined}
      >
        {step.kind === "intro" ? (
          <Intro step={step} />
        ) : step.kind === "finish" ? (
          <div className="space-y-2 px-6 pt-6 pb-4">
            <div className="flex size-9 items-center justify-center rounded-full bg-success/15 text-success">
              <Check className="size-5" />
            </div>
            <h2 id="kivo-tour-title" className="pt-1 text-lg font-semibold tracking-tight">
              {step.title}
            </h2>
            <p id="kivo-tour-body" className="text-[13px] leading-relaxed text-muted-foreground">
              {step.body}
            </p>
            <p className="text-[11px] text-muted-foreground">Replay this tour any time from your avatar menu → Take the tour.</p>
          </div>
        ) : (
          <div className="space-y-2 px-4 pt-4 pb-3">
            <div className="text-[11px] font-medium text-muted-foreground tabular-nums">
              {n + 1} of {anchored.length}
            </div>
            <h2 id="kivo-tour-title" className="text-[15px] font-semibold tracking-tight">
              {step.title}
            </h2>
            <p id="kivo-tour-body" className="text-[13px] leading-relaxed text-muted-foreground">
              {step.body}
            </p>
            {step.points && (
              <dl className="space-y-1 pt-1 text-[12.5px]">
                {step.points.map((p) => (
                  <div key={p.label} className="flex gap-2">
                    <dt className="w-16 shrink-0 font-medium">{p.label}</dt>
                    <dd className="text-muted-foreground">{p.text}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        )}

        <div className={cn("flex items-center gap-2 border-t", step.kind ? "px-6 py-3" : "px-4 py-2.5")}>
          {step.kind === "intro" ? (
            <>
              <Button variant="ghost" size="sm" onClick={() => finish()}>
                Skip tour
              </Button>
              <Button ref={primary} size="sm" className="ml-auto" onClick={next}>
                Show me around <ArrowRight />
              </Button>
            </>
          ) : step.kind === "finish" ? (
            <>
              <Button variant="ghost" size="sm" onClick={back}>
                <ArrowLeft /> Back
              </Button>
              <Button ref={primary} size="sm" className="ml-auto" onClick={() => finish()}>
                {useKivo.getState().welcomed ? "Done" : "Get started"} <ArrowRight />
              </Button>
            </>
          ) : (
            <>
              <Dots count={anchored.length} at={n} />
              <Button variant="ghost" size="sm" className="ml-auto" onClick={() => finish()}>
                Skip
              </Button>
              <Button variant="outline" size="icon-sm" onClick={back} aria-label="Previous">
                <ArrowLeft />
              </Button>
              <Button ref={primary} size="sm" onClick={next}>
                Next <ArrowRight />
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function Dots({ count, at }: { count: number; at: number }) {
  return (
    <div className="flex items-center gap-1" aria-hidden>
      {Array.from({ length: count }, (_, k) => (
        <span key={k} className={cn("h-1.5 rounded-full transition-all", k === at ? "w-4 bg-foreground" : k < at ? "w-1.5 bg-foreground/50" : "w-1.5 bg-foreground/15")} />
      ))}
    </div>
  )
}

const HOW = [
  { icon: MessageSquareText, title: "You describe it", text: "In your own words — no code needed." },
  { icon: ClipboardCheck, title: "You check the plan", text: "Nothing is built until you approve." },
  { icon: Sparkles, title: "Kivo builds and explains", text: "Every step, at the level you choose." },
]

function Intro({ step }: { step: TourStep }) {
  return (
    <div className="space-y-5 px-6 pt-6 pb-5">
      <div className="space-y-2">
        <KivoMark className="size-8" />
        <h2 id="kivo-tour-title" className="pt-2 text-xl font-semibold tracking-tight">
          {step.title}
        </h2>
        <p id="kivo-tour-body" className="text-[13.5px] leading-relaxed text-muted-foreground">
          {step.body}
        </p>
      </div>
      <ol className="grid gap-2 sm:grid-cols-3">
        {HOW.map((h, k) => (
          <li key={h.title} className="rounded-xl border bg-background p-3">
            <div className="flex items-center gap-2">
              <span className="flex size-5 items-center justify-center rounded-full bg-foreground text-[11px] font-semibold text-background tabular-nums">{k + 1}</span>
              <h.icon className="size-4 text-muted-foreground" />
            </div>
            <div className="pt-2 text-[13px] font-medium">{h.title}</div>
            <div className="text-xs leading-snug text-muted-foreground">{h.text}</div>
          </li>
        ))}
      </ol>
      <p className="text-xs text-muted-foreground">The tour takes about a minute. Use ← → to move, Esc to leave.</p>
    </div>
  )
}
