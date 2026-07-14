---
title: List top processes by RAM
slug: list-top-processes-by-ram
uses: 1
proven: false
tags: sys_ops, memory, processes, monitoring
created: 2026-07-03
updated: 2026-07-03
---
WHEN: Need to see which processes are consuming the most memory on a Linux system
STEPS:
1. Use sys_ops with the list_processes operation
2. Sort by memory
3. Set limit to 10
4. Capture PID, name, and RSS values from the output
