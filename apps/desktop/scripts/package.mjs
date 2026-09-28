// Packages Kivo for this OS (macOS .dmg/.zip, Windows installer, Linux AppImage) into release/.
// Run through `npm run desktop:package`, which builds the UI and the bundles first.
//
// The app is staged into .stage/ with only what it needs (no monorepo node_modules):
//   app.asar          main process + preload (build/)
//   Resources/daemon  the bundled daemon + node-pty (native, N-API, so no rebuild for Electron)
//   Resources/web     the built UI      Resources/seed  the demo project
//
// Unsigned by default. To sign and notarize on macOS set CSC_LINK / CSC_KEY_PASSWORD (or have a
// Developer ID in the keychain) plus APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID.
import { build } from "electron-builder"
import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"

const here = path.resolve(import.meta.dirname, "..")
const repo = path.resolve(here, "../..")
const require = createRequire(import.meta.url)
const pkg = JSON.parse(fs.readFileSync(path.join(here, "package.json"), "utf8"))
const stage = path.join(here, ".stage")

const need = (p, hint) => {
  if (!fs.existsSync(p)) throw new Error(`${path.relative(repo, p)} is missing — ${hint}`)
  return p
}
const webDist = need(path.join(repo, "apps/web/dist/index.html"), "run npm run build") && path.join(repo, "apps/web/dist")
need(path.join(here, "build/main.mjs"), "run npm run build -w @kivo/desktop")
if (fs.readFileSync(path.join(webDist, "index.html"), "utf8").includes('src="/app/')) throw new Error("apps/web/dist was built for the hosted site (/app/); run npm run build")

fs.rmSync(stage, { recursive: true, force: true })
fs.mkdirSync(stage, { recursive: true })
fs.cpSync(path.join(here, "build"), path.join(stage, "build"), { recursive: true, filter: (p) => !p.includes(`${path.sep}daemon`) && !p.endsWith(".map") })
fs.writeFileSync(path.join(stage, "package.json"), JSON.stringify({ name: "kivo", productName: pkg.productName, version: pkg.version, description: pkg.description, author: pkg.author, main: "build/main.mjs" }, null, 2))

// The daemon and its one native dependency, with only this platform's prebuilt binary.
const daemonOut = path.join(stage, "resources/daemon")
fs.cpSync(path.join(here, "build/daemon"), daemonOut, { recursive: true, filter: (p) => !p.endsWith(".map") })
const pty = path.dirname(require.resolve("node-pty/package.json", { paths: [path.join(repo, "apps/daemon")] }))
const target = `${process.platform}-${process.arch}`
fs.cpSync(pty, path.join(daemonOut, "node_modules/node-pty"), {
  recursive: true,
  filter: (p) => {
    const rel = path.relative(pty, p)
    if (/^(src|scripts|deps|third_party|typings|test)(\/|$)/.test(rel) || rel.endsWith(".map")) return false
    if (rel.startsWith("prebuilds/") && rel.split("/")[1] && rel.split("/")[1] !== target) return false
    return true
  },
})
fs.writeFileSync(path.join(daemonOut, "package.json"), JSON.stringify({ type: "module", private: true }))

await build({
  projectDir: stage,
  publish: "never",
  config: {
    appId: "dev.kivo.app",
    productName: pkg.productName,
    copyright: `© ${new Date().getFullYear()} Kivo`,
    electronVersion: require("electron/package.json").version,
    npmRebuild: false,
    directories: { output: path.join(here, "release"), buildResources: path.join(here, "resources") },
    files: ["build/**", "package.json"],
    extraResources: [
      { from: daemonOut, to: "daemon" },
      { from: webDist, to: "web" },
      { from: path.join(repo, "packages/seed-project/files"), to: "seed" },
    ],
    icon: path.join(here, "resources/icon.png"),
    mac: {
      category: "public.app-category.developer-tools",
      target: [{ target: "dmg" }, { target: "zip" }],
      hardenedRuntime: true,
      // No signing identity → an unsigned build (right-click → Open the first time).
      identity: process.env.CSC_LINK || process.env.CSC_NAME ? undefined : null,
      notarize: !!process.env.APPLE_TEAM_ID,
    },
    dmg: { title: "Kivo" },
    win: { target: [{ target: "nsis" }] },
    nsis: { oneClick: false, allowToChangeInstallationDirectory: true },
    linux: { target: [{ target: "AppImage" }], category: "Development" },
  },
})
console.log("packaged →", path.relative(process.cwd(), path.join(here, "release")))
