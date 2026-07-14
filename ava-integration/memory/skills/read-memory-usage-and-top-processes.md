---
title: Read memory usage and top processes
slug: read-memory-usage-and-top-processes
uses: 1
proven: false
tags: sys_ops, memory, monitoring, processes
created: 2026-07-03
updated: 2026-07-03
---
WHEN: Need to check current memory pressure and identify heavy processes
STEPS:
1. Use sys_ops tool with operation: 'memory' to get total, used, available, swap stats
2. Use sys_ops with args: {'operation': 'memory', 'detail': 'processes'} for top process list
3. If that doesn't return process details, fall back to explicit command: {'command': 'ps aux --sort=-%mem | head -15'}
4. Parse output for top 3-5 consumers with RSS/%, identify safe vs critical apps
