import { expect, type Page } from "@playwright/test"

/** Skip the first-run tour and welcome (tests that check them don't call this). */
export async function returningUser(page: Page) {
  await page.addInitScript(() => {
    if (!localStorage.getItem("kivo:v1")) localStorage.setItem("kivo:v1", JSON.stringify({ state: { toured: true, welcomed: true }, version: 0 }))
  })
}

/** The app has rendered and knows its backend. */
export async function ready(page: Page) {
  await expect(page.getByRole("navigation", { name: "Modes" })).toBeVisible()
  await expect(page.locator("footer")).not.toContainText("Connecting…")
}

/** Open a file by path from Quick Open (⌘P). */
export async function quickOpen(page: Page, file: string) {
  await page.keyboard.press("ControlOrMeta+p")
  await page.keyboard.type(file)
  const hit = page.getByRole("option").filter({ hasText: file.split("/").pop()! }).first()
  await expect(hit).toHaveAttribute("data-selected", "true")
  await page.keyboard.press("Enter")
}
