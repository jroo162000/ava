import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Tier 0 security: the AVA server requires AVA_API_TOKEN on every request.
// The dev server injects it proxy-side so the token never reaches the browser.
// Sources: env var, ava-client/.env(.local), or ava-integration/.env (the canonical home).
function loadAvaApiToken(env) {
  if (process.env.AVA_API_TOKEN) return process.env.AVA_API_TOKEN.trim()
  if (env.AVA_API_TOKEN) return String(env.AVA_API_TOKEN).trim()
  try {
    const p = path.resolve(__dirname, '..', 'ava-integration', '.env')
    const txt = fs.readFileSync(p, 'utf8')
    const m = txt.match(/^\s*AVA_API_TOKEN\s*=\s*(.+)\s*$/m)
    if (m) return m[1].trim().replace(/^["']|["']$/g, '')
  } catch { /* not found — proxy runs without auth header */ }
  return ''
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const target = env.VITE_AVA_SERVER_URL || 'http://127.0.0.1:5051'
  const token = loadAvaApiToken(env)
  const authHeaders = token ? { Authorization: `Bearer ${token}` } : {}

  return {
    // If deploying under a subpath (e.g., https://host/app/), set VITE_BASE to "/app/"
    base: env.VITE_BASE || '/',
    plugins: [react()],
    server: {
      // Tier 0 security: dev server on loopback only (was `true` = all interfaces/LAN).
      host: '127.0.0.1',
      port: 5173,
      strictPort: false, // pick next free port if 5173 is busy
      // Make file watching more tolerant on Windows to avoid EBUSY during edits
      watch: {
        awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 100 },
        usePolling: false,
      },
      // Dev proxy: front-end calls /api/* and /voice/ws; the proxy forwards to the
      // backend and injects the API token server-side.
      proxy: {
        '/api': {
          target,
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/api/, ''),
          headers: authHeaders,
        },
        // Live event stream (voice mirror, tool activity). ws:true upgrades the socket;
        // the token rides the upgrade request's headers.
        '/voice/ws': {
          target,
          changeOrigin: true,
          ws: true,
          headers: authHeaders,
        },
      },
    },
  }
})
