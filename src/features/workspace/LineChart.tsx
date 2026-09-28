import { useEffect, useMemo, useRef, useState } from "react"
import { Table2 } from "lucide-react"
import { cn } from "@/lib/utils"
import type { Chart } from "./model"

/**
 * A small line chart: one y-axis, 2px lines, recessive grid, an optional dashed target line,
 * a crosshair + tooltip on hover, direct end labels, a legend for ≥ 2 series, and a table view.
 * Series take the first three categorical slots in fixed order (validated in both themes).
 */

const COLORS = ["var(--series-1)", "var(--series-2)", "var(--series-3)"]
const H = 168
const PAD = { top: 12, right: 76, bottom: 22, left: 40 }

function niceTicks(min: number, max: number, count = 4) {
  const span = max - min || Math.abs(max) || 1
  const step0 = span / count
  const mag = 10 ** Math.floor(Math.log10(step0))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) ?? step0
  const lo = Math.floor(min / step) * step
  const hi = Math.ceil(max / step) * step
  const ticks: number[] = []
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Number(v.toFixed(6)))
  return ticks
}

const fmt = (v: number, unit?: string) => {
  const a = Math.abs(v)
  const s = a >= 10_000 ? `${Math.round(v / 1000)}k` : a >= 100 ? String(Math.round(v)) : a >= 10 ? v.toFixed(1) : a >= 1 ? v.toFixed(2) : v.toFixed(3)
  return unit ? `${s} ${unit}` : s
}

/** Tick labels use only as many decimals as the step needs (0, 0.5, 1 — not 0.000, 0.500). */
function tickLabel(t: number, ticks: number[]) {
  if (Math.abs(t) >= 10_000) return `${Math.round(t / 1000)}k`
  const step = ticks.length > 1 ? Math.abs(ticks[1] - ticks[0]) : 1
  let decimals = 0
  while (decimals < 4 && Math.abs(step * 10 ** decimals - Math.round(step * 10 ** decimals)) > 1e-6) decimals++
  return t.toFixed(decimals)
}

