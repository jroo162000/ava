---
title: Classify top memory consumers as safe-to-close vs system-critical
slug: classify-top-memory-consumers-as-safe-to-close-vs-system-cri
uses: 1
proven: false
tags: memory-analysis, process-classification, troubleshooting
created: 2026-07-07
updated: 2026-07-07
---
WHEN: When analyzing memory pressure and needing to decide which processes to recommend closing
STEPS:
1. Retrieve the top 5 processes by RSS memory usage using sys_ops process list with sort by RSS
2. For each process, examine its name, user owner, and path to classify:
3.   - User apps (browsers, IDEs, media players, document editors): safe to close
4.   - System processes (kernel threads, systemd, Xorg, dbus, network managers, crond, sshd): must keep
5.   - Background services (Docker, printing, snapd, package managers): keep unless memory critical
6. Check user context: processes owned by regular users (uid > 1000) are typically user apps
7. Check executable path: /usr/bin/ vs /snap/ or /opt/ can help distinguish system vs user
8. Produce concise finding: list top 3-5 consumers with RAM, and clear recommendation of which user apps to close
