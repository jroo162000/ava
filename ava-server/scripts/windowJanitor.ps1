# windowJanitor.ps1 — AVA proactive housekeeping.
# Closes ONLY (a) non-foreground File Explorer file windows and (b) idle, non-foreground
# Command Prompt (cmd.exe) consoles. Never touches the shell/taskbar/desktop (those are not
# returned by Shell.Application.Windows()), never force-kills, and skips whatever window is
# currently focused. Scoped deliberately to just cmd + File Explorer.
# Emits one "CLOSED: <what>" line per window it closed, for the Node service to log.

$ErrorActionPreference = 'SilentlyContinue'

# Minimal P/Invoke: just the foreground window so we never close what the user is using.
$fg = [IntPtr]::Zero
try {
  $u = Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();' -Name JanitorU -Namespace AvaWin -PassThru
  $fg = $u::GetForegroundWindow()
} catch {}

$closed = @()

# 1) File Explorer windows. Shell.Application.Windows() enumerates only Explorer/IE-family
#    windows — NOT the desktop, taskbar, or Start. Filter to explorer.exe so we skip Edge/IE.
try {
  $shell = New-Object -ComObject Shell.Application
  foreach ($w in @($shell.Windows())) {
    try {
      $full = ''
      try { $full = [string]$w.FullName } catch {}
      if ($full -and $full.ToLower().EndsWith('explorer.exe')) {
        $h = [IntPtr]$w.HWND
        if ($h -ne $fg) {
          $name = ''
          try { $name = [string]$w.LocationName } catch {}
          $w.Quit()                      # closes just this Explorer window
          $closed += ("explorer:" + $name)
        }
      }
    } catch {}
  }
} catch {}

# 2) Command Prompt consoles. Skip the foreground one and any that started < 30s ago
#    (so a freshly launched script console — including AVA's own — is never interrupted).
try {
  foreach ($p in @(Get-Process -Name cmd -ErrorAction SilentlyContinue)) {
    try {
      $h = $p.MainWindowHandle
      if ($h -ne [IntPtr]::Zero -and $h -ne $fg) {
        $ageOk = $true
        try { $ageOk = ((Get-Date) - $p.StartTime).TotalSeconds -ge 30 } catch { $ageOk = $true }
        if ($ageOk) {
          [void]$p.CloseMainWindow()     # gentle WM_CLOSE, not a force-kill
          $closed += ("cmd:pid" + $p.Id)
        }
      }
    } catch {}
  }
} catch {}

$closed | ForEach-Object { "CLOSED: $_" }
