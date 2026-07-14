---
title: Produce final memory pressure report
slug: produce-final-memory-pressure-report
uses: 1
proven: false
tags: memory-investigation, reporting, read-only, sys_ops
created: 2026-07-05
updated: 2026-07-05
---
WHEN: after reading memory usage and identifying top processes by RAM
STEPS:
1. Compile a concise text report listing the top 3-5 memory consumers with their RAM usage in MB or GB.
2. For each process, indicate whether it is safe to close (e.g., ordinary user apps like browsers, editors, chat clients) or must stay (system-critical: kernel, systemd, Xorg, sshd, database servers, monitoring agents).
3. Provide a clear recommendation: which specific apps could be closed to recover memory, and an estimated reclaim amount.
4. Output the report to the agent's console or log, without taking any action to close processes.
