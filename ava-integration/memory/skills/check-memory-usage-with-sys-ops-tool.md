---
title: Check memory usage with sys_ops tool
slug: check-memory-usage-with-sys-ops-tool
uses: 1
proven: false
tags: sys_ops, memory, monitoring, diagnostics
created: 2026-07-04
updated: 2026-07-04
---
WHEN: When you need to read current overall memory usage (total, used, free, swap)
STEPS:
1. Call sys_ops with operation='memory' to get summary
2. Call sys_ops with operation='processes', sort='memory', limit=10 to get top memory consumers
