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

  def execute_tool(self, tool_name: str, args: dict, confirmed: bool = True,
                   bypass_idempotency: bool = False, source: str = 'python_client'):
    """
    Execute a tool through the Node boundary layer.

    This is the ONLY sanctioned way for Python code to execute tools.
    All tool execution flows through the Node /tools/:name/execute endpoint
    which handles idempotency, security validation, and logging.

    Args:
      tool_name: Name of the tool to execute
      args: Tool arguments dictionary
      confirmed: Whether to confirm high-risk tools (default True)
      bypass_idempotency: Skip idempotency check for intentional retries
      source: Identifier for logging (default 'python_client')

    Returns:
      dict: Tool execution result from Node boundary
    """
    payload = {
      'args': args,
      'confirmed': confirmed,
      'bypassIdempotency': bypass_idempotency,
      'source': source
    }
    # Use longer timeout for tool execution (30 seconds)
    url = f"{self.base}/tools/{tool_name}/execute"
    try:
      data = json.dumps(payload).encode('utf-8')
      req = urllib.request.Request(url=url, data=data, headers=self._headers(), method='POST')
      with urllib.request.urlopen(req, timeout=30.0) as resp:
        raw = resp.read()
        return json.loads(raw.decode('utf-8', errors='ignore'))
    except urllib.error.HTTPError as e:
      try:
        body = e.read().decode('utf-8', errors='ignore')
        return json.loads(body)
      except Exception:
        return {'ok': False, 'error': f'HTTP {e.code}: {str(e)}'}
    except Exception as e:
      return {'ok': False, 'error': str(e)}

  def list_tools(self):
    """Get list of available tools from Node boundary."""
    return self._get('/tools')

