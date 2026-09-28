import { expect, test } from "@playwright/test"
import { quickOpen, ready, returningUser } from "../helpers"

/** The UI served by the daemon (`npm start`): the full system, on this machine. */

test("first visit: the tour explains Kivo, then leads into setup", async ({ page }) => {
  await page.goto("/")
  const tour = page.getByRole("dialog", { name: "Kivo in one minute" })
  await expect(tour).toBeVisible()
  await expect(tour).toContainText("You describe it")
  await tour.getByRole("button", { name: "Show me around" }).click()
  await expect(page.getByRole("dialog", { name: "Pick your field" })).toBeVisible()
  await page.keyboard.press("ArrowRight")
  await expect(page.getByRole("dialog", { name: "Five places, one project" })).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog", { name: "Welcome to Kivo" })).toBeVisible()
  await page.reload()
  await ready(page)
  await expect(page.getByRole("dialog", { name: "Kivo in one minute" })).toHaveCount(0)
})

test.describe("returning user", () => {
  test.beforeEach(async ({ page }) => {
    await returningUser(page)
    await page.goto("/")
    await ready(page)
  })

  test("connected to the daemon on this computer", async ({ page }) => {
    await expect(page.locator("footer")).toContainText("Connected")
    await expect(page.getByRole("button", { name: "tandem" })).toBeVisible()
  })

  test("edit a file in Code mode and save it to disk", async ({ page, request }) => {
    await request.put("/api/fs/write", { data: { path: "e2e/edit-me.txt", content: "before\n" } })
    await page.keyboard.press("ControlOrMeta+2")
    await quickOpen(page, "edit-me.txt")
    const editor = page.locator(".cm-content")
    await expect(editor).toContainText("before")
    await editor.click()
    await page.keyboard.press("ControlOrMeta+a")
    await page.keyboard.type("after from the editor")
    await page.keyboard.press("ControlOrMeta+s")
    await expect.poll(async () => (await (await request.get("/api/fs/read?path=e2e/edit-me.txt")).json()).content).toBe("after from the editor")
  })

  test("the terminal is a real shell in the project folder", async ({ page, request }) => {
    await page.keyboard.press("ControlOrMeta+j")
    const term = page.locator(".xterm")
    await expect(term).toBeVisible()
    await term.click()
    await page.keyboard.type("echo kivo-$((6*7)) > e2e-terminal.txt\n")
    await expect.poll(async () => (await (await request.get("/api/fs/read?path=e2e-terminal.txt")).json()).content, { timeout: 15_000 }).toBe("kivo-42\n")
  })

  test("⌘K finds commands, and can replay the tour", async ({ page }) => {
    await page.keyboard.press("ControlOrMeta+k")
    await page.keyboard.type("take the tour")
    await page.keyboard.press("Enter")
    await expect(page.getByRole("dialog", { name: "Kivo in one minute" })).toBeVisible()
    await page.getByRole("button", { name: "Skip tour" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)
  })

  test("the AI pill says keys come from .env here", async ({ page }) => {
    await page.getByRole("button", { name: /no AI provider/ }).click()
    await expect(page.getByRole("menu")).toContainText(".env")
  })
})
