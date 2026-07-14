---
title: List top processes by RAM using sys_ops
slug: list-top-processes-by-ram-using-sys-ops
uses: 3
proven: true
tags: sys_ops, processes, memory, top, RAM
created: 2026-07-04
updated: 2026-07-06
---
WHEN: needing to see which processes are using the most resident memory
STEPS:
1. Call sys_ops with action='processes', sort='memory', limit=5 (or desired number)
2. The tool returns PID, name, and RAM usage for the top consumers
