---
title: Get top RAM-consuming processes on any OS
slug: get-top-ram-consuming-processes-on-any-os
uses: 1
proven: false
tags: troubleshooting, memory, process management, diagnostics
created: 2026-07-06
updated: 2026-07-06
---
WHEN: Need to quickly identify processes using the most memory for troubleshooting or optimization analysis
STEPS:
1. For Linux/macOS: run 'ps aux --sort=-%mem' or 'top -l 1 -n 10 -o mem'
2. For Windows (PowerShell): run 'Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 10 Name, Id, @{Name=''MB''; Expression={[math]::Round($_.WorkingSet64/1MB, 1)}}'
3. If sys_ops tool available, call it with args like {action:'processes', sort_by:'memory', limit:10} or {get:'processes'} as fallback
4. When tool fails, fall back to native OS commands: 'tasklist /FO CSV /NH' (Windows) then parse
5. Capture: process name, PID, and memory usage in a readable format (e.g., MB or %)
6. List top 5-10 results for analysis
