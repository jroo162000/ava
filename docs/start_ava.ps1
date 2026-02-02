<#
Starts the full AVA stack locally so you can use the website URL.

It will:
  1) Start the backend (ava-server) on http://127.0.0.1:5051
  2) Start the frontend (ava-client) dev server on http://localhost:5173

Usage:
  From the repo root:  ./start_ava.ps1

Notes:
  - Accept the Windows firewall prompt for Node.js if shown.
  - If ports are busy, the script will tell you what to do.
#>

function Test-Port($Port){
  try {
    $net = (netstat -ano | Select-String ":$Port\s").ToString()
    return -not [string]::IsNullOrWhiteSpace($net)
  } catch { return $false }
}

Write-Host "[AVA] Ensuring backend (5051) and frontend (5173) are running..." -ForegroundColor Cyan

# 1) Start backend
Push-Location "$PSScriptRoot/ava-server"
try {
  if (-not (Test-Path node_modules)) {
    Write-Host "[AVA] Installing server deps..." -ForegroundColor Yellow
    npm install
  }

  if (Test-Port 5051) {
    Write-Host "[AVA] Port 5051 already in use. Assuming server is running." -ForegroundColor Yellow
  } else {
    Write-Host "[AVA] Starting server on http://127.0.0.1:5051" -ForegroundColor Cyan
    Start-Process powershell -ArgumentList '-NoExit','-Command','npm start' -WorkingDirectory (Get-Location)
    Start-Sleep -Seconds 2
  }
}
finally { Pop-Location }

# 2) Start frontend
Push-Location "$PSScriptRoot/ava-client"
try {
  if (-not (Test-Path node_modules)) {
    Write-Host "[AVA] Installing client deps..." -ForegroundColor Yellow
    npm install
  }

  if (Test-Port 5173) {
    Write-Host "[AVA] Port 5173 already in use. Open http://localhost:5173" -ForegroundColor Green
  } else {
    Write-Host "[AVA] Starting client dev server on http://localhost:5173" -ForegroundColor Cyan
    Start-Process powershell -ArgumentList '-NoExit','-Command','npm run dev -- --host --port 5173 --strictPort' -WorkingDirectory (Get-Location)
  }
}
finally { Pop-Location }

Write-Host "[AVA] Ready: Frontend http://localhost:5173  |  Backend http://127.0.0.1:5051" -ForegroundColor Green

