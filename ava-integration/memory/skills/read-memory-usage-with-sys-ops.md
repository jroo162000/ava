---
title: Read memory usage with sys_ops
slug: read-memory-usage-with-sys-ops
uses: 2
proven: false
tags: memory, sys_ops, processes, investigation
created: 2026-07-02
updated: 2026-07-05
---
WHEN: When investigating memory pressure on a Linux system
STEPS:
1. Call sys_ops with args that include both 'memory' and 'processes' details, e.g. {"args": {"action": "memory", "detail": "full", "show_processes": true}} to get total/used/free/swap RAM plus top processes sorted by memory consumption in one call.