export function LineChart({ chart }: { chart: Chart }) {
  const box = useRef<HTMLElement>(null)
  const [width, setWidth] = useState(560)
  const [hover, setHover] = useState<number | null>(null)
  const [asTable, setAsTable] = useState(false)

  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, Math.floor(e.contentRect.width))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const n = Math.max(...chart.series.map((s) => s.points.length))
  const { ticks, y, x } = useMemo(() => {
    const all = chart.series.flatMap((s) => s.points).concat(chart.target ? [chart.target.value] : [])
    const t = niceTicks(Math.min(0, ...all) < 0 ? Math.min(...all) : Math.min(...all) * 0.9, Math.max(...all))
    const lo = t[0]
    const hi = t[t.length - 1]
    const plotW = width - PAD.left - PAD.right
    const plotH = H - PAD.top - PAD.bottom
    return {
      ticks: t,
      y: (v: number) => PAD.top + plotH - ((v - lo) / (hi - lo || 1)) * plotH,
      x: (i: number) => PAD.left + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW),
    }
  }, [chart, width, n])

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - r.left
    const plotW = width - PAD.left - PAD.right
    const i = Math.round(((px - PAD.left) / plotW) * (n - 1))
    setHover(i >= 0 && i < n ? i : null)
  }

  const multi = chart.series.length > 1
  const tipLeft = hover === null ? 0 : x(hover)

  return (
    <figure ref={box} className="space-y-2">
      <figcaption className="flex items-center gap-3">
        <span className="text-[13px] font-medium">{chart.title}</span>
        {multi && (
          <span className="flex items-center gap-3 text-[11px] text-muted-foreground">
            {chart.series.map((s, i) => (
              <span key={s.name} className="flex items-center gap-1.5">
                <span className="h-0.5 w-3 rounded-full" style={{ background: COLORS[i] }} />
                {s.name}
              </span>
            ))}
          </span>
        )}
        <button
          onClick={() => setAsTable((v) => !v)}
          aria-pressed={asTable}
          className={cn("ml-auto flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground", asTable && "bg-accent text-foreground")}
        >
          <Table2 className="size-3" /> Table
        </button>
      </figcaption>

      {asTable ? (
        <div className="max-h-56 overflow-auto rounded-lg border">
          <table className="w-full text-[12px] tabular-nums">
            <thead className="sticky top-0 bg-background text-muted-foreground">
              <tr>
                <th className="px-2 py-1 text-left font-normal">{chart.x}</th>
                {chart.series.map((s) => (
                  <th key={s.name} className="px-2 py-1 text-right font-normal">
                    {s.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: n }, (_, i) => (
                <tr key={i} className="border-t">
                  <td className="px-2 py-0.5 text-muted-foreground">{i + 1}</td>
                  {chart.series.map((s) => (
                    <td key={s.name} className="px-2 py-0.5 text-right">
                      {s.points[i] === undefined ? "—" : fmt(s.points[i], chart.unit)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="relative">
          <svg width={width} height={H} className="block overflow-visible" onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label={`${chart.title}, ${chart.series.map((s) => `${s.name} from ${fmt(s.points[0], chart.unit)} to ${fmt(s.points[s.points.length - 1], chart.unit)}`).join("; ")}`}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} className="stroke-border" strokeWidth={1} />
                <text x={PAD.left - 6} y={y(t)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[10px] tabular-nums">
                  {tickLabel(t, ticks)}
                </text>
              </g>
            ))}
            <text x={width - PAD.right} y={H - 4} textAnchor="end" className="fill-muted-foreground text-[10px]">
              {chart.x} →
            </text>

            {chart.target && (
              <g>
                <line x1={PAD.left} x2={width - PAD.right} y1={y(chart.target.value)} y2={y(chart.target.value)} className="stroke-muted-foreground" strokeWidth={1} strokeDasharray="4 4" />
                <text x={PAD.left + 4} y={y(chart.target.value) - 4} className="fill-muted-foreground stroke-background text-[10px]" strokeWidth={3} paintOrder="stroke">
                  {chart.target.label}
                </text>
              </g>
            )}

            {chart.series.map((s, si) => {
              const d = s.points.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("")
              const last = s.points.length - 1
              return (
                <g key={s.name}>
                  <path d={d} fill="none" stroke={COLORS[si]} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                  {/* Direct label at the line's end, in text ink — the swatch carries identity. */}
                  <circle cx={x(last)} cy={y(s.points[last])} r={3} fill={COLORS[si]} className="stroke-background" strokeWidth={2} />
                  <text x={x(last) + 8} y={y(s.points[last])} dy="0.32em" className="fill-foreground stroke-background text-[11px] tabular-nums" strokeWidth={3} paintOrder="stroke">
                    {fmt(s.points[last], chart.unit)}
                    {multi && <tspan className="fill-muted-foreground"> {s.name}</tspan>}
                  </text>
                </g>
              )
            })}

            {hover !== null && (
              <g pointerEvents="none">
                <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={H - PAD.bottom} className="stroke-muted-foreground/60" strokeWidth={1} />
                {chart.series.map((s, si) => s.points[hover] !== undefined && <circle key={s.name} cx={x(hover)} cy={y(s.points[hover])} r={4} fill={COLORS[si]} className="stroke-background" strokeWidth={2} />)}
              </g>
            )}
            {/* Whole plot is the hit target. */}
            <rect x={PAD.left} y={PAD.top} width={Math.max(0, width - PAD.left - PAD.right)} height={H - PAD.top - PAD.bottom} fill="transparent" />
          </svg>

          {hover !== null && (
            <div
              className="pointer-events-none absolute top-1 z-10 min-w-28 rounded-md border bg-popover px-2 py-1.5 text-[11px] text-popover-foreground shadow-md"
              style={{ left: tipLeft > width - 160 ? tipLeft - 136 : tipLeft + 10 }}
            >
              <div className="mb-0.5 text-muted-foreground">
                {chart.x} {hover + 1}
              </div>
              {chart.series.map((s, si) => (
                <div key={s.name} className="flex items-center gap-1.5 tabular-nums">
                  <span className="size-2 rounded-full" style={{ background: COLORS[si] }} />
                  <span className="text-muted-foreground">{s.name}</span>
                  <span className="ml-auto pl-2">{s.points[hover] === undefined ? "—" : fmt(s.points[hover], chart.unit)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </figure>
  )
}
