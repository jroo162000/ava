---
title: Compile memory report with safe-to-close recommendations
slug: compile-memory-report-with-safe-to-close-recommendations
uses: 1
proven: false
tags: memory, report, troubleshooting, read-only
created: 2026-07-06
updated: 2026-07-06
---
WHEN: when you need to produce a final finding from memory/process data in a read-only investigation
STEPS:
1. Collect the top 3-5 processes by RAM usage from the process list (including PID, name, RAM in MB/GB).
2. For each process, determine if it's a user app (e.g., browser, media player, office suite) or system-critical (e.g., kernel, driver, OS service).
3. Format the report as:
4.   - Process Name, PID, RAM used (e.g., 350 MB), classification: 'safe to close' or 'must keep'
5.   - Add a brief reason column if helpful (e.g., 'user-launched browser tabs').
6. Write a clear recommendation sentence: which specific user apps could be closed to recover memory (e.g., 'Closing chrome.exe and VLC would free ~1.2 GB').
7. Do NOT include any commands to close processes; state only the recommendation.
