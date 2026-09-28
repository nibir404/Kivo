import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Same variables the daemon reads, so changing a port in .env moves both sides together.
const daemon = `http://127.0.0.1:${process.env.KIVO_DAEMON_PORT ?? 5175}`
const uiPort = Number(process.env.KIVO_UI_PORT ?? 5174)

export default defineConfig({
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
})
