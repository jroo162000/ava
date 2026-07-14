---
title: Halt and report missing environment variables
slug: halt-and-report-missing-environment-variables
uses: 1
proven: false
tags: environment-inspection, window_ops, error-detection, stage-autonomous
created: 2026-07-12
updated: 2026-07-12
---
WHEN: detecting import/credential/registration errors for window_ops
STEPS:
1. Read environment variables filtered by WINDOW_OPS_* prefix
2. Check PATH and PYTHONPATH for window_ops references
3. Log any console error messages mentioning import, credential, registration, backend, or window_ops
4. If no WINDOW_OPS_* variables found and no console errors captured, note the absence as a finding
5. Proceed only if the current stage goal is complete; do not call any diagnostic tools
