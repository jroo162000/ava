[CmdletBinding()]
param(
  [ValidateSet('Start', 'Stop', 'Restart', 'Status', 'Watch')]
  [string]$Action = 'Start',
  [int]$ServerPort = $(if ($env:AVA_PORT) { [int]$env:AVA_PORT } else { 5051 }),
  [int]$ClientPort = $(if ($env:AVA_CLIENT_PORT) { [int]$env:AVA_CLIENT_PORT } else { 5173 }),
  [switch]$NoWatchdog
)

$ErrorActionPreference = 'Stop'
$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$ServerDir = Join-Path $RepoRoot 'ava-server'
$ClientDir = Join-Path $RepoRoot 'ava-client'
$IntegrationDir = Join-Path $RepoRoot 'ava-integration'
$VoiceScript = Join-Path $IntegrationDir 'ava_local_voice.py'
$PythonExe = Join-Path $IntegrationDir '.venv\Scripts\python.exe'
$ServerEntry = Join-Path $ServerDir 'src\server.js'
$ViteEntry = Join-Path $ClientDir 'node_modules\vite\bin\vite.js'
$StatePath = Join-Path $ServerDir 'data\runtime-supervisor.json'
$LogDir = Join-Path $RepoRoot 'logs\runtime'
$SupervisorMarker = '-Action Watch -ServerPort'
$script:Roles = [ordered]@{}

function Ensure-Layout {
  foreach ($path in @($ServerDir, $ClientDir, $IntegrationDir, $VoiceScript, $PythonExe, $ServerEntry, $ViteEntry)) {
    if (-not (Test-Path -LiteralPath $path)) { throw "Required AVa component is missing: $path" }
  }
  New-Item -ItemType Directory -Force -Path (Split-Path $StatePath), $LogDir | Out-Null
}

function Get-RawCommandProcesses([string]$Marker) {
  @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -and $_.CommandLine.IndexOf($Marker, [StringComparison]::OrdinalIgnoreCase) -ge 0
  })
}

function Get-CommandProcesses([string]$Marker) {
  $matches = @(Get-RawCommandProcesses $Marker)
  $matchIds = @($matches | ForEach-Object { [int]$_.ProcessId })
  @($matches | Where-Object { $matchIds -notcontains [int]$_.ParentProcessId })
}

function Stop-ProcessTree([int]$ProcessId) {
  $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$ProcessId" -ErrorAction SilentlyContinue)
  foreach ($child in $children) { Stop-ProcessTree ([int]$child.ProcessId) }
  Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

function Get-PortOwner([int]$Port) {
  try {
    Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop | Select-Object -First 1
  } catch { $null }
}

function Test-AvaHealth {
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$ServerPort/health" -TimeoutSec 8
    return $health.ok -eq $true -and $null -ne $health.toolsCount
  } catch { return $false }
}

function Wait-Until([scriptblock]$Condition, [int]$TimeoutSeconds, [string]$Description) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (& $Condition) { return }
    Start-Sleep -Milliseconds 500
  }
  throw "Timed out waiting for $Description"
}

function Register-Role([string]$Role, $Process, [string]$Marker, [bool]$Adopted) {
  $script:Roles[$Role] = [ordered]@{
    role = $Role
    pid = [int]$Process.ProcessId
    marker = $Marker
    adopted = $Adopted
    observedAt = (Get-Date).ToUniversalTime().ToString('o')
  }
}

