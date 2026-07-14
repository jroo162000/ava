---
title: Produce memory pressure report with safe-to-close recommendations
slug: produce-memory-pressure-report-with-safe-to-close-recommenda
uses: 1
proven: false
tags: memory-pressure, sys_ops, monitoring, reporting, safe-to-close
created: 2026-07-06
updated: 2026-07-06
---
WHEN: When you have completed reading memory usage, listing top processes by RAM, and categorizing them, and need to compile a concise findings report
STEPS:
1. Identify the top 3-5 memory consumers from the process list, noting each process's name, PID, and RAM usage
2. Label each process as either 'user app (safe to close)' or 'system-critical (must stay)' based on earlier categorization step
3. Formulate a clear recommendation: list which specific user apps can safely be closed to recover memory, with estimated RAM that would be freed
4. Write the report in a concise format, for example: 'Top memory consumers: 1) Chrome (PID 1234, 2.1 GB) - user app, safe to close. 2) ... Recommendation: Close Chrome and Slack to free ~3.0 GB.'
5. Do NOT take any action to close processes; output only the report text
