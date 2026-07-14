---
title: List top processes by RAM with sys_ops
slug: list-top-processes-by-ram-with-sys-ops
uses: 2
proven: false
tags: sys_ops, memory, processes, troubleshooting
created: 2026-07-02
updated: 2026-07-06
---
WHEN: when you need to identify the processes consuming the most RAM on a Linux machine
STEPS:
1. Call sys_ops tool with action='processes'
2. If that fails, try operation='processes' with sort_by='memory' and limit=10
3. If that also fails, fall back to raw command: ps aux --sort=-%mem | head -10
