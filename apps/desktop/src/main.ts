import { spawn } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { parseEnv } from "node:util"
import { app, BrowserWindow, dialog, ipcMain, Menu, shell, utilityProcess, type MenuItemConstructorOptions, type UtilityProcess } from "electron"

/**
 * Kivo desktop: the whole system in one app, like the Claude desktop app.
 *
 * The main process starts Kivo's daemon (the same one `npm run dev` runs) in an Electron utility
 * process, on a free port on 127.0.0.1, and opens a window on the UI it serves. So the desktop app
 * is always "connected": real files, terminal, git, installs, tests and running services.
 *
 *  - Data (projects list, demo project, venvs) lives in the app's user-data folder, not a checkout.
 *  - The Groq key is pasted into the app and kept in user data (readable by this user only).
 *  - Apps started from the Dock get a bare PATH, so the user's login-shell environment is loaded
 *    first; otherwise the terminal, git, python and npm wouldn't be found.
 *  - The window only shows the daemon's own UI: other navigation opens in the default browser.
 */

const DEV = !app.isPackaged
const ROOT = path.resolve(import.meta.dirname, "..") // apps/desktop in dev
const RES = DEV ? null : process.resourcesPath
const DAEMON = DEV ? path.join(ROOT, "build/daemon/daemon.mjs") : path.join(RES!, "daemon/daemon.mjs")
const WEB_DIST = DEV ? path.join(ROOT, "../web/dist") : path.join(RES!, "web")
const SEED = DEV ? path.join(ROOT, "../../packages/seed-project/files") : path.join(RES!, "seed")

// Tests (and people who want separate profiles) can point the app at its own data folder.
if (process.env.KIVO_DESKTOP_USER_DATA) app.setPath("userData", path.resolve(process.env.KIVO_DESKTOP_USER_DATA))

const DATA = app.getPath("userData")
const LOG_DIR = path.join(DATA, "logs")
const WINDOW_STATE = path.join(DATA, "window.json")

let daemon: UtilityProcess | null = null
let port = 0
let win: BrowserWindow | null = null
let quitting = false

if (!app.requestSingleInstanceLock()) app.quit()

// ─── Environment ─────────────────────────────────────────────────────────────

/** The user's login-shell environment (PATH from .zshrc, nvm, pyenv, Homebrew…), best effort. */
function loginShellEnv(): Promise<Record<string, string>> {
  if (process.platform === "win32" || process.env.KIVO_SKIP_SHELL_ENV) return Promise.resolve({})
  const sh = process.env.SHELL || "/bin/zsh"
  return new Promise((resolve) => {
    let out = ""
    const p = spawn(sh, ["-ilc", "env -0"], { stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, KIVO_SHELL_ENV_PROBE: "1" } })
    const t = setTimeout(() => {
      p.kill()
      resolve({})
    }, 5000)
    p.stdout.on("data", (d) => (out += d))
    p.on("error", () => resolve({}))
    p.on("close", () => {
      clearTimeout(t)
      const env: Record<string, string> = {}
      for (const line of out.split("\0")) {
        const i = line.indexOf("=")
        if (i > 0) env[line.slice(0, i)] = line.slice(i + 1)
      }
      resolve(env)
    })
  })
}

/** A free port on 127.0.0.1, so the desktop app never collides with a dev daemon on 5175. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.unref()
    s.on("error", reject)
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo
      s.close(() => resolve(port))
    })
  })
}

// ─── Daemon ──────────────────────────────────────────────────────────────────

async function startDaemon() {
  port = await freePort()
  fs.mkdirSync(LOG_DIR, { recursive: true })
  const log = fs.createWriteStream(path.join(LOG_DIR, "daemon.log"), { flags: "a" })
  log.write(`\n── ${new Date().toISOString()} starting on ${port}\n`)
  const shellEnv = await loginShellEnv()
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...shellEnv,
    ...devEnv(),
    KIVO_DAEMON_PORT: String(port),
    KIVO_UI_PORT: String(port),
    KIVO_WEB_DIST: WEB_DIST,
    KIVO_SEED_DIR: SEED,
    KIVO_HOME: process.env.KIVO_HOME ?? path.join(DATA, "workspace"),
    KIVO_KEY_FILE: path.join(DATA, "keys.json"),
    KIVO_DESKTOP: "1",
  }
  delete env.ELECTRON_RUN_AS_NODE

  const child = utilityProcess.fork(DAEMON, ["--serve"], { env: env as Record<string, string>, stdio: "pipe", serviceName: "Kivo daemon" })
  daemon = child
  child.stdout?.on("data", (d) => log.write(d))
  child.stderr?.on("data", (d) => log.write(d))
  child.on("exit", (code) => {
    log.write(`── exited ${code}\n`)
    if (daemon !== child) return
    daemon = null
    if (!quitting) void daemonStopped(code)
  })
  await waitForHealth()
}

/** In development the repo's .env still applies (your own key, ports aside); the packaged app has none. */
function devEnv(): Record<string, string> {
  if (!DEV || process.env.KIVO_DESKTOP_NO_DOTENV) return {}
  try {
    const { KIVO_DAEMON_PORT: _p, KIVO_UI_PORT: _u, KIVO_HOME: _h, ...rest } = parseEnv(fs.readFileSync(path.join(ROOT, "../../.env"), "utf8")) as Record<string, string>
    return rest
  } catch {
    return {}
  }
}

