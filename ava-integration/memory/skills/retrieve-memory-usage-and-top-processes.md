---
title: Retrieve memory usage and top processes
slug: retrieve-memory-usage-and-top-processes
uses: 1
proven: false
tags: memory, monitoring, sys_ops
created: 2026-07-06
updated: 2026-07-06
---
WHEN: After restart, need to get current memory metrics
STEPS:
1. Call sys_ops with operation 'memory' to get total, used, free, and swap
2. Call sys_ops with operation 'processes', sort_by 'memory', limit 10 to get top processes by RAM
3. Combine results and produce findings
