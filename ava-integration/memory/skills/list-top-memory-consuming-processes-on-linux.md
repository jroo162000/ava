---
title: List top memory-consuming processes on Linux
slug: list-top-memory-consuming-processes-on-linux
uses: 1
proven: false
tags: linux, memory, processes, troubleshooting, ps
created: 2026-07-02
updated: 2026-07-02
---
WHEN: Need to see which processes are using the most RAM for troubleshooting memory pressure
STEPS:
1. Open a terminal
2. Run 'ps aux --sort=-%mem | head -20'
3. Capture PID, %MEM, RSS (resident set size in KB), and COMMAND columns
4. Identify the top 5-10 consumers by %MEM
