# AVA Bridge - Local Secure Control Server
# -----------------------------------------
# Run:
#   pip install fastapi uvicorn pyttsx3 pyautogui pillow pyperclip
#   set AVA_BRIDGE_TOKEN=your_token_here   (or set in secrets.json)
#   python -m uvicorn ava_bridge:app --host 127.0.0.1 --port 3333
#
# Or simply: python ava_bridge.py

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi import WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import os
import sys
import subprocess
import json
import base64
import time
from typing import Optional, List
from pathlib import Path

# Load token from environment or secrets.json
def load_token():
    # Try environment first
    token = os.environ.get("AVA_BRIDGE_TOKEN") or os.environ.get("BRIDGE_TOKEN")
    if token and token != "CHANGE_ME":
        return token
    
    # Try secrets.json
    secrets_path = Path.home() / ".cmpuse" / "secrets.json"
    if secrets_path.exists():
        try:
            with open(secrets_path) as f:
                secrets = json.load(f)
                token = secrets.get("AVA_BRIDGE_TOKEN") or secrets.get("BRIDGE_TOKEN")
                if token:
                    return token
        except:
            pass
    
    # Default (insecure - for local dev only)
    print("[WARNING] No BRIDGE_TOKEN set. Using default token (insecure!)")
    return "local-dev-token"

BRIDGE_TOKEN = load_token()
HOST = os.environ.get("BRIDGE_HOST", "127.0.0.1")
PORT = int(os.environ.get("BRIDGE_PORT", "3333"))

app = FastAPI(
    title="AVA Local Bridge",
    description="Secure local bridge for AVA to control this machine",
    version="2.0.0",
)

# CORS for local development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:5051", "http://127.0.0.1:5051"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ========== Request Models ==========

class OpenRequest(BaseModel):
    target: str  # File, folder, app, or URL
    args: Optional[List[str]] = None

class RunRequest(BaseModel):
    command: str
    cwd: Optional[str] = None
    timeout: Optional[int] = 30

class SpeakRequest(BaseModel):
    text: str
    rate: Optional[int] = 150
    voice: Optional[str] = None

class TypeRequest(BaseModel):
    text: str
    interval: Optional[float] = 0.0

class KeypressRequest(BaseModel):
    keys: str  # e.g., "ctrl+c", "enter", "alt+tab"

class ClipboardRequest(BaseModel):
    text: Optional[str] = None  # If provided, sets clipboard; otherwise gets

class ToolRequest(BaseModel):
    tool: str  # Tool name: camera_ops, vision_ops, calendar_ops, etc.
    args: dict = {}  # Tool arguments

# ========== Auth ==========

def auth_check(auth: Optional[str], x_ava_token: Optional[str] = None):
    """Validate bearer token or X-AVA-Token header"""
    token = None
    if auth and auth.startswith("Bearer "):
        token = auth.split(" ", 1)[1]
    elif x_ava_token:
        token = x_ava_token
    
    if not token or token != BRIDGE_TOKEN:
        raise HTTPException(status_code=401, detail="Unauthorized - invalid or missing token")

# ========== Endpoints ==========

@app.get("/health")
def health():
    """Health check - no auth required"""
    return {"ok": True, "status": "running", "port": PORT}

@app.get("/status")
def status():
    """Bridge status - no auth required"""
    return {
        "ok": True,
        "version": "2.0.0",
        "host": HOST,
        "port": PORT,
        "platform": sys.platform,
        "python": sys.version.split()[0]
    }

@app.post("/open")
def open_target(req: OpenRequest, authorization: Optional[str] = Header(None), x_ava_token: Optional[str] = Header(None)):
    """Open a file, folder, application, or URL"""
    auth_check(authorization, x_ava_token)
    
    target = req.target.strip()
    if not target:
        raise HTTPException(status_code=400, detail="target is required")
    
    try:
        if sys.platform == "win32":
            # Windows: use start command
            if req.args:
                subprocess.Popen(["start", "", target] + req.args, shell=True)
            else:
                os.startfile(target)
        elif sys.platform == "darwin":
            # macOS: use open command
            cmd = ["open", target] + (req.args or [])
            subprocess.Popen(cmd)
        else:
            # Linux: use xdg-open
            subprocess.Popen(["xdg-open", target])
        
        return {"ok": True, "opened": target}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/run")
