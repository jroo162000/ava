---
title: Simulate window_ops tool diagnosis from workflow failure metadata
slug: simulate-window-ops-tool-diagnosis-from-workflow-failure-met
uses: 1
proven: false
tags: window_ops, diagnosis, workflow-failure, self-awareness, troubleshooting
created: 2026-07-11
updated: 2026-07-11
---
WHEN: When you need to diagnose a window_ops pipeline failure but cannot call self_awareness.diagnose_tool directly — use workflow failure metadata instead
STEPS:
1. Extract the workflow run ID from the failure event (e.g., wf-mrf1ixpc-qryr).
2. Inspect the error message from the failure context — look for critical phrases like 'Interactive authentication required' or 'access token'.
3. Examine the stack trace — identify the failing module or tool call chain (e.g., at main.py:123 in window_ops.init).
4. Check any exit codes or warnings present (e.g., exit_code=1, warnings=['token expired']).
5. Synthesize the diagnosis as a structured output: primary error description, stack trace snippet, and any warnings.
6. Return the diagnosis object with fields: error, stack_trace, warnings — mirroring the self_awareness.diagnose_tool schema.
