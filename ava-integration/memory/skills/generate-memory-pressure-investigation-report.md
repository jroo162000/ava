---
title: Generate memory pressure investigation report
slug: generate-memory-pressure-investigation-report
uses: 1
proven: false
tags: memory-investigation, report, read-only, performance
created: 2026-07-04
updated: 2026-07-04
---
WHEN: After reading memory usage and categorizing top consumers, produce a concise finding without taking action
STEPS:
1. List the top 3-5 memory consumers with their process names and RAM usage values
2. Clearly state which specific processes are ordinary user apps safe to close and which are system-critical that must stay
3. Provide a recommendation of which apps could be closed to recover memory
4. Format the output as a concise report, not a tool call or command
5. Do not include any actions such as killing or closing processes
