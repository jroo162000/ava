# AVA Client (Vite + React)

AVA is an Ambient Voice Assistant UI that connects to a local backend proxy and Realtime model.

## Run

1) Backend (GA proxy + memory + traces)

```
cd ../ava-server
npm install
set OPENAI_API_KEY=sk-...   # PowerShell: $env:OPENAI_API_KEY="sk-..."
npm start
```

The server exposes:
- `GET /session` health + model
- `WS /realtime/ws` proxy to GA Realtime
- `POST /memory/upsert`, `POST /memory/search`, `GET /persona`
- `POST /trace` (JSONL traces)
- `POST /policy/tool-select` (NB or rule-based hints)
- `POST /policy/train` (train Naive Bayes tool selector from traces)

Embeddings:
- Set `EMBED_PROVIDER=openai` and `EMBED_MODEL=text-embedding-3-small` to use OpenAI embeddings; otherwise a local hashed-BOW embedding is used.

2) Frontend

```
cd ../ava-client
npm install
npm run dev
```

Set `VITE_AVA_SERVER_URL` in `.env` (defaults to `http://localhost:8080`).

## Features

- Realtime WS chat and voice (VAD with barge-in)
- Personalization (local or server): retrieves context and persona and appends to prompts
- Tool logs with call/result
- Feedback: thumbs up/down on bot replies (influences persona)
- Optional tool-hints (server recommends likely tools)
- Wake-word stub toggle (to integrate on-device detector like Porcupine)
