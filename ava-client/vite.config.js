import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// Allow the dev server to bind to all local hosts (localhost/LAN)
// and auto-pick a free port if 5173 is taken.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    // If deploying under a subpath (e.g., https://host/app/), set VITE_BASE to "/app/"
    base: env.VITE_BASE || '/',
    plugins: [react()],
    server: {
      host: true, // accept localhost and LAN
      port: 5173,
      strictPort: false, // pick next free port if 5173 is busy
      // Make file watching more tolerant on Windows to avoid EBUSY during edits
      watch: {
        awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 100 },
        usePolling: false,
      },
      // Dev proxy: front-end can call /api/* and this forwards to backend
      proxy: {
        '/api': {
          target: env.VITE_AVA_SERVER_URL || 'http://127.0.0.1:5051',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ''),
        },
      },
    },
  }
})
