---
title: List top processes by RSS
slug: list-top-processes-by-rss
uses: 2
proven: false
tags: memory, processes, troubleshooting
created: 2026-07-07
updated: 2026-07-07
---
WHEN: Need to find which processes are consuming the most physical RAM
STEPS:
1. Run sys_ops with operation='ps aux --sort=-%mem | head -10' on Linux
2. If Linux fails, try sys_ops with operation='processes' and parameters for sorting by memory
3. If that fails, use ps_exec with 'Get-Process | Sort-Object WorkingSet64 -Descending | Select -First 10' on Windows
4. If all above fail on this system, try sys_ops with various argument formats: {'args':{'type':'processes'}}, {'args':''}, or {'action':'processes'}
5. On failure, attempt sys_ops with operation='processes' and sort='memory', limit=10
