---
title: Produce memory-consumer findings with closure recommendations
slug: produce-memory-consumer-findings-with-closure-recommendation
uses: 1
proven: false
tags: memory-pressure, process-analysis, read-only-investigation, recommendation-reporting
created: 2026-07-07
updated: 2026-07-07
---
WHEN: After reading total memory usage, listing top processes by RAM, and classifying each as user or system, produce a concise summary.
STEPS:
1. List the top 3-5 memory-consuming processes with their RAM usage values (from the process list obtained in earlier stages).
2. Mark each process as either 'safe to close' (user app) or 'system-critical' (based on classification from earlier stage).
3. Identify which specific safe-to-close apps could be closed to free memory and include that recommendation in the output.
4. Output the final summary in a structured paragraph: top 3-5 processes with RAM, their classification, and a clear recommendation of which apps to close.
5. Do not perform any closure or system modification actions — only report findings.
