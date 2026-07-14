---
title: Create memory pressure investigation report
slug: create-memory-pressure-investigation-report
uses: 1
proven: false
tags: memory-analysis, process-classification, report-generation, system-monitoring, read-only-investigation
created: 2026-07-05
updated: 2026-07-05
---
WHEN: After collecting memory data and classifying processes, need to generate a concise finding with RAM usage, classification, and recommendations
STEPS:
1. Review the memory consumption data for all active processes
2. Identify the top 3-5 processes by RAM usage
3. For each process, determine if it is a safe-to-close user application or a system-critical process
4. Compile a concise report listing each process with its RAM amount and classification
5. Add a clear recommendation specifying which specific user apps could be closed to recover memory
6. Output the finding without taking any action to close processes
