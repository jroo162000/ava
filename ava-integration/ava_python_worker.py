"""
AVA Python Worker - Persistent subprocess for server.js
========================================================
Runs as a long-lived process, accepting JSON commands via stdin
and returning JSON responses via stdout. This eliminates the
overhead of spawning Python for each request.

Protocol:
- Input: JSON object with "cmd" field and optional params
- Output: JSON object with "ok" field and result/error
- Each message is a single line (newline-delimited JSON)
"""

import sys
import json
import os
import traceback
import inspect
from pathlib import Path
from typing import Any, Dict, List, Optional

# Add paths
home = Path.home()
integration_dir = Path(os.environ.get("AVA_INTEGRATION_DIR") or Path(__file__).resolve().parent)
cmpuse_candidates = [
    Path(os.environ["CMPUSE_DIR"]) if os.environ.get("CMPUSE_DIR") else None,
    integration_dir.parent / "cmp-use",
    home / "cmp-use",
]
sys.path.insert(0, str(integration_dir))
for candidate in cmpuse_candidates:
    if candidate and candidate.exists():
        sys.path.insert(0, str(candidate))
        break

# Import AVA modules (do this once at startup)
try:
    from ava_self_awareness import (
        introspect, who_am_i, diagnose, 
        learn_from_correction, get_prompt_context,
        get_self_awareness
    )
    SELF_AWARENESS_AVAILABLE = True
except ImportError as e:
    SELF_AWARENESS_AVAILABLE = False
    SELF_AWARENESS_ERROR = str(e)

try:
    from ava_self_modification import self_mod_tool_handler
    SELF_MOD_AVAILABLE = True
except ImportError as e:
    SELF_MOD_AVAILABLE = False
    SELF_MOD_ERROR = str(e)

try:
    # Module exposes get_passive_learning(); alias to the name the worker expects.
    from ava_passive_learning import get_passive_learning as get_passive_learning_engine
    PASSIVE_LEARNING_AVAILABLE = True
except ImportError as e:
    PASSIVE_LEARNING_AVAILABLE = False
    PASSIVE_LEARNING_ERROR = str(e)

# Import cmp-use tool registry SYNCHRONOUSLY, with the worker's stdout/stderr file
# descriptors redirected to NUL during the import.
#
# Why: cmp-use pulls in cv2 / mediapipe / tqdm etc., which print progress to fd 1/2,
# often with carriage returns and no newline. When this worker's stdout is a PIPE
# read line-by-line by the Node server, that output never forms a complete line, the
# pipe buffer fills, and the import DEADLOCKS. (It only worked standalone because
# stdout was a file.) Redirecting the fds to NUL during the import avoids the flood.
# The server waits for the "ready" line with no timeout and uses a long tool-fetch
# timeout + startup pre-warm, so a slow-but-reliable synchronous import is fine.
import os as _os_imp
tool_registry = None
cmpuse_tools = None
CMPUSE_AVAILABLE = False
CMPUSE_ERROR = ""
_devnull_fd = _os_imp.open(_os_imp.devnull, _os_imp.O_WRONLY)
_saved_out_fd = _os_imp.dup(1)
_saved_err_fd = _os_imp.dup(2)
try:
    _os_imp.dup2(_devnull_fd, 1)
    _os_imp.dup2(_devnull_fd, 2)
    try:
        from cmpuse import tool_registry as _tr
        from cmpuse import tools as _tools  # importing registers all tools
        tool_registry = _tr
        cmpuse_tools = _tools
        CMPUSE_AVAILABLE = True
    except Exception as e:
        CMPUSE_AVAILABLE = False
        CMPUSE_ERROR = str(e)
finally:
    _os_imp.dup2(_saved_out_fd, 1)
    _os_imp.dup2(_saved_err_fd, 2)
    _os_imp.close(_devnull_fd)
    _os_imp.close(_saved_out_fd)
    _os_imp.close(_saved_err_fd)

def _ensure_cmpuse(timeout=120):
    """cmp-use is imported synchronously at startup; no-op kept for call sites."""
    return CMPUSE_AVAILABLE


