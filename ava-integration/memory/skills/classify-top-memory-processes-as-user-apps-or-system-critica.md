---
title: Classify top memory processes as user apps or system-critical
slug: classify-top-memory-processes-as-user-apps-or-system-critica
uses: 1
proven: false
tags: memory, performance, troubleshooting, Linux
created: 2026-07-03
updated: 2026-07-03
---
WHEN: when analyzing memory usage to decide which processes can safely be closed
STEPS:
1. Retrieve the list of top 5 processes by RAM consumption from prior steps.
2. For each process, determine if it is a common user application (e.g., browser, media player, office suite) or a system-critical process (e.g., kernel, systemd, desktop environment components like gnome-shell, Xorg).
3. Provide a brief reason for the classification: user apps are safe to close; system-critical processes must stay.
4. Document the top 3-5 memory consumers with RAM usage, specifying which are recommended for closure.
