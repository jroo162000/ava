---
title: Read current memory usage
slug: read-current-memory-usage
uses: 1
proven: false
tags: memory, monitoring, system-info, stage-1
created: 2026-07-06
updated: 2026-07-06
---
WHEN: When you need to get an overview of system memory consumption and pressure
STEPS:
1. Call sys_ops with action='memory' to retrieve total, used, free, and swap memory statistics along with memory pressure indicators.
2. Parse the output to identify current memory usage totals, available memory, and swap usage.
3. Record or summarize the results for use in the next stage.
