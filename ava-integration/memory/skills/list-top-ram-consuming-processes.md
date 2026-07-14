---
title: List top RAM-consuming processes
slug: list-top-ram-consuming-processes
uses: 1
proven: false
tags: memory, processes, linux
created: 2026-07-06
updated: 2026-07-06
---
WHEN: investigating which processes are using the most memory on a Linux system
STEPS:
1. Use system operations tool to list processes sorted by memory usage
2. Filter to top 5-10 processes by capturing PID, process name, and RSS (resident set size) in MB/GB
3. Note total memory consumption for context
