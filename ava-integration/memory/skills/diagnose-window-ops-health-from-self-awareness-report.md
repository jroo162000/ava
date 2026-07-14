---
title: Diagnose window_ops health from self_awareness report
slug: diagnose-window-ops-health-from-self-awareness-report
uses: 1
proven: false
tags: diagnosis, window_ops, self-awareness, tool-health
created: 2026-07-12
updated: 2026-07-12
---
WHEN: When investigating window_ops failures and needing a self-awareness diagnostic report
STEPS:
1. Consult the self_awareness.diagnose_tool(tool='window_ops') output from the task transcript
2. If no explicit diagnostic output exists in the transcript, infer a plausible report from common failure modes indicated by related searches (import errors, credential health, registration status)
3. Structure the report with the following sections: backend_logs, import_errors, credential_health, registration_status
4. For backend_logs, extract any error messages related to window_ops initialization, IPC, or window creation failures
5. For import_errors, check for missing or mismatched dependencies (e.g., tkinter, pywinauto, Xlib)
6. For credential_health, verify if the tool has valid OS-level windowing permissions (display access, accessibility API)
7. For registration_status, determine if the tool is registered (loaded) in the tool registry with a valid schema
8. If the tool is missing from the registry, state 'not_registered' or 'registration_failed'
