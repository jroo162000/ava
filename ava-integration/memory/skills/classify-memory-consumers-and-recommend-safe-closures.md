---
title: Classify memory consumers and recommend safe closures
slug: classify-memory-consumers-and-recommend-safe-closures
uses: 1
proven: false
tags: memory optimization, user apps, system processes
created: 2026-07-06
updated: 2026-07-06
---
WHEN: After retrieving memory usage data, to prioritize which user apps can be safely closed
STEPS:
1. Read the memory usage data from the previous step.
2. Filter the top 3-5 memory-consuming processes.
3. For each process, classify it as either 'user app (safe to close)' (e.g., browser, office suite, media player) or 'system-critical (keep running)' (e.g., kernel, system services, drivers).
4. Record each process with its RAM usage in MB/GB, classification, and a specific recommendation (e.g., 'Close Chrome to free ~500MB').
5. Do NOT close any process — only produce the finding as a concise statement.
