---
title: Write a concise memory-pressure remediation report
slug: write-a-concise-memory-pressure-remediation-report
uses: 1
proven: false
tags: memory-pressure, report-writing, system-monitoring, readonly, sys_ops
created: 2026-07-02
updated: 2026-07-02
---
WHEN: when you need to finalize a read-only memory investigation by producing a clear, actionable summary with process categories and safe-close recommendations
STEPS:
1. Review the already-collected data: current memory usage percentage, top processes with RAM amounts, and process categories (user app vs system-critical)
2. Select the top 3-5 memory consumers by RAM usage
3. Create a section header: 'Top Memory Consumers'
4. For each selected process, list: process name, RAM usage (e.g., in MB or percentage), and category label ('User app' or 'System-critical')
5. Create a section header: 'Recommendations'
6. List each user app that is safe to close, stating its expected memory recovery and that it is a non-essential application
7. Explicitly state that system-critical processes should not be touched
8. Add a final note: 'No actions have been taken; this is a read-only assessment.'
9. Output the report in plain text, no formatting beyond simple line breaks
