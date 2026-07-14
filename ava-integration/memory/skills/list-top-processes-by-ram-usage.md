---
title: List top processes by RAM usage
slug: list-top-processes-by-ram-usage
uses: 1
proven: false
tags: memory, troubleshooting, processes, performance
created: 2026-07-05
updated: 2026-07-05
---
WHEN: Investigating memory pressure to identify heaviest processes
STEPS:
1. Use sys_ops operation 'processes_by_ram' to get top RAM consumers (covers up to 10 entries)
2. If operation is not recognized, fall back to sys_ops operation 'processes' with args specifying top=10 and sort_by='%mem'
3. Record each process name, PID, and RSS (resident set size) in MB or GB
4. Cross-reference with known system-critical processes (kernel, systemd, database engines, web servers) to separate safe-to-close user apps
