import os
import json
import asyncio
import urllib.request as ur

# Force unified mode so we don't need Deepgram/OpenAI
os.environ["VOICE_UNIFIED"] = "1"

from ava_personality import get_personality_context

from ava_standalone_realtime import StandaloneRealtimeAVA


class _DummyResp:
    def __init__(self, body=b'{"output_text":"ok"}', status=200):
        self._body = body
        self.status = status

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False


def main():
    # Monkeypatch urlopen to capture request body
    captured = {}

    def fake_urlopen(req, timeout=30, context=None):
        try:
            body = req.data or b''
            s = body.decode('utf-8', errors='ignore')
            captured['body'] = s
        except Exception as e:
            captured['body'] = f'<decode-error:{e}>'
        return _DummyResp()

    real_urlopen = ur.urlopen
    ur.urlopen = fake_urlopen

    try:
        ava = StandaloneRealtimeAVA()
        ctx_snippet = get_personality_context()[:200]
        print('[personality-context-snippet]', ctx_snippet)

        async def run_once():
            _ = await ava._ask_server_respond("Say hello")

        asyncio.run(run_once())

        body = captured.get('body', '')
        print('[request-body]', body[:400])
        try:
            j = json.loads(body)
            persona = j.get('context', {}).get('personality')
            print('[personality-present]', bool(persona), 'len=', len(persona or ''))
        except Exception as e:
            print('[parse-error]', e)

    finally:
        ur.urlopen = real_urlopen


if __name__ == '__main__':
    main()

