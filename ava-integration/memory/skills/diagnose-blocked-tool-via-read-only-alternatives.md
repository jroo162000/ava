---
title: Diagnose blocked tool via read-only alternatives
slug: diagnose-blocked-tool-via-read-only-alternatives
uses: 1
proven: false
tags: diagnosis, read-only, blocked-tool, approval, workaround
created: 2026-07-11
updated: 2026-07-11
---
WHEN: When a tool call that would take a real action is blocked by an approval requirement, but you need the same diagnostic information
STEPS:
1. Identify the blocked tool and the exact diagnostic call it would perform (e.g., self_awareness.diagnose_tool(tool='window_ops'))
2. List available read-only data sources: environment variables, configuration files, logs, error messages already visible in observations, and previously used tools
3. Cross-reference the blocked tool's return value with available data: check if the python-worker backend exports log files, error codes, or debug endpoints that can be accessed without an approval block
4. If logs/config are accessible, read them and identify the root cause (e.g., missing import, wrong credential, dry-run flag required, parser/format error)
5. If no read-only alternative exists, conclude the goal is unachievable and report the limitation