def run_command(req: RunRequest, authorization: Optional[str] = Header(None), x_ava_token: Optional[str] = Header(None)):
    """Execute a shell command"""
    auth_check(authorization, x_ava_token)
    
    try:
        result = subprocess.run(
            req.command,
            shell=True,
            cwd=req.cwd,
            capture_output=True,
            text=True,
            timeout=req.timeout or 30,
        )
        return {
            "ok": True,
            "returncode": result.returncode,
            "stdout": result.stdout,
            "stderr": result.stderr,
        }
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="Command timed out")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/exec")
def exec_cmd(req: RunRequest, authorization: Optional[str] = Header(None), x_ava_token: Optional[str] = Header(None)):
    """Alias for /run (backward compatibility)"""
    return run_command(req, authorization, x_ava_token)

@app.post("/speak")
def speak_text(req: SpeakRequest, authorization: Optional[str] = Header(None), x_ava_token: Optional[str] = Header(None)):
    """Text-to-speech using pyttsx3"""
    auth_check(authorization, x_ava_token)
    
    try:
        import pyttsx3
        engine = pyttsx3.init()
        engine.setProperty('rate', req.rate or 150)
        if req.voice:
            voices = engine.getProperty('voices')
            for v in voices:
                if req.voice.lower() in v.name.lower():
                    engine.setProperty('voice', v.id)
                    break
        engine.say(req.text)
        engine.runAndWait()
        return {"ok": True, "spoken": req.text[:50] + "..." if len(req.text) > 50 else req.text}
    except ImportError:
        raise HTTPException(status_code=501, detail="pyttsx3 not installed. Run: pip install pyttsx3")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/type")
def type_text(req: TypeRequest, authorization: Optional[str] = Header(None), x_ava_token: Optional[str] = Header(None)):
    """Type text using pyautogui"""
    auth_check(authorization, x_ava_token)
    
    try:
        import pyautogui
        pyautogui.typewrite(req.text, interval=req.interval or 0.0)
        return {"ok": True, "typed": len(req.text)}
    except ImportError:
        raise HTTPException(status_code=501, detail="pyautogui not installed. Run: pip install pyautogui")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/keypress")
def press_keys(req: KeypressRequest, authorization: Optional[str] = Header(None), x_ava_token: Optional[str] = Header(None)):
    """Press keyboard keys/shortcuts using pyautogui"""
    auth_check(authorization, x_ava_token)
    
    try:
        import pyautogui
        keys = req.keys.lower().replace(" ", "")
        
        if "+" in keys:
            # Hotkey combination: ctrl+c, alt+tab, etc.
            parts = keys.split("+")
            pyautogui.hotkey(*parts)
        else:
            # Single key
            pyautogui.press(keys)
        
        return {"ok": True, "pressed": req.keys}
    except ImportError:
        raise HTTPException(status_code=501, detail="pyautogui not installed. Run: pip install pyautogui")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/screenshot")
def take_screenshot(authorization: Optional[str] = Header(None), x_ava_token: Optional[str] = Header(None)):
    """Take a screenshot, return as base64 PNG"""
    auth_check(authorization, x_ava_token)
    
    try:
        import pyautogui
        from io import BytesIO
        
        screenshot = pyautogui.screenshot()
        buffer = BytesIO()
        screenshot.save(buffer, format="PNG")
        b64 = base64.b64encode(buffer.getvalue()).decode()
        
        return {
            "ok": True,
            "width": screenshot.width,
            "height": screenshot.height,
            "format": "png",
            "data": b64
        }
    except ImportError:
        raise HTTPException(status_code=501, detail="pyautogui not installed. Run: pip install pyautogui pillow")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/clipboard")
def get_clipboard(authorization: Optional[str] = Header(None), x_ava_token: Optional[str] = Header(None)):
    """Get clipboard contents"""
    auth_check(authorization, x_ava_token)
    
    try:
        import pyperclip
        text = pyperclip.paste()
        return {"ok": True, "text": text}
    except ImportError:
        raise HTTPException(status_code=501, detail="pyperclip not installed. Run: pip install pyperclip")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/clipboard")