function Start-ManagedProcess(
  [string]$Role,
  [string]$Marker,
  [string]$FilePath,
  [string[]]$Arguments,
  [string]$WorkingDirectory
) {
  $existing = @(Get-CommandProcesses $Marker | Sort-Object CreationDate)
  if ($existing.Count -gt 0) {
    Register-Role $Role $existing[0] $Marker $true
    if ($existing.Count -gt 1) {
      foreach ($duplicate in $existing | Select-Object -Skip 1) {
        Stop-ProcessTree ([int]$duplicate.ProcessId)
      }
      Write-Warning "Stopped $($existing.Count - 1) duplicate $Role process(es)."
    }
    return
  }

  $stdout = Join-Path $LogDir "$Role.out.log"
  $stderr = Join-Path $LogDir "$Role.err.log"
  $argumentLine = @($Arguments | ForEach-Object {
    $value = [string]$_
    if ($value -match '[\s"]') { '"' + $value.Replace('"', '\"') + '"' } else { $value }
  }) -join ' '
  $process = Start-Process -FilePath $FilePath -ArgumentList $argumentLine -WorkingDirectory $WorkingDirectory `
    -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
  $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$($process.Id)" -ErrorAction Stop
  Register-Role $Role $cim $Marker $false
}

function Save-State {
  $state = [ordered]@{
    schemaVersion = 1
    canonicalVoiceRunner = $VoiceScript
    serverUrl = "http://127.0.0.1:$ServerPort"
    clientUrl = "http://127.0.0.1:$ClientPort"
    updatedAt = (Get-Date).ToUniversalTime().ToString('o')
    roles = @($script:Roles.Values)
  }
  $state | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $StatePath -Encoding UTF8
}

function Start-Stack([bool]$StartWatchdog = $true) {
  Ensure-Layout
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  $powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
  $env:AVA_INTEGRATION_DIR = $IntegrationDir
  $env:AVA_SERVER_URL = "http://127.0.0.1:$ServerPort"
  $env:AVA_PORT = [string]$ServerPort
  $env:AVA_CLIENT_PORT = [string]$ClientPort
  Remove-Item Env:DISABLE_AUTONOMY -ErrorAction SilentlyContinue

  if (-not (Test-AvaHealth)) {
    $owner = Get-PortOwner $ServerPort
    if ($owner -and @(Get-CommandProcesses $ServerEntry).Count -eq 0) {
      throw "Port $ServerPort is occupied by PID $($owner.OwningProcess), but it is not AVa's canonical server."
    }
    Start-ManagedProcess 'server' $ServerEntry $node @($ServerEntry) $ServerDir
    Wait-Until { Test-AvaHealth } 120 'AVa server health'
  } else {
    $server = @(Get-CommandProcesses $ServerEntry | Select-Object -First 1)
    if ($server.Count) { Register-Role 'server' $server[0] $ServerEntry $true }
  }

  $clientOwner = Get-PortOwner $ClientPort
  $clientProcesses = @(Get-CommandProcesses $ViteEntry)
  if ($clientOwner -and $clientProcesses.Count -eq 0) {
    throw "Port $ClientPort is occupied by PID $($clientOwner.OwningProcess), but it is not AVa's UI."
  }
  Start-ManagedProcess 'client' $ViteEntry $node @($ViteEntry, '--host', '127.0.0.1', '--port', [string]$ClientPort, '--strictPort') $ClientDir
  Wait-Until { $null -ne (Get-PortOwner $ClientPort) } 45 'AVa UI port'

  Start-ManagedProcess 'voice' $VoiceScript $PythonExe @($VoiceScript) $IntegrationDir

  if ($StartWatchdog -and -not $NoWatchdog) {
    Start-ManagedProcess 'watchdog' $SupervisorMarker $powershell @(
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath,
      '-Action', 'Watch', '-ServerPort', [string]$ServerPort, '-ClientPort', [string]$ClientPort, '-NoWatchdog'
    ) $RepoRoot
  }
  Save-State
}

function Stop-Matching([string]$Marker, [string]$Role) {
  $matches = @(Get-CommandProcesses $Marker | Sort-Object CreationDate -Descending)
  foreach ($process in $matches) {
    Stop-ProcessTree ([int]$process.ProcessId)
  }
  if ($matches.Count) { Write-Host "Stopped $Role ($($matches.Count) process(es))." }
}

function Stop-Stack {
  Stop-Matching $SupervisorMarker 'watchdog'
  Stop-Matching $VoiceScript 'voice'
  Stop-Matching $ViteEntry 'client'
  Stop-Matching $ServerEntry 'server'
  if (Test-Path -LiteralPath $StatePath) {
    $stopped = [ordered]@{ schemaVersion = 1; status = 'stopped'; updatedAt = (Get-Date).ToUniversalTime().ToString('o'); roles = @() }
    $stopped | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $StatePath -Encoding UTF8
  }
}

function Show-Status {
  $items = @(
    [pscustomobject]@{ Role = 'server'; Count = @(Get-CommandProcesses $ServerEntry).Count; Healthy = (Test-AvaHealth) }
    [pscustomobject]@{ Role = 'client'; Count = @(Get-CommandProcesses $ViteEntry).Count; Healthy = ($null -ne (Get-PortOwner $ClientPort)) }
    [pscustomobject]@{ Role = 'voice'; Count = @(Get-CommandProcesses $VoiceScript).Count; Healthy = (@(Get-CommandProcesses $VoiceScript).Count -eq 1) }
    [pscustomobject]@{ Role = 'watchdog'; Count = @(Get-CommandProcesses $SupervisorMarker).Count; Healthy = (@(Get-CommandProcesses $SupervisorMarker).Count -eq 1) }
  )
  $items | Format-Table -AutoSize
  Write-Host "UI: http://127.0.0.1:$ClientPort"
  Write-Host "Server: http://127.0.0.1:$ServerPort"
}

switch ($Action) {
  'Start' {
    Start-Stack
    Show-Status
  }
  'Stop' { Stop-Stack }
  'Restart' {
    Stop-Stack
    Start-Sleep -Seconds 2
    Start-Stack
    Show-Status
  }
  'Status' { Show-Status }
  'Watch' {
    while ($true) {
      try { Start-Stack $false } catch { Write-Error $_ -ErrorAction Continue }
      Start-Sleep -Seconds 15
    }
  }
}
