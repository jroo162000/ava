---
title: Extract workflow metadata from environment
slug: extract-workflow-metadata-from-environment
uses: 1
proven: false
tags: workflow, metadata, extraction, environment, diagnosis
created: 2026-07-11
updated: 2026-07-11
---
WHEN: need to find root-cause error signature for a failed workflow before making system calls
STEPS:
1. Check transcript for any step with observations containing 'wf-mrf1ixpc-qryr'
2. Look for accompanying error codes or messages in observations from tools like self_awareness, window_ops, or read_event_log
3. Identify the workflow ID string and any error/message linked to it
