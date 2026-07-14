---
title: Analyze top memory consumers from process list
slug: analyze-top-memory-consumers-from-process-list
uses: 1
proven: false
tags: memory-analysis, performance-tuning, process-monitoring
created: 2026-07-05
updated: 2026-07-05
---
WHEN: need to identify heaviest RAM-using processes for memory optimization
STEPS:
1. Retrieve process list sorted by memory usage
2. Select top 3-5 processes based on RAM consumption
3. For each selected process, note PID, process name, and memory amount
4. Determine if each process is a user app (safe to close) or system-critical (must keep)
5. Produce a concise finding with the top consumers and clear recommendations
