# AVA Server (ava-server)

## Overview
AVA Server is the authoritative control plane:
- Chat + LLM routing
- Agent loop orchestration (Observe → Decide → Act → Record)
- Tool registry + tool execution (Python worker authoritative)
- Memory (store/search; JIT injection into loop)
- Bridge proxy to FastAPI (optional)
- Self-diagnosis: `/self/doctor`

## Ports
- Server: http://127.0.0.1:5051
- Bridge (FastAPI): http://127.0.0.1:3333 (proxied via `/bridge/*`)
- Client (Vite): http://localhost:5173

## Quick Start
```
npm install
npm start
```

## Environment
Copy `.env.example` to `.env` and fill values. Secrets may also be read from `~/.cmpuse/secrets.json`.

Key vars:
- `HOST` (default `0.0.0.0`)
- `PORT` (default `5051`)
- `ALLOW_WRITE` (default `0`)
- `AVA_API_TOKEN` (bearer token for proxy)
- `BRIDGE_HOST`/`BRIDGE_PORT`/`AVA_BRIDGE_TOKEN`
- LLM keys: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `GROQ_API_KEY`

Production note: plaintext key file loading is disabled; use env or `~/.cmpuse/secrets.json`.

## Key Endpoints
- Health/Monitoring: `GET /health`, `GET /metrics`, `GET /stats`, `GET /live`, `GET /ready`
- Chat/Agent: `POST /chat`, `POST /respond`, `POST /agent/run`
- Memory: `GET /memory/stats`, `POST /memory/store`, `POST /memory/search`, `POST /memory/learn/*`
- Tools: `GET /tools`, `GET /tools/:name`, `POST /tools/:name/execute`
- Bridge (proxy): `GET /bridge/health`, `GET /bridge/status`, `POST /bridge/*`
- Self: `GET /self/describe`, `GET /self/diagnose`, `POST /self/doctor`

## Guardrails
- `ALLOW_WRITE=0` by default; write/destructive operations require explicit confirmation and/or tokens.
- High-risk tools require confirmation (`confirmed: true`) server-side.
- Path traversal protections and directory allowlist enforced in Node.

## Self Doctor
- Propose: `POST /self/doctor {}` ⇒ generates report and proposals under `data/maintenance/*`
- Apply: `POST /self/doctor { "mode":"apply", "confirm_token":"YES_APPLY_<timestamp>" }`
  - Requires `ALLOW_WRITE=1`
  - Runs tests and rolls back on failure

## Tests
```
npm test
```

