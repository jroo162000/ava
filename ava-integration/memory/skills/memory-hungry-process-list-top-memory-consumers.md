---
title: Memory-hungry process list (top memory consumers)
slug: memory-hungry-process-list-top-memory-consumers
uses: 1
proven: false
tags: sys_ops, memory, processes, ps aux, troubleshooting
created: 2026-07-07
updated: 2026-07-07
---
WHEN: A machine is under memory pressure and you need to see which processes use the most RAM
STEPS:
1. Open a terminal on the target machine
2. Run command to list processes sorted by memory consumption: 'ps aux --sort=-%mem | head -20' (captures top 10-15 processes with PID, name, %MEM, RSS)
3. Record the top 5-10 entries: PID, process name, resident memory (RSS)
4. Cross-reference RSS and %MEM against total system memory to identify heaviest consumers
