# windowJanitor.ps1 -- AVA proactive housekeeping.
# Closes ONLY, and only when NOT the foreground window and (for consoles) at least 30s old:
#   - File Explorer file windows           (class CabinetWClass)
#   - classic Command Prompt consoles      (process cmd.exe, class ConsoleWindowClass)
#   - Windows Terminal windows hosting cmd (process WindowsTerminal, title contains "Command Prompt"/"cmd")
# Never touches the shell (desktop=Progman, taskbar=Shell_TrayWnd are never CabinetWClass), never
# force-kills (gentle WM_CLOSE), and never closes a PowerShell/other Windows Terminal tab.
# Emits one "CLOSED: <what>" line per window closed, for the Node service to log.
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
$closed = @()
foreach ($row in [AvaJan]::List()) {
  $parts = $row -split '\|', 4
  if ($parts.Count -lt 4) { continue }
  $h = [long]$parts[0]; $wpid = [int]$parts[1]; $cls = $parts[2]; $title = $parts[3]
  if ($h -eq $fg) { continue }
  $proc = Get-Process -Id $wpid -ErrorAction SilentlyContinue
  if (-not $proc) { continue }
  $name = $proc.ProcessName
  $isExplorer   = ($cls -eq 'CabinetWClass')
  $isClassicCmd = ($name -eq 'cmd')
  $isTermCmd    = (($name -eq 'WindowsTerminal' -or $name -eq 'OpenConsole') -and ($title -match '(?i)command prompt|cmd'))
  if ($isExplorer -or $isClassicCmd -or $isTermCmd) {
    $ageOk = $true
    if ($isClassicCmd -or $isTermCmd) { try { $ageOk = ((Get-Date) - $proc.StartTime).TotalSeconds -ge 30 } catch { $ageOk = $true } }
    if ($ageOk) {
      [void][AvaJan]::PostMessage([IntPtr]$h, $WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero)
      $closed += ($name + '/' + $cls + ':' + $title)
    }
  }
}
$closed | ForEach-Object { "CLOSED: $_" }