def set_clipboard(req: ClipboardRequest, authorization: Optional[str] = Header(None), x_ava_token: Optional[str] = Header(None)):
    """Set clipboard contents"""
    auth_check(authorization, x_ava_token)
    
    if req.text is None:
        return get_clipboard(authorization, x_ava_token)
    
    try:
        import pyperclip
        pyperclip.copy(req.text)
        return {"ok": True, "copied": len(req.text)}
    except ImportError:
        raise HTTPException(status_code=501, detail="pyperclip not installed. Run: pip install pyperclip")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ========== CMPUSE Tool Execution ==========

@app.post("/tool")
def execute_tool(req: ToolRequest, authorization: Optional[str] = Header(None), x_ava_token: Optional[str] = Header(None)):
    """Execute a CMPUSE tool directly (always return structured JSON; no 500)."""
    auth_check(authorization, x_ava_token)

    tool_name = (req.tool or '').strip()
    args = req.args or {}

    if not tool_name:
        return {"ok": False, "error": "tool name is required", "status": "error"}

    try:
        # Add cmpuse to path if not already
        cmpuse_path = Path.home() / "cmp-use"
        if str(cmpuse_path) not in sys.path:
            sys.path.insert(0, str(cmpuse_path))

        # Load secrets/API keys
        from cmpuse.secrets import load_into_env
        load_into_env()

        # Import tools to register them
        import cmpuse.tools  # noqa: F401

        # Import and execute the tool
        from cmpuse.agent_core import Agent, Plan, Step
        from cmpuse.config import Config

        # Create agent instance
        config = Config.from_env()
        agent = Agent(config)
        print(f"[bridge] Executing tool: {tool_name} with args: {args}")

        # Build and execute plan
        plan = Plan(steps=[Step(tool=tool_name, args={**args, "confirm": True})])
        results = agent.run(plan, force=True)

        if results and len(results) > 0:
            result = results[0]
            return {
                "ok": True,
                "tool": tool_name,
                "status": result.get("status", "unknown"),
                "message": result.get("message", ""),
                "data": {k: v for k, v in result.items() if k not in ["status", "message"]}
            }
        else:
            return {"ok": False, "tool": tool_name, "status": "error", "error": "No result returned"}

    except ImportError as e:
        import traceback
        traceback.print_exc()
        return {"ok": False, "tool": tool_name, "status": "error", "error": f"CMPUSE not available: {e}"}
    except Exception as e:
        import traceback
        traceback.print_exc()
        # Always return structured JSON instead of 500
        return {"ok": False, "tool": tool_name, "status": "error", "error": str(e)}


# ========== WebSocket Event Stream for Computer Use ==========
@app.websocket("/computer_use/ws")
async def computer_use_ws(ws: WebSocket):
    await ws.accept()
    await ws.send_json({"event": "ready", "ts": int(time.time()*1000)})
    try:
        # Prepare environment (tools registration)
        cmpuse_path = Path.home() / "cmp-use"
        if str(cmpuse_path) not in sys.path:
            sys.path.insert(0, str(cmpuse_path))
        from cmpuse.secrets import load_into_env
        load_into_env()
        import cmpuse.tools  # noqa: F401
        from cmpuse.agent_core import Agent, Plan, Step
        from cmpuse.config import Config
        agent = Agent(Config.from_env())

        while True:
            msg = await ws.receive_json()
            # Expected: { tool: 'computer_use', args: {...} }
            tool = (msg.get('tool') or 'computer_use').strip()
            args = msg.get('args') or {}
            await ws.send_json({"event": "started", "tool": tool, "args": args, "ts": int(time.time()*1000)})
            try:
                plan = Plan(steps=[Step(tool=tool, args={**args, 'confirm': True})])
                results = agent.run(plan, force=True)
                res = results[0] if results else {"status": "error", "message": "no_result"}
                await ws.send_json({"event": "result", "tool": tool, "result": res, "ts": int(time.time()*1000)})
            except Exception as e:
                await ws.send_json({"event": "error", "tool": tool, "error": str(e), "ts": int(time.time()*1000)})
    except WebSocketDisconnect:
        return
    except Exception as e:
        try:
            await ws.send_json({"event": "fatal", "error": str(e), "ts": int(time.time()*1000)})
        except Exception:
            pass


