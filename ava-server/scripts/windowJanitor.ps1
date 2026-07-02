# windowJanitor.ps1 -- AVA proactive housekeeping + monitor-fed console cleanup.
# CONSERVATIVE by design: it will only ever close things it can prove are safe. It NEVER closes a
# Windows-Terminal-hosted console (that is where the UI 5173 / server 5051 / voice all live), because
# WT rewrites titles at runtime (npm/vite rename the tab) and reparents the shell out of the window's
# process tree, so a live one cannot be reliably told from a dead one. Closing those was what kept
# taking the UI down.
# Closes ONLY (never the foreground window; classic consoles must be >=30s old; gentle WM_CLOSE):
#   - File Explorer file windows            (class CabinetWClass)
#   - TRUE standalone classic consoles      (class ConsoleWindowClass, process cmd, default/blank title)
#   - MONITOR-FED leftover "AVA Server (5051)" windows -- ONLY when the live 5051 owner is a HIDDEN
#     standalone node (MainWindowHandle 0), so the visible ones are provably dead restart leftovers.
# Every sweep appends a census (all console windows it saw + anything it closed + WHY) to
#   codex_review\janitor_actions.log  (trimmed to the last 400 lines) -- the ground-truth audit trail.
# Set AVA_JANITOR_DRYRUN=1 to log/print what it WOULD close without closing anything.
$ErrorActionPreference = 'SilentlyContinue'
$DRYRUN = ($env:AVA_JANITOR_DRYRUN -eq '1')
$logPath = Join-Path $PSScriptRoot '..\..\..\codex_review\janitor_actions.log'

$src = @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class AvaJan {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int m);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int m);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  private delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc cb, IntPtr l);
  public static List<string> List() {
    var outp = new List<string>();
    EnumWindows((h, l) => {
      if (IsWindowVisible(h)) {
        var cb = new StringBuilder(256); GetClassName(h, cb, 256);
        int tl = GetWindowTextLength(h); var tb = new StringBuilder(tl + 2); GetWindowText(h, tb, tl + 2);
        uint pid; GetWindowThreadProcessId(h, out pid);
        outp.Add(((long)h) + "|" + pid + "|" + cb.ToString() + "|" + tb.ToString());
      }
      return true;
    }, IntPtr.Zero);
    return outp;
  }
}
"@
try { Add-Type -TypeDefinition $src -Language CSharp } catch {}

$fg = [long][AvaJan]::GetForegroundWindow()
$WM_CLOSE = 0x0010

# Monitor gate: is the live 5051 server a hidden standalone node? Only then are the leftover
# "AVA Server (5051)" console windows all provably dead (the live one owns no window).
$serverHiddenNode = $false
try {
  $op = (Get-NetTCPConnection -LocalPort 5051 -State Listen -ErrorAction SilentlyContinue).OwningProcess | Select-Object -First 1
  if ($op) { $sp = Get-Process -Id $op -ErrorAction SilentlyContinue; if ($sp -and $sp.ProcessName -eq 'node' -and $sp.MainWindowHandle -eq [IntPtr]::Zero) { $serverHiddenNode = $true } }
} catch {}

$closed = @()
$census = @()
foreach ($row in [AvaJan]::List()) {
  $parts = $row -split '\|', 4
  if ($parts.Count -lt 4) { continue }
  $h = [long]$parts[0]; $wpid = [int]$parts[1]; $cls = $parts[2]; $title = $parts[3]
  if ($h -eq $fg) { continue }
  $proc = Get-Process -Id $wpid -ErrorAction SilentlyContinue
  if (-not $proc) { continue }
  $name = $proc.ProcessName
  $isConsoleHost = ($cls -eq 'CASCADIA_HOSTING_WINDOW_CLASS' -or $cls -eq 'ConsoleWindowClass' -or $cls -eq 'PseudoConsoleWindow' -or $name -eq 'cmd' -or $name -eq 'WindowsTerminal' -or $name -eq 'OpenConsole')
  $isExplorer    = ($cls -eq 'CabinetWClass')
  # A classic standalone console is the ONLY console type we ever close. WT/ConPTY hosts (CASCADIA,
  # PseudoConsoleWindow, OpenConsole, WindowsTerminal) are never closed by the generic rules.
  $looksDefault  = ($title -eq '' -or $title -match '(?i)^(command prompt|c:\\|administrator:|windows\\system32)')
  $isClassicCmd  = (($cls -eq 'ConsoleWindowClass') -and ($name -eq 'cmd') -and $looksDefault)
  # Stale-server cleanup fires only when the live server is a hidden node, so the visible
  # "AVA Server (5051)" console is genuinely a leftover -- it is the ONLY WT window ever closed.
  $isStaleServer = ($serverHiddenNode -and $isConsoleHost -and ($title -match 'AVA Server \(5051\)'))
  $why = ''
  if ($isExplorer) { $why = 'explorer' } elseif ($isClassicCmd) { $why = 'classic-cmd' } elseif ($isStaleServer) { $why = 'stale-5051' }
  if ($isConsoleHost) { $census += ("  SEEN $name | $cls | '$title' | rule=" + ($(if($why){$why}else{'KEEP'}))) }
  if ($why) {
    $ageOk = $true
    if ($isClassicCmd) { try { $ageOk = ((Get-Date) - $proc.StartTime).TotalSeconds -ge 30 } catch { $ageOk = $true } }
    if ($ageOk) {
      if (-not $DRYRUN) { [void][AvaJan]::PostMessage([IntPtr]$h, $WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero) }
      $closed += ("$why :: $name/$cls :: '$title'")
    }
  }
}

# Ground-truth audit log (append + trim). Records the console census + any closes, every sweep.
try {
  $stamp = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
  $out = @("[$stamp] dryrun=$DRYRUN consoles=$($census.Count) closed=$($closed.Count)")
  $out += $census
  foreach ($c in $closed) { $out += ("  " + $(if($DRYRUN){'WOULD-CLOSE'}else{'CLOSED'}) + " -> $c") }
  Add-Content -Path $logPath -Value $out -ErrorAction SilentlyContinue
  $all = @(Get-Content -Path $logPath -ErrorAction SilentlyContinue)
  if ($all.Count -gt 400) { Set-Content -Path $logPath -Value ($all | Select-Object -Last 400) -ErrorAction SilentlyContinue }
} catch {}

if ($DRYRUN) { $closed | ForEach-Object { "WOULD-CLOSE: $_" } } else { $closed | ForEach-Object { "CLOSED: $_" } }