# ========== Tool Discovery ==========

# Risk level classification based on tool characteristics
TOOL_RISK_LEVELS = {
    # High risk - destructive or security-sensitive
    'fs_ops': 'high',
    'ps_exec': 'high',
    'sys_ops': 'high',
    'security_ops': 'high',
    'remote_ops': 'high',
    'boot_repair': 'high',
    # Medium risk - can affect system state
    'net_ops': 'medium',
    'window_ops': 'medium',
    'mouse_ops': 'medium',
    'key_ops': 'medium',
    'audio_ops': 'medium',
    'camera_ops': 'medium',
    'iot_ops': 'medium',
    'comm_ops': 'medium',
    'calendar_ops': 'medium',
    'web_automation': 'medium',
    'voice_ops': 'medium',
    # Low risk - read-only or safe operations
    'open_item': 'low',
    'screen_ops': 'low',
    'vision_ops': 'low',
    'memory_system': 'low',
    'learning_db': 'low',
    'analysis_ops': 'low',
    'json_ops': 'low',
    'layered_planner': 'low',
    'proactive_ops': 'low',
    'test_echo': 'low',  # Test tool - safe
}

# Tools that require explicit user confirmation
TOOLS_REQUIRE_CONFIRM = {
    'fs_ops',      # File operations (write/delete)
    'ps_exec',     # PowerShell execution
    'sys_ops',     # System operations
    'security_ops',
    'remote_ops',
    'boot_repair',
    'open_item',   # Opening local files/apps (not URLs)
}


