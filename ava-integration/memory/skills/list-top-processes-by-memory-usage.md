---
title: List top processes by memory usage
slug: list-top-processes-by-memory-usage
uses: 2
proven: false
tags: memory, processes, sys_ops, troubleshooting
created: 2026-07-05
updated: 2026-07-08
---
WHEN: Need to identify heaviest memory consumers (PID, name, RSS) for troubleshooting
STEPS:
1. Call sys_ops with action='processes' and optionally sort='rss' or limit 5-10
2. Capture PID, process name, and RSS (resident set size) in megabytes or kilobytes
3. Optionally pipe through 'sort -nk4' and 'head -n 10' to get top consumers
