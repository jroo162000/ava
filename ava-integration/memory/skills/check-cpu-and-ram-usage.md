---
title: Check CPU and RAM usage
slug: check-cpu-and-ram-usage
uses: 1
proven: false
tags: system-monitoring, diagnostics, performance-check
created: 2026-07-02
updated: 2026-07-02
---
WHEN: Need to retrieve current system resource utilization
STEPS:
1. Open terminal or command prompt
2. Run 'top -l 1 -n 0 | head -10' to get CPU and RAM usage summary
3. Also run 'vm_stat' on macOS or 'free -h' on Linux for detailed RAM info
4. Alternatively use 'sysctl hw.memsize hw.ncpu hw.physmem' for hardware specs
5. Capture the CPU load percentage and used/available memory values
6. Format results as concise text for inclusion in a summary report
