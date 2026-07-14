---
title: Classify top memory processes as safe or critical
slug: classify-top-memory-processes-as-safe-or-critical
uses: 1
proven: false
tags: memory, process classification, troubleshooting, safe-to-close
created: 2026-07-05
updated: 2026-07-05
---
WHEN: after collecting memory usage data and listing top memory consumers
STEPS:
1. Review each top process from the list (by name: e.g., chrome, firefox, vlc, systemd, kernel_task, mds).
2. Mark processes with names like chrome, firefox, vlc, slack, terminal, or other user apps as 'safe to close'.
3. Mark processes with names like systemd, kernel_task, mds_stores, launchd, or windowserver as 'system-critical' and must stay.
4. Produce a summary: for each of the top 3–5 memory consumers, state the process name, RAM usage, and classification plus a clear recommendation of which specific apps could be closed to recover memory.
