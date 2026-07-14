---
title: Read memory and top processes with sys_ops
slug: read-memory-and-top-processes-with-sys-ops
uses: 1
proven: false
tags: sys_ops, memory, diagnostics, top-processes
created: 2026-07-05
updated: 2026-07-05
---
WHEN: Collecting system memory usage and identifying top RAM consumers for diagnostic analysis
STEPS:
1. Call sys_ops with action='memory' to get total/used/free/swap summary
2. Call sys_ops with action='processes' (or memory_detail) to list top processes by RAM consumption
3. Capture the raw output from both calls for downstream investigation
