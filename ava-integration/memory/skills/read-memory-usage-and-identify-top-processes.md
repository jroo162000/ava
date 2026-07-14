---
title: Read memory usage and identify top processes
slug: read-memory-usage-and-identify-top-processes
uses: 1
proven: false
tags: memory, investigation, processes, sys_ops
created: 2026-07-06
updated: 2026-07-06
---
WHEN: investigating memory pressure without making changes
STEPS:
1. Call sys_ops with 'memory' operation to get total, used, and free memory along with memory pressure state
2. Call sys_ops with 'processes' or detailed memory command to list top processes by RAM consumption
3. Review output to identify the top 3-5 memory consumers
