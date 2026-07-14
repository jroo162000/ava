---
title: Classify each top memory process
slug: classify-each-top-memory-process
uses: 1
proven: false
tags: memory analysis, process classification, troubleshooting, system administration
created: 2026-07-06
updated: 2026-07-06
---
WHEN: after retrieving a list of top memory-consuming processes
STEPS:
1. Retrieve the list of top memory-consuming processes (sort by RSS, top 5-10)
2. For each process, inspect its name (e.g., chrome, firefox, vlc, slack, code, systemd, kernel_task, launchd)
3. Categorize: if name matches a known user application (browser, media player, IDE, communication tool), label 'user app'; if name matches a system daemon, kernel thread, or macOS/Windows service, label 'system-critical'
4. If name is ambiguous, check executable path or parent process to disambiguate
5. Output a table: process name, RAM used, category (user app / system-critical)
6. Highlight user apps as safe to close to recover memory
