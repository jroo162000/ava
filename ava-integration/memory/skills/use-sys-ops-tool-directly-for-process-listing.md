---
title: Use sys_ops tool directly for process listing
slug: use-sys-ops-tool-directly-for-process-listing
uses: 1
proven: false
tags: sys_ops, process listing, memory, troubleshooting
created: 2026-07-07
updated: 2026-07-07
---
WHEN: When you need to list processes sorted by memory on a system equipped with the sys_ops tool
STEPS:
1. Call sys_ops with the action 'processes' and the sort parameter 'memory' (e.g., {action: "processes", sort: "memory"})
2. Avoid invoking raw shell commands like 'ps aux'; rely on the tool's native parameters for consistent results
3. If the first attempt fails or produces unexpected output, retry with adjusted parameters before trying alternative commands
