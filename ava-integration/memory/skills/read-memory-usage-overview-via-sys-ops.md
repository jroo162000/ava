---
title: Read memory usage overview via sys_ops
slug: read-memory-usage-overview-via-sys-ops
uses: 1
proven: false
tags: sys_ops, memory, stage-execution
created: 2026-07-07
updated: 2026-07-07
---
WHEN: When you need to gather total, used, and available RAM plus swap usage and OOM status
STEPS:
1. Call sys_ops with arguments {"args": {"operation": "memory"}} to obtain RAM totals, used/available, and swap/OOM info
2. Parse the returned data for total, used, and available RAM (e.g., in human-readable format)
3. Check for swap usage (total, used, free) and any OOM event indicators
4. Record findings concisely for the next stage
