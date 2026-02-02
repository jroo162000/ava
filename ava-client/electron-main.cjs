// Electron main process to host the Vite UI as a desktop app.
// - If `dist/index.html` exists, load it directly (built mode)
// - Otherwise, start Vite dev server on 127.0.0.1:5173 and load URL

const { app, BrowserWindow, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')
const http = require('http')

const VITE_HOST = '127.0.0.1'
const VITE_PORT = 5173
const VITE_URL = `http://${VITE_HOST}:${VITE_PORT}/`
const DIST_INDEX = path.join(__dirname, 'dist', 'index.html')

let viteProc = null

function waitForUrl(url, timeoutMs = 30000) {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (Date.now() - start > timeoutMs) return reject(new Error('timeout'))
      const req = http.get(url, (res) => {
        res.resume()
        resolve()
      })
      req.on('error', () => setTimeout(tick, 250))
    }
    tick()
  })
}

async function ensureVite() {
  if (fs.existsSync(DIST_INDEX)) return null // built mode
  // dev mode: start Vite if not already running
  console.log('[electron] Starting Vite dev server...')
  viteProc = spawn(process.platform === 'win32' ? 'cmd' : 'sh', [
    process.platform === 'win32' ? '/c' : '-c',
    'npm run dev -- --host 127.0.0.1 --port 5173 --strictPort'
  ], { cwd: __dirname, stdio: 'inherit', shell: false })
  try {
    await waitForUrl(VITE_URL, 45000)
  } catch (e) {
    console.error('[electron] Vite did not become ready:', e)
  }
  return viteProc
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 740,
    backgroundColor: '#0c0d10',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      devTools: true,
    }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (fs.existsSync(DIST_INDEX)) {
    win.loadFile(DIST_INDEX)
  } else {
    win.loadURL(VITE_URL)
  }
}

app.whenReady().then(async () => {
  await ensureVite()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    try {
      if (viteProc && !viteProc.killed) {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(viteProc.pid), '/f', '/t'])
        } else {
          viteProc.kill('SIGTERM')
        }
      }
    } catch {}
    app.quit()
  }
})