def infer_json_schema(tool_name: str) -> Dict[str, Any]:
    """
    Infer JSON Schema for a tool based on its name and common patterns.
    This provides basic schemas - tools can override with explicit schemas.
    """
    # Common parameter patterns
    schemas = {
        'fs_ops': {
            'type': 'object',
            'properties': {
                'operation': {
                    'type': 'string',
                    'enum': ['read', 'write', 'list', 'copy', 'move', 'delete'],
                    'description': 'File operation to perform'
                },
                'path': {'type': 'string', 'description': 'Target file or directory path'},
                'content': {'type': 'string', 'description': 'Content to write (for write operation)'},
                'src': {'type': 'string', 'description': 'Source path (for copy/move)'},
                'dest': {'type': 'string', 'description': 'Destination path (for copy/move)'},
            },
            'required': ['path']
        },
        'open_item': {
            'type': 'object',
            'properties': {
                'target': {'type': 'string', 'description': 'URL, file path, or application name to open'},
                'confirm': {'type': 'boolean', 'description': 'Confirm opening local files/apps'}
            },
            'required': ['target']
        },
        'ps_exec': {
            'type': 'object',
            'properties': {
                'script': {'type': 'string', 'description': 'PowerShell script to execute'},
                'timeout': {'type': 'integer', 'description': 'Timeout in seconds', 'default': 30}
            },
            'required': ['script']
        },
        'screen_ops': {
            'type': 'object',
            'properties': {
                'operation': {
                    'type': 'string',
                    'enum': ['screenshot', 'get_resolution', 'list_monitors'],
                    'description': 'Screen operation to perform'
                },
                'region': {
                    'type': 'object',
                    'properties': {
                        'x': {'type': 'integer'},
                        'y': {'type': 'integer'},
                        'width': {'type': 'integer'},
                        'height': {'type': 'integer'}
                    },
                    'description': 'Region to capture (optional)'
                }
            },
            'required': ['operation']
        },
        'mouse_ops': {
            'type': 'object',
            'properties': {
                'operation': {
                    'type': 'string',
                    'enum': ['click', 'double_click', 'right_click', 'move', 'scroll', 'drag'],
                    'description': 'Mouse operation to perform'
                },
                'x': {'type': 'integer', 'description': 'X coordinate'},
                'y': {'type': 'integer', 'description': 'Y coordinate'},
                'button': {'type': 'string', 'enum': ['left', 'right', 'middle']},
                'clicks': {'type': 'integer', 'default': 1}
            },
            'required': ['operation']
        },
        'key_ops': {
            'type': 'object',
            'properties': {
                'operation': {
                    'type': 'string',
                    'enum': ['type', 'press', 'hotkey', 'hold', 'release'],
                    'description': 'Keyboard operation to perform'
                },
                'text': {'type': 'string', 'description': 'Text to type'},
                'key': {'type': 'string', 'description': 'Key to press'},
                'keys': {'type': 'array', 'items': {'type': 'string'}, 'description': 'Keys for hotkey'}
            },
            'required': ['operation']
        },
        'window_ops': {
            'type': 'object',
            'properties': {
                'operation': {
                    'type': 'string',
                    'enum': ['list', 'focus', 'minimize', 'maximize', 'restore', 'close', 'move', 'resize'],
                    'description': 'Window operation to perform'
                },
                'title': {'type': 'string', 'description': 'Window title pattern'},
                'hwnd': {'type': 'integer', 'description': 'Window handle'}
            },
            'required': ['operation']
        },
        'memory_system': {
            'type': 'object',
            'properties': {
                'operation': {
                    'type': 'string',
                    'enum': ['store', 'search', 'list', 'delete'],
                    'description': 'Memory operation to perform'
                },
                'query': {'type': 'string', 'description': 'Search query'},
                'key': {'type': 'string', 'description': 'Memory key'},
                'value': {'type': 'string', 'description': 'Value to store'}
            },
            'required': ['operation']
        },
        'voice_ops': {
            'type': 'object',
            'properties': {
                'operation': {
                    'type': 'string',
                    'enum': ['speak', 'listen', 'set_voice', 'list_voices'],
                    'description': 'Voice operation to perform'
                },
                'text': {'type': 'string', 'description': 'Text to speak'},
                'rate': {'type': 'integer', 'description': 'Speech rate (words per minute)'},
                'voice': {'type': 'string', 'description': 'Voice name to use'}
            },
            'required': ['operation']
        },
        'web_automation': {
            'type': 'object',
            'properties': {
                'operation': {
                    'type': 'string',
                    'enum': ['navigate', 'click', 'type', 'screenshot', 'get_text', 'wait'],
                    'description': 'Browser automation operation'
                },
                'url': {'type': 'string', 'description': 'URL to navigate to'},
                'selector': {'type': 'string', 'description': 'CSS selector for element'},
                'text': {'type': 'string', 'description': 'Text to type'}
            },
            'required': ['operation']
        },
        'net_ops': {
            'type': 'object',
            'properties': {
                'operation': {
                    'type': 'string',
                    'enum': ['get', 'post', 'ping', 'dns_lookup', 'port_scan'],
                    'description': 'Network operation to perform'
                },
                'url': {'type': 'string', 'description': 'URL for HTTP requests'},
                'host': {'type': 'string', 'description': 'Hostname for network operations'},
                'data': {'type': 'object', 'description': 'Data for POST requests'}
            },
            'required': ['operation']
        },
        'json_ops': {
            'type': 'object',
            'properties': {
                'operation': {
                    'type': 'string',
                    'enum': ['parse', 'stringify', 'query', 'transform'],
                    'description': 'JSON operation to perform'
                },
                'data': {'type': ['string', 'object'], 'description': 'JSON data to process'},
                'path': {'type': 'string', 'description': 'JSONPath query'}
            },
            'required': ['operation']
        },
        'analysis_ops': {
            'type': 'object',
            'properties': {
                'operation': {
                    'type': 'string',
                    'enum': ['sentiment', 'summarize', 'extract', 'classify'],
                    'description': 'Analysis operation to perform'
                },
                'text': {'type': 'string', 'description': 'Text to analyze'}
            },
            'required': ['operation', 'text']
        },
        'test_echo': {
            'type': 'object',
            'properties': {
                'message': {'type': 'string', 'description': 'Message to echo'},
                'uppercase': {'type': 'boolean', 'description': 'Convert to uppercase', 'default': False}
            },
            'required': ['message']
        }
    }
    
    # Explicit schema if we have one
    if tool_name in schemas:
        return schemas[tool_name]

    # Otherwise auto-derive the valid 'action' values straight from the tool's source
    # so the model uses real action names instead of guessing. General and
    # maintenance-free: works for every cmp-use tool that branches on an action.
    try:
        import inspect, re as _re
        tool = tool_registry.get_tool(tool_name) if tool_registry else None
        run_fn = getattr(tool, 'run', None)
        mod = inspect.getmodule(run_fn) if run_fn else None
        src = inspect.getsource(mod) if mod else ''
        actions = sorted(set(_re.findall(r'action\s*==\s*["\']([A-Za-z0-9_]+)["\']', src)))
        if actions:
            return {
                'type': 'object',
                'properties': {
                    'action': {'type': 'string', 'enum': actions,
                               'description': f'The {tool_name} action to perform'}
                },
                'required': ['action']
            }
    except Exception:
        pass

    # Generic fallback
    return {
        'type': 'object',
        'properties': {
            'args': {'type': 'object', 'description': 'Tool-specific arguments'}
        }
    }


