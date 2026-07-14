---
title: Check memory usage overview
slug: check-memory-usage-overview
uses: 1
proven: false
tags: system, memory, sys_ops, monitoring
created: 2026-07-02
updated: 2026-07-02
---
WHEN: Need to quickly get total, used, free, and swap memory statistics
STEPS:
1. Call sys_ops with operation 'memory'
2. Parse the output for total, used, free, and swap values
