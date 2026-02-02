# AVA Voice Runner Archive

**Archive Date:** 2026-02-02

## Purpose

This directory contains archived voice runner implementations that have been superseded by the canonical voice runner. These files were moved here to enforce a single entrypoint architecture and prevent confusion about which runner to execute.

## Canonical Voice Runner

The ONLY voice runner that should be executed is:
```
ava_standalone_realtime.py
```

This is the production voice runtime using Deepgram Agent Voice SDK with:
- Deepgram Nova-2 ASR
- Google Gemini 2.0 Flash LLM
- Deepgram Aura-2 TTS
- Sub-second latency
- 20+ tools available via function calling

## Archived Files

The following voice runners were archived on 2026-02-02:

### 1. `ava_standalone.py`
- **Description:** Earlier standalone implementation using cmpuse Agent
- **Reason for archival:** Replaced by ava_standalone_realtime.py
- **Status:** Non-functional, depends on old cmpuse architecture

### 2. `ava_hybrid_asr.py` - **RESTORED**
- **Description:** Hybrid ASR engine combining Vosk + Whisper
- **Status:** RESTORED to main directory (2026-02-02)
- **Reason:** This is a MODULE, not a runner. The canonical runner imports `HybridASREngine` from it. Incorrectly archived.
- **Note:** `voice/providers/hybrid_asr.py` provides a DIFFERENT class (`HybridASRProvider`) for the unified voice scaffolding. Both are needed.

### 3. `avas_voice.py`
- **Description:** Early Deepgram Agent Voice implementation
- **Reason for archival:** Superseded by ava_standalone_realtime.py with full feature set
- **Status:** Incomplete implementation, missing tool integration

### 4. `avas_voice_websockets.py`
- **Description:** Minimal WebSocket-based Deepgram Agent Voice demo
- **Reason for archival:** Proof-of-concept only, lacks production features
- **Status:** Demo/test code, not production-ready

## Architecture Decision

**Why One Runner?**

Having multiple voice runners creates confusion and maintenance burden:
- Users don't know which runner to start
- Different runners have different feature sets
- Startup scripts become complex with multiple options
- Bug fixes must be replicated across multiple implementations

**Solution:** Consolidate to one canonical runner (`ava_standalone_realtime.py`) that:
- Handles all voice modes (realtime, hybrid, offline)
- Supports all TTS providers (Deepgram, Edge, Piper)
- Configurable via `ava_voice_config.json`
- Production-ready with proper error handling and logging

## Restoring Archived Files

If you need to reference or restore an archived file:

```bash
# View archived file
cat archive/ava_standalone.py

# Copy archived file back (NOT recommended)
cp archive/ava_standalone.py ./
```

**Warning:** Restoring archived runners may break the startup script and cause conflicts. Only restore for debugging or historical reference.

## References

- Canonical runner: `C:/Users/USER 1/ava-integration/ava_standalone_realtime.py`
- Voice config: `C:/Users/USER 1/ava-integration/ava_voice_config.json`
- Startup script: `C:/Users/USER 1/start_ava.ps1`
- Claude session notes: `C:/Users/CLAUDE.md`

---

*This archive was created as part of the Repository Curation effort to enforce single entrypoint architecture.*
