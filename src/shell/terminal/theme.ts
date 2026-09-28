import type { ITheme } from "@xterm/xterm"

/** xterm only understands hex/rgb, while our tokens are OKLCH — resolve through a canvas pixel. */
function toRgb(color: string) {
  const c = document.createElement("canvas")
  c.width = c.height = 1
  const ctx = c.getContext("2d")!
  ctx.fillStyle = color
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`
}

// The 16 ANSI colours, tuned for each background (same families as VS Code's integrated terminal).
const DARK = {
  black: "#3a3a3a",
  red: "#f14c4c",
  green: "#23d18b",
  yellow: "#e5e510",
  blue: "#3b8eea",
  magenta: "#d670d6",
  cyan: "#29b8db",
  white: "#d4d4d4",
  brightBlack: "#7a7a7a",
  brightRed: "#ff6b6b",
  brightGreen: "#4ee6a8",
  brightYellow: "#f5f543",
  brightBlue: "#6cb0ff",
  brightMagenta: "#e98ee9",
  brightCyan: "#5fd4f0",
  brightWhite: "#ffffff",
}

const LIGHT = {
  black: "#000000",
  red: "#c72e2e",
  green: "#107c10",
  yellow: "#8a6d00",
  blue: "#0451a5",
  magenta: "#a626a4",
  cyan: "#0e7a93",
  white: "#555555",
  brightBlack: "#6e6e6e",
  brightRed: "#e03e3e",
  brightGreen: "#1a9c1a",
  brightYellow: "#a88a00",
  brightBlue: "#1a6fd6",
  brightMagenta: "#c238c0",
  brightCyan: "#1391ad",
  brightWhite: "#8a8a8a",
}

export function terminalTheme(): ITheme {
  const dark = document.documentElement.classList.contains("dark")
  const css = getComputedStyle(document.documentElement)
  const token = (name: string, fallback: string) => {
    const v = css.getPropertyValue(name).trim()
    return v ? toRgb(v) : fallback
  }
  const background = token("--background", dark ? "#151515" : "#ffffff")
  const foreground = token("--foreground", dark ? "#f5f5f5" : "#1f1f1f")
  return {
    ...(dark ? DARK : LIGHT),
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: dark ? "#264f78" : "#add6ff",
    selectionInactiveBackground: dark ? "#3a3d41" : "#e5ebf1",
    scrollbarSliderBackground: dark ? "rgba(121,121,121,0.35)" : "rgba(100,100,100,0.3)",
    scrollbarSliderHoverBackground: dark ? "rgba(100,100,100,0.6)" : "rgba(100,100,100,0.55)",
    scrollbarSliderActiveBackground: dark ? "rgba(191,191,191,0.4)" : "rgba(0,0,0,0.5)",
  }
}
