---
title: List top memory-hogging processes
slug: list-top-memory-hogging-processes
uses: 1
proven: false
tags: memory, process investigation, troubleshooting, sys_ops
created: 2026-07-03
updated: 2026-07-03
---
WHEN: Investigating high memory usage and need to find which processes to consider closing
STEPS:
1. Use sys_ops to list processes sorted by resident memory (RSS)
2. Capture PID, process name, RAM amount, and user for each entry
3. Limit output to top 5-10 processes
4. Save result in memory for downstream analysis and recommendation
