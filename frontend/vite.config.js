import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ command, mode }) => {
  if (command === 'build' && process.env.VERCEL) {
    const { VITE_API_BASE_URL } = loadEnv(mode, process.cwd(), 'VITE_')
    if (VITE_API_BASE_URL && VITE_API_BASE_URL.trim().replace(/\/+$/, '') !== '/api') {
      throw new Error('The Vercel frontend uses the same-origin /api endpoint. Unset VITE_API_BASE_URL.')
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
    define: { __DGCA_SERVERLESS__: JSON.stringify(process.env.VERCEL === '1') },
    server: localServer,
    preview: localServer,
    build: {
      outDir: 'dist',
      sourcemap: false
    }
  }
})