def get_tool_definitions() -> List[Dict[str, Any]]:
    """
    Get all available tool definitions from cmp-use registry.
    Returns standardized tool definitions for LLM function calling.
    """
    tools = []
    _ensure_cmpuse()

    if not CMPUSE_AVAILABLE:
        return tools

    try:
        registry = tool_registry.list_tools()
        
        for name, tool in registry.items():
            # Build standardized tool definition
            tool_def = {
                'name': name,
                'description': tool.summary if hasattr(tool, 'summary') else f'{name} tool',
                'schema': infer_json_schema(name),
                'requires_confirm': name in TOOLS_REQUIRE_CONFIRM,
                'risk_level': TOOL_RISK_LEVELS.get(name, 'medium'),
                'source': 'cmp-use',
                'permissions': tool.permissions if hasattr(tool, 'permissions') else None
            }
            tools.append(tool_def)
            
    except Exception as e:
        print(f"Error getting tool definitions: {e}", file=sys.stderr)
    
    return tools


# ==========================================================================
# TOOL EXECUTION BOUNDARY ARCHITECTURE
# ==========================================================================
#
# The EXECUTION BOUNDARY is the Node layer (ava-server/src/services/tools.js).
# All tool execution DECISIONS are made in Node, which handles:
#   - Idempotency checking
#   - Security validation
#   - Audit logging
#
# The Python worker provides tool RUNTIME for Python-based tools.
# Node calls execute_tool AFTER making the execution decision.
#
# IMPORTANT: Python components (voice runner, bridge, etc.) must NEVER call
# execute_tool directly - they must route through Node /tools/:name/execute.
# The execute_tool command here is an internal implementation detail called
# ONLY by the Node boundary layer after it has validated the request.
# ==========================================================================

def execute_tool(name: str, args: Dict[str, Any], dry_run: bool = False) -> Dict[str, Any]:
    """Execute a tool by name with given arguments.

    INTERNAL: This is called by Node boundary layer AFTER validation.
    Python components must NOT call this directly - use Node /tools/:name/execute.
    """
    _ensure_cmpuse()
    if not CMPUSE_AVAILABLE:
        return {'status': 'error', 'message': f'cmp-use not available: {CMPUSE_ERROR}'}

    tool = tool_registry.get_tool(name)
    if not tool:
        return {'status': 'error', 'message': f'Tool not found: {name}'}

    try:
        result = tool.run(args, dry_run)
        return result
    except Exception as e:
        return {'status': 'error', 'message': str(e), 'traceback': traceback.format_exc()}


# ========== Command Handler ==========

