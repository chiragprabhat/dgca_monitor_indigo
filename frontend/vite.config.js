import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The dashboard is served on this PC only (127.0.0.1), never on the office network.
// `npm run build` + `npm run preview` serve the built files; `server` applies only
// when a developer runs the dev server (`npm run dev`) by hand.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true
  },
  preview: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true
  },
  build: {
    outDir: 'dist',
    sourcemap: false
  }
})
