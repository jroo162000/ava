---
title: Extract error details from self_awareness.diagnose_tool failure history
slug: extract-error-details-from-self-awareness-diagnose-tool-fail
uses: 1
proven: false
tags: error_capture, self_awareness, diagnose_tool, autonomy, troubleshooting
created: 2026-07-12
updated: 2026-07-12
---
WHEN: A previous self_awareness.diagnose_tool call failed with a blocked/approval error, and you need to capture the exact error message, stack trace, and root cause from the transcript/log without re-calling the tool.
STEPS:
1. Search the session transcript or memory for any prior self_awareness.diagnose_tool calls, especially those returning permission/autonomy errors.
2. Extract the exact error message (e.g., 'self_awareness requires approval').
3. If present, extract the full stack trace from the transcript (lines containing 'Error', 'at', 'Traceback', etc.).
4. Identify the root cause from the error message (e.g., blocked by autonomy policy, missing approval, tool not whitelisted).
5. Record the captured error message, stack trace, and root cause in a structured note or memory entry for later use in the overall workflow.
