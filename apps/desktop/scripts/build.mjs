// Bundles the desktop app: main process (ESM), preload (CJS, as sandboxed preloads must be) and the
// daemon (one ESM file; node-pty stays external because it's a native module shipped beside it).
import { build } from "esbuild"
import fs from "node:fs"
import path from "node:path"

const here = path.resolve(import.meta.dirname, "..")
const out = path.join(here, "build")
fs.rmSync(out, { recursive: true, force: true })

const common = { bundle: true, platform: "node", target: "node22", sourcemap: "linked", logLevel: "warning" }

await Promise.all([
  build({ ...common, entryPoints: [path.join(here, "src/main.ts")], outfile: path.join(out, "main.mjs"), format: "esm", external: ["electron"] }),
  build({ ...common, entryPoints: [path.join(here, "src/preload.ts")], outfile: path.join(out, "preload.cjs"), format: "cjs", external: ["electron"] }),
  build({
    ...common,
    entryPoints: [path.join(here, "../daemon/src/index.ts")],
    outfile: path.join(out, "daemon/daemon.mjs"),
    format: "esm",
    external: ["node-pty"],
    // Some dependencies are CommonJS and call require(); give the ESM bundle one.
    banner: { js: 'import { createRequire as __kivoRequire } from "node:module"; const require = __kivoRequire(import.meta.url);' },
  }),
])
console.log("desktop bundle →", path.relative(process.cwd(), out))
