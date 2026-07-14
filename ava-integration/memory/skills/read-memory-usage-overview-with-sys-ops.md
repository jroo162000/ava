---
title: Read memory usage overview with sys_ops
slug: read-memory-usage-overview-with-sys-ops
uses: 1
proven: false
tags: sys_ops, memory, diagnostics, read-only
created: 2026-07-05
updated: 2026-07-05
---
WHEN: Diagnosing memory pressure on a system using the sys_ops tool
STEPS:
1. Call sys_ops with argument 'operation':'memory' to get total, used, and available memory
2. If the tool returns structured data (e.g., free -h output), record the total, used, available, and any memory pressure indicator (e.g., swap usage or pressure level)
3. If the initial call is incomplete (no data returned), re-call sys_ops with alternative names like 'action':'memory', 'action':'processes', 'focus':'memory' until you get usable values
4. Once you have raw numbers, compute used_percent = used/total*100
5. Record a concise summary: total, used, available, used_percent, and any explicit pressure state (e.g., 'normal', 'warning', 'critical')