def handle_command(cmd_data: dict) -> dict:
    """Process a command and return result"""
    cmd = cmd_data.get("cmd", "")
    
    try:
        # ========== Tool Discovery Commands ==========
        if cmd == "list_tools":
            tools = get_tool_definitions()
            return {"ok": True, "tools": tools, "count": len(tools)}
        
        elif cmd == "get_tool":
            name = cmd_data.get("name", "")
            if not name:
                return {"ok": False, "error": "Tool name required"}
            _ensure_cmpuse()
            if not CMPUSE_AVAILABLE:
                return {"ok": False, "error": f"cmp-use not available: {CMPUSE_ERROR}"}
            tool = tool_registry.get_tool(name)
            if not tool:
                return {"ok": False, "error": f"Tool not found: {name}"}
            tool_def = {
                'name': name,
                'description': tool.summary if hasattr(tool, 'summary') else f'{name} tool',
                'schema': infer_json_schema(name),
                'requires_confirm': name in TOOLS_REQUIRE_CONFIRM,
                'risk_level': TOOL_RISK_LEVELS.get(name, 'medium'),
                'source': 'cmp-use',
                'permissions': tool.permissions if hasattr(tool, 'permissions') else None
            }
            return {"ok": True, "tool": tool_def}
        
        elif cmd == "execute_tool":
            # INTERNAL: Called by Node boundary layer after validation
            # Python components must NOT call this directly
            name = cmd_data.get("name", "")
            args = cmd_data.get("args", {})
            dry_run = cmd_data.get("dry_run", False)
            if not name:
                return {"ok": False, "error": "Tool name required"}
            result = execute_tool(name, args, dry_run)
            return {"ok": True, "result": result}
        
        # ========== Self-awareness commands ==========
        elif cmd == "introspect":
            if not SELF_AWARENESS_AVAILABLE:
                return {"ok": False, "error": f"Self-awareness not available: {SELF_AWARENESS_ERROR}"}
            return {"ok": True, "result": introspect()}
        
        elif cmd == "describe":
            if not SELF_AWARENESS_AVAILABLE:
                return {"ok": False, "error": f"Self-awareness not available: {SELF_AWARENESS_ERROR}"}
            return {"ok": True, "result": who_am_i()}
        
        elif cmd == "diagnose":
            if not SELF_AWARENESS_AVAILABLE:
                return {"ok": False, "error": f"Self-awareness not available: {SELF_AWARENESS_ERROR}"}
            return {"ok": True, "result": diagnose()}
        
        elif cmd == "learn_correction":
            if not SELF_AWARENESS_AVAILABLE:
                return {"ok": False, "error": f"Self-awareness not available: {SELF_AWARENESS_ERROR}"}
            user_input = cmd_data.get("user_input", "")
            wrong = cmd_data.get("wrong", "")
            correct = cmd_data.get("correct", "")
            context = cmd_data.get("context", "")
            result = learn_from_correction(user_input, wrong, correct, context)
            return {"ok": True, "result": result}
        
        elif cmd == "get_prompt_context":
            if not SELF_AWARENESS_AVAILABLE:
                return {"ok": False, "error": f"Self-awareness not available: {SELF_AWARENESS_ERROR}"}
            return {"ok": True, "result": get_prompt_context()}
        
        elif cmd == "get_learned_facts":
            if not SELF_AWARENESS_AVAILABLE:
                return {"ok": False, "error": f"Self-awareness not available: {SELF_AWARENESS_ERROR}"}
            sa = get_self_awareness()
            facts = sa.get_learned_facts()
            prefs = sa.get_preferences()
            return {"ok": True, "result": {"facts": facts, "prefs": prefs}}
        
        # ========== Self-modification commands ==========
        elif cmd == "self_mod":
            if not SELF_MOD_AVAILABLE:
                return {"ok": False, "error": f"Self-modification not available: {SELF_MOD_ERROR}"}
            args = cmd_data.get("args", {})
            result = self_mod_tool_handler(args)
            return {"ok": True, "result": result}
        
        # ========== Passive learning commands ==========
        elif cmd == "store_learnings":
            if not PASSIVE_LEARNING_AVAILABLE:
                return {"ok": False, "error": f"Passive learning not available: {PASSIVE_LEARNING_ERROR}"}
            if not SELF_AWARENESS_AVAILABLE:
                return {"ok": False, "error": f"Self-awareness not available: {SELF_AWARENESS_ERROR}"}
            
            facts = cmd_data.get("facts", [])
            preferences = cmd_data.get("preferences", [])
            sa = get_self_awareness()
            
            stored_facts = 0
            stored_prefs = 0
            
            for fact in facts:
                if sa.learn_fact(fact.get("type", ""), fact.get("value", ""), 
                               fact.get("context", ""), fact.get("confidence", 0.8)):
                    stored_facts += 1
            
            for pref in preferences:
                if sa.learn_preference(pref.get("category", ""), pref.get("key", ""),
                                      pref.get("value", ""), pref.get("confidence", 0.8)):
                    stored_prefs += 1
            
            return {"ok": True, "result": {"stored_facts": stored_facts, "stored_prefs": stored_prefs}}
        
        elif cmd == "record_pattern":
            if not SELF_AWARENESS_AVAILABLE:
                return {"ok": False, "error": f"Self-awareness not available: {SELF_AWARENESS_ERROR}"}
            sa = get_self_awareness()
            pattern_type = cmd_data.get("pattern_type", "")
            pattern_data = cmd_data.get("pattern_data", "")
            result = sa.record_pattern(pattern_type, pattern_data)
            return {"ok": True, "result": result}
        
        # ========== Health check ==========
        elif cmd == "ping":
            return {"ok": True, "result": "pong", "modules": {
                "self_awareness": SELF_AWARENESS_AVAILABLE,
                "self_modification": SELF_MOD_AVAILABLE,
                "passive_learning": PASSIVE_LEARNING_AVAILABLE,
                "cmpuse": CMPUSE_AVAILABLE
            }}
        
        # Unknown command
        else:
            return {"ok": False, "error": f"Unknown command: {cmd}"}
    
    except Exception as e:
        return {"ok": False, "error": str(e), "traceback": traceback.format_exc()}


