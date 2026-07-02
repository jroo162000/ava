---
title: Check RAM usage using sys_ops tool
slug: check-ram-usage-using-sys-ops-tool
uses: 1
proven: false
tags: system, monitoring, memory, sys_ops
created: 2026-06-29
updated: 2026-06-29
---
WHEN: needing to report current memory stats on this system
STEPS:
1. Call sys_ops with action 'system_health' and confirm=true
2. Then call sys_ops with action 'memory' and confirm=true (if required)
3. Read the memory values from the tool output
