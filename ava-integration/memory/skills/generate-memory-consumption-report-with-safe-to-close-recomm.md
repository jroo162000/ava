---
title: Generate memory consumption report with safe-to-close recommendations
slug: generate-memory-consumption-report-with-safe-to-close-recomm
uses: 1
proven: false
tags: memory, report, safe-to-close, process, ram, recommendation
created: 2026-07-06
updated: 2026-07-06
---
WHEN: After collecting memory usage data and classifying heavy processes, to produce a final concise text report
STEPS:
1. Compile the top 3-5 memory consumers with their RAM usage in MB or GB
2. For each process, note whether it is a user app (safe to close) or system-critical (must stay)
3. Identify specific user apps that could be closed to recover memory
4. Write a short plain-text report without markdown formatting: list each process with RAM and classification, then a clear recommendation of which user apps to close
5. Output the report as a string; do not take any action on the system
