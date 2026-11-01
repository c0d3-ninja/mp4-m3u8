import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const API_URL = process.env.VITE_API_URL || 'http://localhost:4000'

export default defineConfig({
  plugins: [react()],
  build: {
    // hls.js (preview player) is ~580 kB and already split into its own lazy chunk
    chunkSizeWarningLimit: 700,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': API_URL,
      '/hls': API_URL,
    },
  },
})
