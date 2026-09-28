import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test"
import fs from "node:fs"
import path from "node:path"

/**
 * The desktop app: Electron starting its own daemon, with the same UI in a native window.
 * Runs the dev build (apps/desktop/build); set E2E_DESKTOP_APP to a packaged app's executable to
 * test that instead, e.g. apps/desktop/release/mac-arm64/Kivo.app/Contents/MacOS/Kivo.
 */

const ROOT = path.resolve(import.meta.dirname, "../..")
const DATA = path.join(ROOT, "e2e/.tmp/desktop")

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  const packaged = process.env.E2E_DESKTOP_APP ? path.resolve(process.env.E2E_DESKTOP_APP) : null
  test.skip(!packaged && !fs.existsSync(path.join(ROOT, "apps/desktop/build/main.mjs")), "Build the desktop app first: npm run build -w @kivo/desktop")
  fs.rmSync(DATA, { recursive: true, force: true })
  app = await electron.launch({
    // Linux CI containers can't use Chromium's setuid sandbox.
    ...(packaged ? { executablePath: packaged, args: [] } : { args: [path.join(ROOT, "apps/desktop"), ...(process.env.CI && process.platform === "linux" ? ["--no-sandbox"] : [])] }),
    env: {
      ...process.env,
      KIVO_DESKTOP_USER_DATA: DATA,
      KIVO_PROJECTS_DIR: path.join(DATA, "projects"),
      KIVO_DESKTOP_NO_DOTENV: "1",
      GROQ_API_KEY: "",
      PUKU_API_KEY: "",
      OPENAI_COMPAT_API_KEY: "",
    },
  })
  page = await app.firstWindow()
  await page.evaluate(() => localStorage.setItem("kivo:v1", JSON.stringify({ state: { toured: true, welcomed: true }, version: 0 })))
  await page.reload()
  await expect(page.getByRole("navigation", { name: "Modes" })).toBeVisible({ timeout: 30_000 })
})

test.afterAll(async () => {
  await app?.close()
})

test("opens on its own daemon, always connected", async () => {
  expect(page.url()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
  await expect(page.locator("footer")).toContainText("Desktop")
  expect(await page.evaluate(() => typeof (window as { kivoDesktop?: unknown }).kivoDesktop)).toBe("object")
  // The page has no Node access: only the tiny preload bridge.
  expect(await page.evaluate(() => typeof (globalThis as { require?: unknown }).require)).toBe("undefined")
})

test("draws its own title bar on macOS", async () => {
  test.skip(process.platform !== "darwin")
  expect(await page.evaluate(() => document.documentElement.dataset.desktop)).toBe("mac")
})

test("the Groq key is pasted in the app and a bad one is refused", async () => {
  await expect(page.getByRole("button", { name: "add Groq key" })).toBeVisible()
  const r = await page.evaluate(async () => {
    const res = await fetch("/api/settings/key", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: "bad" }) })
    return res.status
  })
  expect(r).toBe(400)
  expect(fs.existsSync(path.join(DATA, "keys.json"))).toBe(false)
})

test("the terminal runs on this computer", async () => {
  await page.keyboard.press("ControlOrMeta+j")
  const term = page.locator(".xterm")
  await expect(term).toBeVisible()
  await term.click()
  await page.keyboard.type("echo desktop-$((6*7)) > e2e-desktop.txt\n")
  await expect
    .poll(async () => page.evaluate(async () => (await (await fetch("/api/fs/read?path=e2e-desktop.txt")).json()).content), { timeout: 15_000 })
    .toBe("desktop-42\n")
})

test("app menu commands open the right dialogs", async () => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send("kivo:command", "settings"))
  await expect(page.getByRole("dialog", { name: "Preferences" })).toBeVisible()
  await expect(page.getByLabel("Groq API key")).toBeVisible()
  await page.keyboard.press("Escape")
})

test("links to other sites open in the default browser, not the app window", async () => {
  const opened = await app.evaluate(async ({ BrowserWindow, shell }) => {
    const w = BrowserWindow.getAllWindows()[0]
    const before = BrowserWindow.getAllWindows().length
    // shell.openExternal is stubbed so the test doesn't open a real browser.
    const calls: string[] = []
    shell.openExternal = async (u: string) => void calls.push(u)
    await w.webContents.executeJavaScript('window.open("https://console.groq.com/keys", "_blank")')
    await new Promise((r) => setTimeout(r, 300))
    return { calls, windows: BrowserWindow.getAllWindows().length - before }
  })
  expect(opened.windows).toBe(0)
  expect(opened.calls).toEqual(["https://console.groq.com/keys"])
})
