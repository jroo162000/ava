---
title: Use sys_ops to list top processes by RAM
slug: use-sys-ops-to-list-top-processes-by-ram
uses: 1
proven: false
tags: sys_ops, memory, process listing, performance
created: 2026-07-05
updated: 2026-07-05
---
WHEN: When you need to identify which processes are using the most memory on a Linux system.
STEPS:
1. Run `ps aux --sort=-%mem` or `top -b -n1 -o %MEM` via sys_ops tool to list processes sorted by memory usage.
2. Extract the top 10 rows; note PID, %MEM, RSS, COMMAND, and USER columns.
3. Record the process name, PID, user, and memory usage in a structured format for analysis.
