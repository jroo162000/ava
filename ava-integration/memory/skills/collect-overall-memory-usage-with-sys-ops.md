---
title: Collect overall memory usage with sys_ops
slug: collect-overall-memory-usage-with-sys-ops
uses: 1
proven: false
tags: memory, diagnostics, performance, sys_ops
created: 2026-07-05
updated: 2026-07-05
---
WHEN: need to read current system memory statistics
STEPS:
1. Call sys_ops tool with no specific argument to get default memory output (e.g., 'free -h' equivalent)
2. Record values: total memory, used memory, free memory, and swap usage
