---
title: Report top memory consumers with recovery recommendations
slug: report-top-memory-consumers-with-recovery-recommendations
uses: 1
proven: false
tags: memory, report, recommendation, read-only
created: 2026-07-02
updated: 2026-07-02
---
WHEN: when you've completed memory analysis and need to produce a final finding for the user
STEPS:
1. Compile the top 3-5 processes by RSS from the classified memory data
2. For each process, list its name and RSS in MB or GB
3. Separate processes into safe-to-close (user apps like browsers, editors) vs. system-critical (kernel, drivers, services)
4. Identify which specific safe-to-close apps would recover the most memory if closed
5. Write a concise report with: top processes with RAM usage, and a clear recommendation listing app names to close
