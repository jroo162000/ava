---
title: List top processes by RAM consumption
slug: list-top-processes-by-ram-consumption
uses: 1
proven: false
tags: sys_ops, memory, processes, ps
created: 2026-07-04
updated: 2026-07-04
---
WHEN: When debugging memory pressure on a Linux system
STEPS:
1. Run sys_ops with operation='ps' to get process list
2. Use sort_by='memory' and limit=10 with args={'list_processes':True,'sort_by':'memory','limit':10}
3. Capture PID, process name, and resident memory size from output