# ========== Simple Client (optional UI) ==========
CLIENT_HTML = """
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>AVA Computer Use</title>
    <style>
      body { font-family: sans-serif; padding: 12px; }
      #log { height: 300px; overflow: auto; border: 1px solid #ccc; padding: 6px; }
      button { margin-right: 8px; }
      input[type=text] { width: 300px; }
    </style>
  </head>
  <body>
    <h3>AVA Computer Use</h3>
    <div>
      <button onclick="connect()">Connect</button>
      <button onclick="disconnect()">Disconnect</button>
      <button onclick="pause()">Pause</button>
      <button onclick="resume()">Resume</button>
      <button onclick="stop()">Stop</button>
    </div>
    <div style="margin-top:8px;">
      <input id="json" type="text" value='{"tool":"computer_use","args":{"action":"focus_window","title":"Notepad"}}' />
      <button onclick="sendJson()">Send</button>
    </div>
    <pre id="log"></pre>
    <script>
      let ws;
      function log(m){ const el=document.getElementById('log'); el.textContent += m+"\n"; el.scrollTop = el.scrollHeight; }
      function connect(){ if(ws){ ws.close(); } ws = new WebSocket("ws://" + location.host + "/computer_use/ws"); ws.onopen=()=>log('[ws] open'); ws.onclose=()=>log('[ws] closed'); ws.onmessage=(ev)=>log('[ws] '+ev.data); }
      function disconnect(){ if(ws){ ws.close(); ws=null; } }
      function sendJson(){ if(!ws){ log('connect first'); return; } try{ ws.send(document.getElementById('json').value); }catch(e){ log('send error: '+e); } }
      async function post(path, body){ const r = await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); const j = await r.json().catch(()=>({})); log('[post] '+JSON.stringify(j)); }
      function pause(){ post('/computer_use/control', { pause:true }); }
      function resume(){ post('/computer_use/control', { pause:false }); }
      function stop(){ post('/computer_use/control', { stop:true }); }
    </script>
  </body>
  </html>
"""

@app.get("/computer_use/client")
def computer_use_client():
    return HTMLResponse(CLIENT_HTML)

@app.post("/computer_use/control")
def computer_use_control(body: dict):
    try:
        # Route to tool module to set control flags
        cmpuse_path = Path.home() / "cmp-use"
        if str(cmpuse_path) not in sys.path:
            sys.path.insert(0, str(cmpuse_path))
        import cmpuse.tools.computer_use as cu
        if 'pause' in body:
            cu.set_pause(bool(body['pause']))
        if 'stop' in body:
            cu.set_stop(bool(body['stop']))
        return {"ok": True, "status": {"paused": cu.CONTROL.get('paused'), "stop": cu.CONTROL.get('stop')}}
    except Exception as e:
        return {"ok": False, "error": str(e)}

@app.get("/tools")
def list_tools(authorization: Optional[str] = Header(None), x_ava_token: Optional[str] = Header(None)):
    """List available CMPUSE tools"""
    auth_check(authorization, x_ava_token)

    try:
        tools_dir = Path.home() / "cmp-use" / "cmpuse" / "tools"
        if tools_dir.exists():
            tools = [f.stem for f in tools_dir.glob("*.py") if not f.name.startswith("__")]
            return {"ok": True, "tools": tools}
        return {"ok": False, "error": "Tools directory not found"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ========== Main ==========

if __name__ == "__main__":
    import uvicorn
    print(f"\n[BRIDGE] AVA Bridge starting on http://{HOST}:{PORT}")
    print(f"   Token configured: {'[OK]' if BRIDGE_TOKEN != 'local-dev-token' else '[WARNING] Using default (insecure)'}")
    print(f"   Endpoints: /health, /open, /run, /speak, /type, /keypress, /screenshot, /clipboard, /tool\n")
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
