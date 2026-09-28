import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { readSeedFiles, SEED_DIR } from '@kivo/seed-project'
import { defineConfig, loadEnv, type Plugin } from 'vite'

const repoRoot = path.resolve(import.meta.dirname, '../..')

/**
 * `virtual:kivo-seed-project`: the demo project's files as one JSON module, for the in-browser
 * demo. Read at build time (so .env.example etc. never need to be served from disk) and imported
 * lazily, so it's its own small chunk.
 */
function seedProject(): Plugin {
  const id = 'virtual:kivo-seed-project'
  const resolved = `\0${id}`
  return {
    name: 'kivo-seed-project',
    resolveId: (source) => (source === id ? resolved : undefined),
    load(source) {
      if (source !== resolved) return
      const files = readSeedFiles()
      for (const rel of Object.keys(files)) this.addWatchFile(path.join(SEED_DIR, rel))
      return `export default ${JSON.stringify(files)}`
    },
  }
}

export default defineConfig(({ mode }) => {
  // The same .env the daemon reads (at the repo root), so changing a port there moves both sides together.
  // Only KIVO_* is read, and only here in the config: none of it is exposed to the browser bundle.
  const env = { ...loadEnv(mode, repoRoot, 'KIVO_'), ...process.env }
  const daemon = `http://127.0.0.1:${env.KIVO_DAEMON_PORT ?? 5175}`
  const uiPort = Number(env.KIVO_UI_PORT ?? 5174)

  return {
    // Where the built UI is served from: "/" for `npm start`, e.g. "/app/" for the hosted site (KIVO_BASE=/app/ npm run build).
    base: env.KIVO_BASE ?? '/',
    plugins: [react(), tailwindcss(), seedProject()],
    resolve: {
      alias: { '@': path.resolve(import.meta.dirname, './src') },
    },
    build: {
      // The editor chunk (CodeMirror) is ~700 kB but only loads when Code mode opens.
      chunkSizeWarningLimit: 800,
    },
    server: {
      port: uiPort,
      strictPort: true,
      watch: { ignored: ['**/.kivo-workspace/**'] },
      proxy: {
        '/api': { target: daemon, changeOrigin: false },
        '/ws': { target: daemon, ws: true, changeOrigin: false },
      },
    },
  }
})
