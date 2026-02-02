AVA Doctor & Maintenance

Overview
- Endpoint: POST `/self/doctor`
- Purpose: Run diagnostics, generate a maintenance report, and prepare automatic patch proposals. Supports optional apply mode with tests + rollback.
- Schedule: A weekly maintenance report runs automatically at startup and then every 24h (it executes once per week based on last run state).

Usage
- Propose-only (default):
  curl -X POST http://127.0.0.1:5051/self/doctor -H "Content-Type: application/json" -d "{}"

- Apply mode (requires ALLOW_WRITE=1 and confirmation token; runs tests, rolls back on failure):
  curl -X POST http://127.0.0.1:5051/self/doctor -H "Content-Type: application/json" -d '{"mode":"apply","reason":"routine_maintenance","confirm_token":"YES_APPLY_$(date +%s)"}'

Responses
- ok: boolean
- mode: 'propose' | 'apply'
- reportPath: path to saved JSON report under `data/maintenance/reports`
- proposalsPath: path to saved proposals JSON under `data/maintenance/proposals`
- report: { summary, checks }
- proposals: { reason, proposals, generatedAt }
- applyResult: { appliedCount, rolledBack, testResults } (present in apply mode)

Notes
- ALLOW_WRITE=false (default) performs propose-only behavior and runs no destructive changes. Apply mode requires `ALLOW_WRITE=1` and a `confirm_token`.
- Patch proposals may come from the Python worker (self_mod) if available or built-in heuristics.
- Reports and proposals are stored under `data/maintenance/`.
