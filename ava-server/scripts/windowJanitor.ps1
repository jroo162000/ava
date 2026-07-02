# windowJanitor.ps1 -- AVA proactive housekeeping + monitor-fed console cleanup.
# Closes ONLY (never the foreground window; consoles must be >=30s old; gentle WM_CLOSE, never a kill):
#   - File Explorer file windows            (class CabinetWClass)
#   - classic Command Prompt consoles       (process cmd.exe) that are IDLE
#   - Windows Terminal windows hosting cmd  (title has cmd/command prompt) that are IDLE
#   - MONITOR-FED: leftover "AVA Server (5051)" console windows -- but ONLY when the live server on 5051
#     is a HIDDEN standalone node (MainWindowHandle 0), so the visible ones are provably dead leftovers.
# PROTECTED so AVA's own dev consoles (UI 5173 / server 5051 / voice) are NEVER closed:
#   - by window TITLE (AVA Client|Server|Local Voice / :5173 / :5051 / npm / vite / voice), AND
#   - by PROCESS TREE: any console whose tree contains a live node/npm/python descendant is a RUNNING
#     dev server, not an idle leftover, so it is skipped even if its title was rewritten to a path by the
#     dev tool. (Vite/npm rename the console to the cwd "C:\...\ava-client", which used to match the
#     default-prompt rule and get the UI window closed. The process-tree guard fixes that at the root.)
# Set AVA_JANITOR_DRYRUN=1 to LOG what it would close (and every console it sees) instead of closing.
# Never matches Progman/Shell_TrayWnd, so the desktop/taskbar (also explorer.exe) are never touched.
$ErrorActionPreference = 'SilentlyContinue'
$DRYRUN = ($env:AVA_JANITOR_DRYRUN -eq '1')

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

# Process-tree map (built once): parent PID -> child processes. Used to tell a live dev-server console
# (has a node/npm/python descendant) from an idle leftover cmd (has none).
$childMap = @{}
try {
  foreach ($p in (Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
    $ppid = [int]$p.ParentProcessId
    if (-not $childMap.ContainsKey($ppid)) { $childMap[$ppid] = New-Object System.Collections.ArrayList }
    [void]$childMap[$ppid].Add($p)
  }
} catch {}
function HasLiveDescendant([int]$rootPid) {
  $stack = New-Object System.Collections.Stack
  [void]$stack.Push($rootPid)
  $seen = @{}
  $iter = 0
  while ($stack.Count -gt 0 -and $iter -lt 10000) {
    $iter++
    $cur = [int]$stack.Pop()
    if ($seen.ContainsKey($cur)) { continue }
    $seen[$cur] = $true
    if ($childMap.ContainsKey($cur)) {
      foreach ($c in $childMap[$cur]) {
        $n = ($c.Name -replace '\.exe$','').ToLower()
        if ($n -eq 'node' -or $n -eq 'npm' -or $n -eq 'python' -or $n -eq 'pythonw' -or $n -eq 'vite') { return $true }
        [void]$stack.Push([int]$c.ProcessId)
      }
    }
  }
  return $false
}

# Monitor gate: is the live 5051 server a hidden standalone node? Only then are the leftover
# "AVA Server (5051)" console windows all provably dead (the live one owns no window).
$serverHiddenNode = $false
try {
  $op = (Get-NetTCPConnection -LocalPort 5051 -State Listen -ErrorAction SilentlyContinue).OwningProcess | Select-Object -First 1
  if ($op) { $sp = Get-Process -Id $op -ErrorAction SilentlyContinue; if ($sp -and $sp.ProcessName -eq 'node' -and $sp.MainWindowHandle -eq [IntPtr]::Zero) { $serverHiddenNode = $true } }
} catch {}

$closed = @()
$seenLog = @()
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
  # PROTECTED by title: AVA's own long-lived service consoles (cmd /k npm ...).
  $isProtected   = ($title -match '(?i)AVA (Client|Server|Local Voice)|:5173|:5051|npm|vite|voice')
  # PROTECTED by process tree: a console running a live node/npm/python is a running dev server, never a
  # leftover -- this holds even if the dev tool rewrote the title to a path. Only computed for consoles.
  $hasLive = $false
  if ($isConsoleHost) { $hasLive = HasLiveDescendant $wpid }
  $safe = ($isProtected -or $hasLive)
  # Only treat a classic cmd window as a closeable leftover if it looks like a default prompt
  # (title is a path / "Command Prompt" / blank), matching the intent of the terminal-cmd rule.
  $looksDefault  = ($title -eq '' -or $title -match '(?i)^(command prompt|c:\\|administrator:|windows\\system32)')
  # Only a TRUE standalone classic console (ConsoleWindowClass) is a closeable leftover. A cmd of class
  # PseudoConsoleWindow is the ConPTY backer of a LIVE console app (e.g. the UI's `npm run dev`); closing
  # it kills that app -- which is exactly what was taking the UI down. Never match those.
  $isClassicCmd  = (($cls -eq 'ConsoleWindowClass') -and ($name -eq 'cmd') -and $looksDefault -and -not $safe)
  $isTermCmd     = (($name -eq 'WindowsTerminal' -or $name -eq 'OpenConsole') -and ($title -match '(?i)command prompt|cmd') -and -not $safe)
  # Stale-server cleanup fires only when the live server is a hidden node, so the visible
  # "AVA Server (5051)" console is genuinely a leftover -- it bypasses the title protection.
  $isStaleServer = ($serverHiddenNode -and $isConsoleHost -and ($title -match 'AVA Server \(5051\)') -and -not $hasLive)
  if ($DRYRUN -and $isConsoleHost) { $seenLog += ("SEEN: $name | cls=$cls | '$title' | live=$hasLive prot=$isProtected def=$looksDefault") }
  if ($isExplorer -or $isClassicCmd -or $isTermCmd -or $isStaleServer) {
    $ageOk = $true
    if ($isClassicCmd -or $isTermCmd) { try { $ageOk = ((Get-Date) - $proc.StartTime).TotalSeconds -ge 30 } catch { $ageOk = $true } }
    if ($ageOk) {
      if (-not $DRYRUN) { [void][AvaJan]::PostMessage([IntPtr]$h, $WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero) }
      $closed += ($name + '/' + $cls + ':' + $title)
    }
  }
}
$seenLog | ForEach-Object { $_ }
if ($DRYRUN) { $closed | ForEach-Object { "WOULD-CLOSE: $_" } } else { $closed | ForEach-Object { "CLOSED: $_" } }
