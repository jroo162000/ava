---
title: Read overall system memory usage
slug: read-overall-system-memory-usage
uses: 1
proven: false
tags: sys_ops, memory, read-only
created: 2026-07-07
updated: 2026-07-07
---
WHEN: to check total, used, free, and available memory on the machine
STEPS:
1. Call sys_ops with operation 'memory'.
2. Interpret output: note line for Mem (or similar) showing total, used, free, and available (avail) values.
3. Report: total=X, used=Y, free=Z, available=W.
