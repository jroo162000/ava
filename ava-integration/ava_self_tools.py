"""AVA Self-Awareness Tools

These tools allow AVA to be aware of her own code and modify it with user permission.
"""

import os
import json
from typing import Any, Dict
from cmpuse.tool_registry import Tool, register
import requests

# Self-code access tool
def _plan_read_self_code(args: Dict[str, Any]) -> Dict[str, Any]:
    """Plan self-code reading operation"""
    action = args.get("action", "list")
    file_path = args.get("file_path", "")
    return {
        "preview": f"Read AVA's code: {action} {file_path}",
        "args": args
    }

def _run_read_self_code(args: Dict[str, Any], dry_run: bool) -> Dict[str, Any]:
    """Read AVA's own source code for self-awareness"""
    try:
        file_path = args.get("file_path", "")
        action = args.get("action", "list")
        
        if dry_run:
            return {
                "status": "dry-run",
                "message": f"Would perform {action} on {file_path or 'all files'}"
            }
        
        response = requests.post('http://127.0.0.1:5051/api/self/code-access', 
                                json={'file_path': file_path, 'action': action})
        data = response.json()
        
        if data['status'] == 'success':
            if action == 'list':
                return {
                    'status': 'ok',
                    'message': f"Found {len(data['code_files'])} code files",
                    'files': data['code_files']
                }
            elif action == 'read':
                return {
                    'status': 'ok',
                    'message': f"Successfully read {file_path}",
                    'file_path': file_path,
                    'content': data['content']
                }
            elif action == 'analyze':
                return {
                    'status': 'ok',
                    'message': "Code structure analyzed",
                    'analysis': data['analysis']
                }
        else:
            return {
                'status': 'error',
                'message': data.get('message', 'Failed to access code')
            }
            
    except Exception as e:
        return {
            'status': 'error',
            'message': f"Error accessing self code: {str(e)}"
        }

# Self-code modification tool
def _plan_modify_self_code(args: Dict[str, Any]) -> Dict[str, Any]:
    """Plan self-code modification operation"""
    file_path = args.get("file_path", "")
    description = args.get("description", "code modification")
    return {
        "preview": f"Modify AVA's code: {file_path} - {description}",
        "args": args
    }

def _run_modify_self_code(args: Dict[str, Any], dry_run: bool) -> Dict[str, Any]:
    """Modify AVA's own source code with user permission"""
    try:
        file_path = args.get("file_path", "")
        modification = args.get("modification", "")
        description = args.get("description", "")
        user_permission = args.get("user_permission", False)
        
        if not user_permission:
            return {
                'status': 'error',
                'message': 'User permission required for code modification. Please ask the user for explicit permission.'
            }
        
        if dry_run:
            return {
                'status': 'dry-run',
                'message': f'Would modify {file_path}: {description}'
            }
        
        response = requests.post('http://127.0.0.1:5051/api/self/modify', 
                                json={
                                    'file_path': file_path, 
                                    'modification': modification,
                                    'description': description,
                                    'user_permission': user_permission
                                })
        data = response.json()
        
        if data['status'] == 'success':
            return {
                'status': 'ok',
                'message': f"Successfully modified {file_path}: {description}",
                'backup_created': data.get('backup_created'),
                'file_path': file_path
            }
        else:
            return {
                'status': 'error',
                'message': data.get('message', 'Failed to modify code')
            }
            
    except Exception as e:
        return {
            'status': 'error',
            'message': f"Error modifying code: {str(e)}"
        }

# Continuous listening control tool
def _plan_continuous_listening(args: Dict[str, Any]) -> Dict[str, Any]:
    """Plan continuous listening control operation"""
    enabled = args.get("enabled", True)
    return {
        "preview": f"{'Enable' if enabled else 'Disable'} continuous listening",
        "args": args
    }

def _run_continuous_listening(args: Dict[str, Any], dry_run: bool) -> Dict[str, Any]:
    """Enable or disable continuous voice listening"""
    try:
        enabled = args.get("enabled", True)
        
        if dry_run:
            return {
                'status': 'dry-run',
                'message': f"Would {'enable' if enabled else 'disable'} continuous listening"
            }
        
        response = requests.post('http://127.0.0.1:5051/api/voice/continuous', 
                                json={'enabled': enabled})
        data = response.json()
        
        if data['status'] == 'success':
            return {
                'status': 'ok',
                'message': data['message']
            }
        else:
            return {
                'status': 'error', 
                'message': data.get('message', 'Failed to configure continuous listening')
            }
            
    except Exception as e:
        return {
            'status': 'error',
            'message': f"Error configuring continuous listening: {str(e)}"
        }

# Register the tools
READ_SELF_CODE_TOOL = Tool(
    name="read_self_code",
    summary="Access AVA's own source code for self-awareness",
    plan=_plan_read_self_code,
    run=_run_read_self_code,
    permissions={"requires_network": True}
)

MODIFY_SELF_CODE_TOOL = Tool(
    name="modify_self_code", 
    summary="Modify AVA's own source code with user permission",
    plan=_plan_modify_self_code,
    run=_run_modify_self_code,
    permissions={"destructive": True, "requires_permission": True, "requires_network": True}
)

CONTINUOUS_LISTENING_TOOL = Tool(
    name="enable_continuous_listening",
    summary="Enable or disable continuous voice listening",
    plan=_plan_continuous_listening,
    run=_run_continuous_listening,
    permissions={"requires_network": True}
)

# Register all tools
register(READ_SELF_CODE_TOOL)
register(MODIFY_SELF_CODE_TOOL)  
register(CONTINUOUS_LISTENING_TOOL)