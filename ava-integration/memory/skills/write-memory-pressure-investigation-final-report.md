---
title: Write memory-pressure investigation final report
slug: write-memory-pressure-investigation-final-report
uses: 1
proven: false
tags: memory-pressure, reporting, diagnostics, read-only-investigation
created: 2026-07-06
updated: 2026-07-06
---
WHEN: After collecting total memory, top processes, and process classifications in a memory-pressure investigation
STEPS:
1. Take the top memory consumers and their RAM amounts (from the 'List top memory processes' stage)
2. Take the classification of each process (safe-to-close vs. system-critical) (from the 'Classify each process' stage)
3. Compose a concise finding listing the top 3–5 memory consumers with their RAM usage and classification
4. Add a clear recommendation naming which specific apps (by process name) should be closed to recover memory
5. Output the report as plain text
