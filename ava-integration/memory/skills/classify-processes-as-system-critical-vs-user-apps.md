---
title: Classify processes as system-critical vs user apps
slug: classify-processes-as-system-critical-vs-user-apps
uses: 1
proven: false
tags: memory-analysis, process-classification, troubleshooting, memory-pressure
created: 2026-07-05
updated: 2026-07-05
---
WHEN: analyzing memory usage to decide which processes are safe to close
STEPS:
1. Look at the output from the process listing — the process name, owner, and command path indicate category
2. System-critical processes typically: owned by root, named like systemd, kernel tasks, sshd, cron, dbus, NetworkManager, etc.
3. User applications usually: owned by a non-root user, named like firefox, chrome, code, libreoffice, slack, teams, java, python, etc.
4. For each top process, note name, owner, RAM, and assign one of two tags: 'system-critical' or 'user-app'
5. If uncertain, check if the process is a child of init/systemd and has a system path (e.g., /lib/systemd/) — that's system-critical
6. Produce a brief summary: for each of the top 5-10 processes, name, RAM, owner, and classification, then a clear recommendation of which user apps could be closed
