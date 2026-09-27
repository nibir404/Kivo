import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const daemon = 'http://127.0.0.1:5175'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: {
    port: 5174,
    strictPort: true,
    watch: { ignored: ['**/.kivo-workspace/**'] },
    proxy: {
      '/api': { target: daemon, changeOrigin: false },
      '/ws': { target: daemon, ws: true, changeOrigin: false },
    },
  },
})