def main():
    """Main loop - read commands from stdin, write responses to stdout"""
    # cmp-use was imported synchronously above (with fds isolated), so the registry
    # is fully populated by the time we get here.
    tool_count = len(get_tool_definitions()) if CMPUSE_AVAILABLE else 0

    print(json.dumps({
        "ok": True,
        "status": "ready",
        "modules": {
            "self_awareness": SELF_AWARENESS_AVAILABLE,
            "self_modification": SELF_MOD_AVAILABLE,
            "passive_learning": PASSIVE_LEARNING_AVAILABLE,
            "cmpuse": CMPUSE_AVAILABLE
        },
        "tools_available": tool_count
    }), flush=True)

    # Background pre-warm: import the heavy Google / psutil libraries NOW so the first
    # real calendar/email/system tool call is fast (~2-5s) and finishes within the
    # voice runner's HTTP timeout, instead of paying a ~20-30s one-time import then.
    # Only warms quiet libraries (NOT cv2/mediapipe), so it won't print to stdout and
    # corrupt the JSON stdio protocol.
    def _prewarm():
        try:
            reg = tool_registry.list_tools() if CMPUSE_AVAILABLE else {}
            for _nm in ("comm_ops", "calendar_ops", "sys_ops"):
                try:
                    _t = reg.get(_nm)
                    if _t:
                        _t.run({}, True)  # dry_run=True triggers the lazy import, no real action
                except Exception:
                    pass
        except Exception:
            pass
    try:
        import threading as _threading
        _threading.Thread(target=_prewarm, daemon=True).start()
    except Exception:
        pass

    # Process commands
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        
        request_id = None
        try:
            cmd_data = json.loads(line)
            # Extract request ID if present (for async response matching)
            request_id = cmd_data.pop("_requestId", None)
            result = handle_command(cmd_data)
        except json.JSONDecodeError as e:
            result = {"ok": False, "error": f"Invalid JSON: {e}"}
        except Exception as e:
            result = {"ok": False, "error": str(e), "traceback": traceback.format_exc()}
        
        # Include request ID in response if provided
        if request_id is not None:
            result["_requestId"] = request_id
        
        # Send response (single line)
        print(json.dumps(result), flush=True)


if __name__ == "__main__":
    main()
