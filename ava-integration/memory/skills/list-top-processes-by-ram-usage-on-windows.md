---
title: List top processes by RAM usage on Windows
slug: list-top-processes-by-ram-usage-on-windows
uses: 1
proven: false
tags: memory, processes, RAM, troubleshooting, Windows, sysadmin
created: 2026-07-02
updated: 2026-07-02
---
WHEN: Need to see which processes are using the most memory, sorted by RAM
STEPS:
1. Run: ps aux --sort=-%mem | head -20 on Linux/macOS
2. On Windows, run: Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 20 | Format-Table Id, ProcessName, @{Name='MB';Expression={[math]::Round($_.WorkingSet64/1MB,2)}}, @{Name='%MEM';Expression={[math]::Round($_.WorkingSet64/$({(Get-CimInstance Win32_OperatingSystem).TotalVisibleMemorySize*1KB})*100,2)}} -AutoSize
3. Read the resulting list to find top 3-5 consumers with their PID, MB, and %MEM
4. Identify which processes are user apps (safe to close) vs system-critical ones (must keep)
5. Produce concise recommendation explaining what could be safely closed to recover memory without terminating anything
