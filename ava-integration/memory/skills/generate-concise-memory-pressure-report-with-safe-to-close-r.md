---
title: Generate concise memory pressure report with safe-to-close recommendations
slug: generate-concise-memory-pressure-report-with-safe-to-close-r
uses: 1
proven: false
tags: memory, investigation, report, process-analysis, recommendation
created: 2026-07-05
updated: 2026-07-05
---
WHEN: After gathering memory usage and top processes by RAM, produce a brief actionable finding without closing anything
STEPS:
1. Identify the top 3-5 memory consumers from process list with their RAM usage values
2. Classify each process as either a user app (e.g., browser, editor, media player) or system-critical (e.g., kernel, driver, system daemon, antivirus)
3. For user apps that are safe to close, note they can be terminated without impacting system stability; for system-critical processes, note they must stay
4. Compile a concise finding listing each process, its RAM, its classification, and a specific recommendation of which user apps to close to recover memory
5. Output the finding as a final answer; do not execute any process termination
