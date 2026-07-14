---
title: Capture memory usage snapshot with sys_ops
slug: capture-memory-usage-snapshot-with-sys-ops
uses: 1
proven: false
tags: sys_ops, memory, performance, troubleshooting
created: 2026-07-05
updated: 2026-07-05
---
WHEN: When analyzing memory pressure on a Linux system without interactive access
STEPS:
1. Call sys_ops with operation:"memory"
2. Record the output showing total, used, free, and cached memory
3. Note the raw numbers for further analysis
