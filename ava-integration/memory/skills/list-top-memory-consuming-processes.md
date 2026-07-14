---
title: List top memory-consuming processes
slug: list-top-memory-consuming-processes
uses: 1
proven: false
tags: sys_ops, process monitoring, memory analysis, diagnostics
created: 2026-07-06
updated: 2026-07-06
---
WHEN: You need to identify which processes are using the most RAM on a system
STEPS:
1. Use the sys_ops tool with the action parameter set to 'processes', sort by memory, and limit the result to 10 processes
2. Capture the PID, process name, and resident memory (RSS) from the output for each heavy process
