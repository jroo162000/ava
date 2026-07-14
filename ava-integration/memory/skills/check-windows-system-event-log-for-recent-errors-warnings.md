---
title: Check Windows System event log for recent errors/warnings
slug: check-windows-system-event-log-for-recent-errors-warnings
uses: 1
proven: false
tags: event-log, troubleshooting, windows, error-analysis
created: 2026-07-12
updated: 2026-07-12
---
WHEN: Investigating stability issues or failures related to window operations or system components
STEPS:
1. Open Event Viewer (eventvwr.msc) or use PowerShell: Get-WinEvent -LogName System -MaxEvents 50 | Where-Object { $_.LevelDisplayName -match 'Error|Warning' }
2. Filter events from last 24 hours using: Get-WinEvent -LogName System -FilterXPath '*[System[TimeCreated[timediff(@SystemTime) <= 86400000]]]'
3. Look for event IDs: 1000 (Application Error), 1001 (Windows Error Reporting), 10010 (DCOM error), 41 (Kernel-Power), 161 (BugCheck), or any red/error entries related to window_ops or browser processes
4. Check Application log for matching errors in same time window: Get-WinEvent -LogName Application -MaxEvents 50
5. Document any relevant error codes, module names, and timestamps for cross-referencing with window_ops failures
