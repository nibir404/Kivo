import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

const repoRoot = path.resolve(import.meta.dirname, '../..')

export default defineConfig(({ mode }) => {
  // The same .env the daemon reads (at the repo root), so changing a port there moves both sides together.
  // Only KIVO_* is read, and only here in the config: none of it is exposed to the browser bundle.
  const env = { ...loadEnv(mode, repoRoot, 'KIVO_'), ...process.env }
  const daemon = `http://127.0.0.1:${env.KIVO_DAEMON_PORT ?? 5175}`
  const uiPort = Number(env.KIVO_UI_PORT ?? 5174)

  return {
    plugins: [react(), tailwindcss()],
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
