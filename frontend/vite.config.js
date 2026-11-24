import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ command, mode }) => {
  if (command === 'build' && process.env.VERCEL) {
    const { VITE_API_BASE_URL } = loadEnv(mode, process.cwd(), 'VITE_')
    let api
    try { api = new URL(VITE_API_BASE_URL) } catch { /* Report invalid config without exposing its value. */ }
    if (!api || api.protocol !== 'https:' || api.username || api.password || api.search || api.hash ||
        api.pathname.replace(/\/+$/, '') !== '/api') {
      throw new Error('Set VITE_API_BASE_URL to the public HTTPS backend URL ending in /api')
    }
  }
  const localServer = {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:5000' }
  }
  return {
    plugins: [react()],
    server: localServer,
    preview: localServer,
    build: {
      outDir: 'dist',
      sourcemap: false
    }
  }
})
