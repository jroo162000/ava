# windowJanitor.ps1 -- AVA proactive housekeeping + monitor-fed console cleanup.
# Closes ONLY (never the foreground window; consoles must be >=30s old; gentle WM_CLOSE, never a kill):
#   - File Explorer file windows            (class CabinetWClass)
#   - classic Command Prompt consoles       (process cmd.exe)
#   - Windows Terminal windows hosting cmd  (process WindowsTerminal/OpenConsole, title has cmd/command prompt)
#   - MONITOR-FED: leftover "AVA Server (5051)" console windows -- but ONLY when the live server on 5051
#     is a HIDDEN standalone node (MainWindowHandle 0). In that case no visible "AVA Server (5051)" window
#     can be the live one, so they're all provably dead restart leftovers and safe to close.
# Deliberately NOT touched: the voice python console, and "AVA Client (5173)" windows -- because those run
# inside Windows Terminal, which shares one PID across windows, so a live one can't be told from a dead one.
# Never matches Progman/Shell_TrayWnd, so the desktop/taskbar (also explorer.exe) are never touched.
$ErrorActionPreference = 'SilentlyContinue'

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
foreach ($row in [AvaJan]::List()) {
  $parts = $row -split '\|', 4
  if ($parts.Count -lt 4) { continue }
  $h = [long]$parts[0]; $wpid = [int]$parts[1]; $cls = $parts[2]; $title = $parts[3]
  if ($h -eq $fg) { continue }
  $proc = Get-Process -Id $wpid -ErrorAction SilentlyContinue
  if (-not $proc) { continue }
  $name = $proc.ProcessName
  $isConsoleHost = ($cls -eq 'CASCADIA_HOSTING_WINDOW_CLASS' -or $cls -eq 'ConsoleWindowClass' -or $name -eq 'cmd' -or $name -eq 'WindowsTerminal' -or $name -eq 'OpenConsole')
  $isExplorer    = ($cls -eq 'CabinetWClass')
  $isClassicCmd  = ($name -eq 'cmd')
  $isTermCmd     = (($name -eq 'WindowsTerminal' -or $name -eq 'OpenConsole') -and ($title -match '(?i)command prompt|cmd'))
  $isStaleServer = ($serverHiddenNode -and $isConsoleHost -and ($title -match 'AVA Server \(5051\)'))
  if ($isExplorer -or $isClassicCmd -or $isTermCmd -or $isStaleServer) {
    $ageOk = $true
    if ($isClassicCmd -or $isTermCmd) { try { $ageOk = ((Get-Date) - $proc.StartTime).TotalSeconds -ge 30 } catch { $ageOk = $true } }
    if ($ageOk) {
      [void][AvaJan]::PostMessage([IntPtr]$h, $WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero)
      $closed += ($name + '/' + $cls + ':' + $title)
    }
  }
}
$closed | ForEach-Object { "CLOSED: $_" }