async function waitForHealth(timeoutMs = 45_000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (!daemon) throw new Error("Kivo's engine stopped while starting")
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) })
      if (r.ok) return
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error("Kivo's engine didn't start in time")
}

async function daemonStopped(code: number | null) {
  const choice = await dialog.showMessageBox({
    type: "error",
    message: "Kivo's engine stopped",
    detail: `It exited with code ${code ?? "unknown"}. Your files are safe. The log is in ${path.join(LOG_DIR, "daemon.log")}.`,
    buttons: ["Restart", "Show log", "Quit"],
    defaultId: 0,
  })
  if (choice.response === 1) shell.showItemInFolder(path.join(LOG_DIR, "daemon.log"))
  if (choice.response === 2) return app.quit()
  try {
    await startDaemon()
    await win?.loadURL(uiUrl())
  } catch (err) {
    dialog.showErrorBox("Kivo couldn't restart", String((err as Error).message))
  }
}

const uiUrl = () => `http://127.0.0.1:${port}/`

// ─── Window ──────────────────────────────────────────────────────────────────

type Bounds = { x?: number; y?: number; width: number; height: number; maximized?: boolean }

function savedBounds(): Bounds {
  try {
    const b = JSON.parse(fs.readFileSync(WINDOW_STATE, "utf8")) as Bounds
    if (b.width >= 400 && b.height >= 300) return b
  } catch {
    // first run
  }
  return { width: 1440, height: 900 }
}

function createWindow() {
  const b = savedBounds()
  const w = new BrowserWindow({
    ...b,
    minWidth: 720,
    minHeight: 520,
    show: false,
    title: "Kivo",
    backgroundColor: "#0a0a0a",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: path.join(import.meta.dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })
  win = w
  if (b.maximized) w.maximize()
  w.once("ready-to-show", () => w.show())
  const save = () => {
    if (w.isDestroyed()) return
    fs.mkdirSync(DATA, { recursive: true })
    fs.writeFileSync(WINDOW_STATE, JSON.stringify({ ...w.getNormalBounds(), maximized: w.isMaximized() }))
  }
  w.on("close", save)
  w.on("closed", () => {
    if (win === w) win = null
  })

  // Only Kivo's own UI renders in the window; links go to the default browser.
  const own = (url: string) => url.startsWith(uiUrl())
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !own(url)) void shell.openExternal(url)
    return { action: "deny" }
  })
  w.webContents.on("will-navigate", (e, url) => {
    if (own(url)) return
    e.preventDefault()
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
  })
  w.webContents.session.setPermissionRequestHandler((_wc, permission, done) => done(permission === "clipboard-sanitized-write"))

  void w.loadURL(uiUrl())
  return w
}

// ─── Menu ────────────────────────────────────────────────────────────────────

/** Menu items that open something in the UI: sent to the page (see preload), which owns the dialogs. */
const send = (command: string) => () => {
  const w = win ?? createWindow()
  w.webContents.send("kivo:command", command)
}

function buildMenu() {
  const mac = process.platform === "darwin"
  const template: MenuItemConstructorOptions[] = [
    ...(mac
      ? [
          {
            label: "Kivo",
            submenu: [
              { role: "about" },
              { type: "separator" },
              { label: "Settings…", accelerator: "Cmd+,", click: send("settings") },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: "File",
      submenu: [
        { label: "New Window", accelerator: "CmdOrCtrl+Shift+N", click: () => createWindow() },
        { label: "Open Folder…", accelerator: "CmdOrCtrl+O", click: send("open-folder") },
        { label: "Clone Repository…", click: send("clone") },
        { type: "separator" },
        ...(mac ? [] : [{ label: "Settings…", accelerator: "Ctrl+,", click: send("settings") }, { type: "separator" } as const]),
        mac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        ...(DEV ? [{ role: "toggleDevTools" } as const] : []),
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        { label: "Take the Tour", click: send("tour") },
        { label: "Keyboard Shortcuts", click: send("shortcuts") },
        { type: "separator" },
        { label: "Show Logs", click: () => void shell.openPath(LOG_DIR) },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

ipcMain.handle("kivo:info", () => ({ version: app.getVersion(), platform: process.platform }))

app.on("second-instance", () => {
  if (!win) return createWindow()
  if (win.isMinimized()) win.restore()
  win.focus()
})

app.on("activate", () => {
  if (!BrowserWindow.getAllWindows().length && daemon) createWindow()
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})

app.on("before-quit", () => {
  quitting = true
  // The daemon stops the services and terminals it started on SIGTERM.
  daemon?.kill()
})

app.whenReady().then(async () => {
  buildMenu()
  try {
    await startDaemon()
  } catch (err) {
    dialog.showErrorBox("Kivo couldn't start", `${(err as Error).message}\n\nThe log is in ${path.join(LOG_DIR, "daemon.log")}.`)
    return app.quit()
  }
  createWindow()
})
