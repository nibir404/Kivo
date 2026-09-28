import { defineConfig, devices } from "@playwright/test"

/**
 * End-to-end tests for every way Kivo runs (`npm run e2e`; `npm run e2e:install` once for the browser):
 *
 *  - api      the daemon's HTTP API and its guards (the backend)
 *  - daemon   the UI served by the daemon: the full system, as with `npm start`
 *  - browser  the hosted web app: no daemon, everything in the page (the browser backend)
 *  - desktop  the Electron app, with its own daemon (needs `npm run build -w @kivo/desktop`)
 *
 * The UI suites use the built app (apps/web/dist), so run `npm run build` first — `npm run e2e`
 * builds everything it needs.
 */

const DAEMON = Number(process.env.E2E_DAEMON_PORT ?? 4390)
const PREVIEW = Number(process.env.E2E_PREVIEW_PORT ?? 4380)

export default defineConfig({
  testDir: "e2e",
  outputDir: "test-results",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  // The daemon suites share one daemon (one current project), so they run one file at a time.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"], ["html", { open: "never" }]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "api", testMatch: "api/**/*.spec.ts", use: { baseURL: `http://127.0.0.1:${DAEMON}` } },
    { name: "daemon", testMatch: "web/**/*.spec.ts", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, baseURL: `http://127.0.0.1:${DAEMON}` } },
    // kivo.localhost is loopback but not "localhost", so the app treats it as a hosted site.
    { name: "browser", testMatch: "browser/**/*.spec.ts", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, baseURL: `http://kivo.localhost:${PREVIEW}` } },
    { name: "desktop", testMatch: "desktop/**/*.spec.ts" },
  ],
  webServer: [
    {
      command: "node --import tsx e2e/daemon.ts --serve",
      url: `http://127.0.0.1:${DAEMON}/api/health`,
      env: { E2E_DAEMON_PORT: String(DAEMON) },
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      // The hosted app, as a static site. Its /api proxy points at a port nothing listens on, so
      // this is also "a computer where Kivo isn't running" (the dev daemon on 5175 must not answer).
      command: `npx vite preview apps/web --port ${PREVIEW} --strictPort --host 127.0.0.1`,
      url: `http://127.0.0.1:${PREVIEW}/`,
      env: { KIVO_DAEMON_PORT: "9" },
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: "ignore",
      stderr: "ignore",
    },
  ],
})
