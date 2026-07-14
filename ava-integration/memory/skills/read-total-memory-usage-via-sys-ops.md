---
title: Read total memory usage via sys_ops
slug: read-total-memory-usage-via-sys-ops
uses: 2
proven: false
tags: memory, sys_ops, read-only, monitoring
created: 2026-07-02
updated: 2026-07-07
---
WHEN: when you need to check overall system memory statistics without modifying anything
STEPS:
1. Call sys_ops with the 'memory' argument to retrieve total, used, available, and swap memory statistics.
2. Read and interpret the output: note total RAM, used, available, and swap usage.
3. Do not take any action beyond reading — this is a read-only investigation step.
