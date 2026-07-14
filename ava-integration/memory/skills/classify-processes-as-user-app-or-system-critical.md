---
title: Classify processes as user app or system-critical
slug: classify-processes-as-user-app-or-system-critical
uses: 1
proven: false
tags: memory-management, process-analysis, sysadmin
created: 2026-07-02
updated: 2026-07-02
---
WHEN: analyzing a process list to decide which heavy memory consumers can be safely closed
STEPS:
1. Obtain the sorted process list (by RAM usage) for the top 10-15 entries.
2. For each process, identify its role from its name: common user apps include browser processes (chrome, firefox, edge, opera), editors (code, notepad++, sublime_text), media players (vlc, spotify), and office tools (winword, excel, outlook). System-critical processes include kernel-level (system, smss, csrss, wininit, services, svchost), security (MsMpEng, SecurityHealthService), and infrastructure (explorer, taskhostw, RuntimeBroker, SearchIndexer, ctfmon, dwm).
3. Mark each as 'User app' (safe to close) or 'System-critical' (must stay).
4. Compile the top 3-5 memory consumers with their RAM usage and classification.
5. Produce a clear recommendation listing which specific user apps could be closed to recover memory.
