---
title: Compile memory-pressure findings report
slug: compile-memory-pressure-findings-report
uses: 1
proven: false
tags: memory-pressure, process-investigation, reporting, memory-forensics
created: 2026-07-05
updated: 2026-07-05
---
WHEN: after reading memory usage and listing top processes in a memory-pressure investigation
STEPS:
1. List the top 3–5 processes by resident RAM (read from sys_ops memory detail output).
2. For each process, note its PID, name, and exact RAM (e.g., 420 MB, 1.2 GB).
3. Classify each as 'user app' (safe to close) or 'system-critical' (must stay): browser and Electron apps → user app; kernel, systemd, daemons, database servers → system-critical.
4. Format the final report as: 'Top memory consumers: [list with app name, RAM, classification]. Recommendation: To recover memory, close [specific user-app names], which are safe to close.'
5. Do NOT close any process or suggest any action beyond reporting.
