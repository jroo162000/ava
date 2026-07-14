---
title: Read current memory usage with sys_ops
slug: read-current-memory-usage-with-sys-ops
uses: 2
proven: false
tags: sys_ops, memory, monitoring, RAM
created: 2026-07-06
updated: 2026-07-06
---
WHEN: on any Linux/macOS system to check memory pressure before troubleshooting
STEPS:
1. Call sys_ops with operation='memory' to get total, used, free RAM and swap usage.
2. If more detail is needed (e.g., buffer/cache breakdown), call sys_ops with arg1='memory_detail'.
3. Record outputs: total RAM, used RAM, available/free RAM, swap used, and any pressure indicator (e.g., free -h equivalent).
