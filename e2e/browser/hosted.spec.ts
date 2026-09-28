import { expect, test } from "@playwright/test"
import { quickOpen, ready, returningUser } from "../helpers"

/**
 * The hosted web app: no daemon. The page answers its own API (demo in IndexedDB, GitHub imports,
 * a picked folder) and calls Groq directly with the user's key — mocked here, so no real key is used.
 */

const FAKE_KEY = "gsk_e2e" + "x".repeat(40)

test("first visit shows the tour, pointing at the Groq key", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByRole("dialog", { name: "Kivo in one minute" })).toBeVisible()
  await page.getByRole("button", { name: "Show me around" }).click()
  for (let i = 0; i < 7; i++) await page.keyboard.press("ArrowRight")
  await expect(page.getByRole("dialog", { name: "Turn on AI" })).toContainText("stays in this browser")
})

test.describe("returning user", () => {
  test.beforeEach(async ({ page }) => {
    await returningUser(page)
    await page.goto("/")
    await ready(page)
  })

  test("runs entirely in the browser", async ({ page }) => {
    await expect(page.locator("footer")).toContainText("In your browser")
    await expect(page.getByRole("button", { name: "add Groq key" })).toBeVisible()
    // No request ever goes to a daemon.
    const api: string[] = []
    page.on("request", (r) => new URL(r.url()).pathname.startsWith("/api/") && api.push(r.url()))
    await page.keyboard.press("ControlOrMeta+2")
    await quickOpen(page, "README.md")
    await expect(page.locator(".cm-content")).toBeVisible()
    expect(api).toEqual([])
  })

  test("edits are saved in the browser and survive a reload", async ({ page }) => {
    await page.keyboard.press("ControlOrMeta+2")
    await quickOpen(page, "README.md")
    const editor = page.locator(".cm-content")
    await editor.click()
    await page.keyboard.press("ControlOrMeta+Home")
    await page.keyboard.type("E2E was here. ")
    await expect(page.getByLabel("Unsaved changes").first()).toBeVisible()
    await page.keyboard.press("ControlOrMeta+s")
    await expect(page.getByLabel("Unsaved changes")).toHaveCount(0)
    await page.reload()
    await ready(page)
    await page.keyboard.press("ControlOrMeta+2")
    await quickOpen(page, "README.md")
    await expect(page.locator(".cm-content")).toContainText("E2E was here.")
  })

  test("the terminal explains it needs the desktop app", async ({ page }) => {
    await page.keyboard.press("ControlOrMeta+j")
    await expect(page.getByText("can't open a shell on your computer")).toBeVisible()
    await expect(page.getByText("Kivo desktop app")).toBeVisible()
  })

  test("a malformed Groq key is refused without calling Groq", async ({ page }) => {
    let groqCalls = 0
    await page.route("https://api.groq.com/**", (r) => {
      groqCalls++
      return r.abort()
    })
    await page.keyboard.press("ControlOrMeta+,")
    await page.getByLabel("Groq API key").fill("nope")
    await page.getByRole("button", { name: "Connect" }).click()
    await expect(page.getByText("doesn't look like an API key")).toBeVisible()
    expect(groqCalls).toBe(0)
  })

  test("with a key, AI answers stream straight from Groq (mocked)", async ({ page }) => {
    const auth: string[] = []
    await page.route("https://api.groq.com/openai/v1/**", async (route) => {
      auth.push(route.request().headers().authorization ?? "")
      if (route.request().url().endsWith("/models")) return route.fulfill({ json: { data: [{ id: "openai/gpt-oss-120b" }] } })
      const chunks = ["Tandem ", "is a ", "demo project."].map((t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`)
      return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: chunks.join("") + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n' })
    })
    await page.keyboard.press("ControlOrMeta+,")
    await page.getByLabel("Groq API key").fill(FAKE_KEY)
    await page.getByRole("button", { name: "Connect" }).click()
    await expect(page.getByText("Groq connected")).toBeVisible()
    await page.keyboard.press("Escape")
    expect(auth.every((a) => a === `Bearer ${FAKE_KEY}`)).toBe(true)

    await page.getByRole("tab", { name: "AI" }).click()
    const box = page.getByPlaceholder(/Ask Kivo/)
    await box.fill("What is this project?")
    await box.press("Enter")
    await expect(page.getByText("Tandem is a demo project.")).toBeVisible()
  })
})

test("on localhost with no daemon, Kivo falls back to the browser instead of going offline", async ({ page }) => {
  await returningUser(page)
  // The preview server has no /api (it answers with the page), like a machine where Kivo isn't running.
  await page.goto(`http://127.0.0.1:${new URL(test.info().project.use.baseURL!).port}/`)
  await ready(page)
  await expect(page.locator("footer")).toContainText("In your browser")
  await expect(page.getByText("offline")).toHaveCount(0)
})
