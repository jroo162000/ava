---
title: Get top processes by memory on Windows
slug: get-top-processes-by-memory-on-windows
uses: 1
proven: false
tags: windows, powershell, memory, processes, troubleshooting
created: 2026-07-03
updated: 2026-07-03
---
WHEN: Need to identify the top RAM-consuming processes, including PID, name, and memory usage
STEPS:
1. Open PowerShell or Command Prompt as administrator
2. Run: Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 5 Id, ProcessName, @{Name='MemoryMB';Expression={[math]::Round($_.WorkingSet64/1MB,2)}}
