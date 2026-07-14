---
title: Classify top memory processes as user app vs system-critical
slug: classify-top-memory-processes-as-user-app-vs-system-critical
uses: 1
proven: false
tags: memory, classification, process
created: 2026-07-06
updated: 2026-07-06
---
WHEN: need to determine which high-RAM processes are safe to kill
STEPS:
1. Look at process name and owner — user-owned processes (your user) are usually user apps
2. Look at process name for known system daemons/systemd, kernel tasks, or services
3. For borderline processes, check if they have an interactive window or network service
4. Classify each process as 'user app' (safe to close) or 'system-critical' (keep running)
5. List the top 3-5 consumers with their RAM and classification
