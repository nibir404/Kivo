// Renders the Kivo mark to resources/icon.png (1024², macOS-style rounded square with margin).
// Run once when the mark changes: node apps/desktop/scripts/icon.mjs (uses Playwright's Chromium).
import { chromium } from "@playwright/test"
import path from "node:path"

const out = path.resolve(import.meta.dirname, "../resources/icon.png")
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <rect x="100" y="100" width="824" height="824" rx="185" fill="#0a0a0a"/>
  <g transform="translate(100 100) scale(34.33)">
    <path d="M8 6.5v11M8 12l6.5-5.5M10.2 10.2 16 17.5" stroke="#fafafa" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  </g>
</svg>`
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } })
await page.setContent(`<body style="margin:0;background:transparent">${svg}</body>`)
await page.locator("svg").screenshot({ path: out, omitBackground: true })
await browser.close()
console.log("icon →", out)
