import json
import os
import urllib.request
import urllib.error

class AvaServerClient:
  def __init__(self, base_url: str | None = None, token: str | None = None, timeout: float = 2.0):
    b = base_url or os.getenv('AVA_SERVER_URL') or 'http://127.0.0.1:5051'
    # Normalize to base (strip trailing /respond or /chat)
    if b.endswith('/respond') or b.endswith('/chat'):
      b = b.rsplit('/', 1)[0]
    self.base = b.rstrip('/')
    self.token = token or os.getenv('AVA_API_TOKEN')
    self.timeout = timeout

  def _headers(self):
    h = { 'Content-Type': 'application/json' }
    if self.token:
      h['Authorization'] = f'Bearer {self.token}'
    return h

  def _get(self, path: str):
    url = f"{self.base}{path}"
    try:
      req = urllib.request.Request(url=url, headers=self._headers(), method='GET')
      with urllib.request.urlopen(req, timeout=self.timeout) as resp:
        raw = resp.read()
        return json.loads(raw.decode('utf-8', errors='ignore'))
    except Exception:
      return None

  def _post(self, path: str, payload: dict):
    url = f"{self.base}{path}"
    try:
      data = json.dumps(payload or {}).encode('utf-8')
      req = urllib.request.Request(url=url, data=data, headers=self._headers(), method='POST')
      with urllib.request.urlopen(req, timeout=max(self.timeout, 5.0)) as resp:
        raw = resp.read()
        return json.loads(raw.decode('utf-8', errors='ignore'))
    except Exception:
      return None

  def health(self):
    return self._get('/health')

  def capabilities(self):
    return self._get('/self/capabilities')

  def explain(self):
    return self._get('/self/explain')

  def doctor(self, mode: str = 'propose', reason: str = '', confirm_token: str | None = None):
    payload = { 'mode': mode, 'reason': reason }
    if confirm_token:
      payload['confirm_token'] = confirm_token
    return self._post('/self/doctor', payload)

