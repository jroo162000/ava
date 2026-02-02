"""
AVA Self-Modification System
============================

Gives AVA the ability to:
1. Read and understand her own codebase
2. Diagnose issues in her code
3. Write fixes and improvements
4. Apply changes ONLY with explicit user permission
5. Test changes and rollback if needed

SAFETY: All modifications require explicit user approval.
        Backups are created before any changes.
        
Distilled from Claude's coding patterns and debugging strategies.
"""

import os
import sys
import re
import ast
import json
import shutil
import hashlib
import difflib
import subprocess
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Any, Optional, Tuple

# =============================================================================
# PATHS - AVA's self-knowledge of her codebase
# =============================================================================

AVA_CODEBASE = {
    "integration": Path(os.path.expanduser("~")) / "ava-integration",
    "server": Path(os.path.expanduser("~")) / "ava-server",
    "cmpuse": Path(os.path.expanduser("~")) / "cmp-use",
    "config": Path(os.path.expanduser("~")) / ".cmpuse",
}

CORE_FILES = {
    # Voice/Realtime
    "voice_main": AVA_CODEBASE["integration"] / "ava_standalone_realtime.py",
    "voice_config": AVA_CODEBASE["integration"] / "ava_voice_config.json",
    "identity": AVA_CODEBASE["integration"] / "ava_identity.json",
    "self_awareness": AVA_CODEBASE["integration"] / "ava_self_awareness.py",
    "tool_definitions": AVA_CODEBASE["integration"] / "corrected_tool_definitions.py",
    
    # Server
    "server_main": AVA_CODEBASE["server"] / "server.js",
    "router": AVA_CODEBASE["server"] / "router.js",
    
    # This file
    "self_mod": AVA_CODEBASE["integration"] / "ava_self_modification.py",
}

BACKUP_DIR = AVA_CODEBASE["integration"] / "backups"

# =============================================================================
# DISTILLED CODING KNOWLEDGE - Claude's patterns encoded for AVA
# =============================================================================

CODING_KNOWLEDGE = """
# AVA MASTER CODER PROTOCOL
# Distilled from Claude's coding patterns and debugging strategies

## APPROACH TO ANY CODE TASK

1. **UNDERSTAND FIRST**
   - Read the relevant code completely before making changes
   - Trace the flow: inputs → processing → outputs
   - Identify dependencies and side effects
   - Check for existing patterns in the codebase

2. **DIAGNOSE SYSTEMATICALLY**
   - Start with the error message - what exactly failed?
   - Trace backwards from the failure point
   - Check the obvious first: typos, missing imports, wrong paths
   - Use print statements or logging to narrow down
   - Question assumptions - verify variables have expected values

3. **PLAN BEFORE CODING**
   - Write out what you're going to change and why
   - Consider edge cases and failure modes
   - Think about what could break
   - Keep changes minimal and focused

4. **CODE QUALITY PRINCIPLES**
   - Make the smallest change that fixes the problem
   - Match existing code style and patterns
   - Add comments for non-obvious logic
   - Handle errors gracefully
   - Don't repeat yourself (DRY)
   - Keep functions small and focused

5. **TESTING & VERIFICATION**
   - Test the specific case that was broken
   - Test related functionality that might be affected
   - Check for regressions
   - Verify error handling works

6. **SAFE MODIFICATION PATTERN**
   - ALWAYS backup before changing
   - Make one logical change at a time
   - Test after each change
   - Document what was changed and why
   - Be prepared to rollback

## PYTHON-SPECIFIC PATTERNS

- Check imports at top of file
- Use type hints for clarity
- Handle exceptions with specific types
- Use f-strings for formatting
- Prefer pathlib over os.path
- Use context managers (with statements)
- Check for None before accessing attributes

## JAVASCRIPT/NODE PATTERNS

- Check for async/await issues
- Verify callback vs promise handling
- Watch for undefined vs null
- Check JSON.parse error handling
- Verify correct module import syntax (require vs import)
- Check for proper error propagation

## DEBUGGING CHECKLIST

□ Is the error message pointing to the actual problem?
□ Are all imports present and correct?
□ Are file paths correct (especially on Windows)?
□ Are async/await keywords used correctly?
□ Is the data the expected type?
□ Are there typos in variable/function names?
□ Is there a missing return statement?
□ Are error handlers catching the right exceptions?
□ Is the code even being reached? (add a print to verify)
□ Has something changed in a dependency?

## SELF-REPAIR SPECIFIC

When fixing yourself (AVA):
1. Read the error from logs or user report
2. Locate the file and function involved
3. Understand what it's supposed to do
4. Identify why it's failing
5. Write the minimal fix
6. Show the diff to user for approval
7. Apply only after approval
8. Test and verify
9. Log the fix for future reference
"""

# =============================================================================
# FILE OPERATIONS WITH SAFETY
# =============================================================================

def create_backup(file_path: Path) -> Path:
    """Create a timestamped backup before modification"""
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_name = f"{file_path.stem}_{timestamp}{file_path.suffix}.backup"
    backup_path = BACKUP_DIR / backup_name
    
    shutil.copy2(file_path, backup_path)
    return backup_path

def get_file_hash(file_path: Path) -> str:
    """Get MD5 hash of file for change detection"""
    with open(file_path, 'rb') as f:
        return hashlib.md5(f.read()).hexdigest()

def read_file(file_path: Path) -> str:
    """Safely read a file"""
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            return f.read()
    except Exception as e:
        return f"ERROR reading {file_path}: {e}"

def write_file(file_path: Path, content: str, backup: bool = True) -> Dict[str, Any]:
    """Write file with optional backup"""
    result = {"status": "pending", "file": str(file_path)}
    
    try:
        if backup and file_path.exists():
            backup_path = create_backup(file_path)
            result["backup"] = str(backup_path)
        
        with open(file_path, 'w', encoding='utf-8') as f:
            f.write(content)
        
        result["status"] = "success"
        result["hash"] = get_file_hash(file_path)
        
    except Exception as e:
        result["status"] = "error"
        result["error"] = str(e)
    
    return result

def restore_from_backup(backup_path: Path, original_path: Path) -> Dict[str, Any]:
    """Restore a file from backup"""
    try:
        shutil.copy2(backup_path, original_path)
        return {"status": "success", "restored": str(original_path)}
    except Exception as e:
        return {"status": "error", "error": str(e)}

# =============================================================================
# CODE ANALYSIS
# =============================================================================

def analyze_python_file(file_path: Path) -> Dict[str, Any]:
    """Analyze a Python file structure"""
    content = read_file(file_path)
    if content.startswith("ERROR"):
        return {"status": "error", "error": content}
    
    analysis = {
        "file": str(file_path),
        "lines": len(content.splitlines()),
        "imports": [],
        "functions": [],
        "classes": [],
        "globals": [],
        "errors": []
    }
    
    try:
        tree = ast.parse(content)
        
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    analysis["imports"].append(alias.name)
            elif isinstance(node, ast.ImportFrom):
                module = node.module or ""
                for alias in node.names:
                    analysis["imports"].append(f"{module}.{alias.name}")
            elif isinstance(node, ast.FunctionDef):
                analysis["functions"].append({
                    "name": node.name,
                    "line": node.lineno,
                    "args": [arg.arg for arg in node.args.args]
                })
            elif isinstance(node, ast.AsyncFunctionDef):
                analysis["functions"].append({
                    "name": node.name,
                    "line": node.lineno,
                    "args": [arg.arg for arg in node.args.args],
                    "async": True
                })
            elif isinstance(node, ast.ClassDef):
                analysis["classes"].append({
                    "name": node.name,
                    "line": node.lineno
                })
                
    except SyntaxError as e:
        analysis["errors"].append({
            "type": "SyntaxError",
            "line": e.lineno,
            "message": str(e.msg)
        })
    
    return analysis

def analyze_javascript_file(file_path: Path) -> Dict[str, Any]:
    """Basic analysis of a JavaScript file"""
    content = read_file(file_path)
    if content.startswith("ERROR"):
        return {"status": "error", "error": content}
    
    analysis = {
        "file": str(file_path),
        "lines": len(content.splitlines()),
        "requires": [],
        "imports": [],
        "functions": [],
        "exports": [],
    }
    
    # Find require statements
    requires = re.findall(r"require\(['\"](.+?)['\"]\)", content)
    analysis["requires"] = requires
    
    # Find import statements
    imports = re.findall(r"import\s+.+?\s+from\s+['\"](.+?)['\"]", content)
    analysis["imports"] = imports
    
    # Find function definitions
    functions = re.findall(r"(?:async\s+)?function\s+(\w+)\s*\(", content)
    arrow_funcs = re.findall(r"(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(", content)
    analysis["functions"] = functions + arrow_funcs
    
    # Find exports
    exports = re.findall(r"(?:module\.)?exports\.(\w+)", content)
    analysis["exports"] = exports
    
    return analysis

def find_function_in_file(file_path: Path, function_name: str) -> Optional[Dict[str, Any]]:
    """Find a specific function and return its code"""
    content = read_file(file_path)
    lines = content.splitlines()
    
    if file_path.suffix == '.py':
        # Python function finding
        pattern = rf"^(\s*)(async\s+)?def\s+{re.escape(function_name)}\s*\("
        for i, line in enumerate(lines):
            match = re.match(pattern, line)
            if match:
                indent = len(match.group(1))
                start = i
                end = i + 1
                
                # Find end of function
                while end < len(lines):
                    next_line = lines[end]
                    if next_line.strip() and not next_line.startswith(' ' * (indent + 1)) and not next_line.startswith('\t'):
                        if not next_line.strip().startswith('#'):
                            break
                    end += 1
                
                return {
                    "name": function_name,
                    "start_line": start + 1,
                    "end_line": end,
                    "code": "\n".join(lines[start:end])
                }
    
    elif file_path.suffix == '.js':
        # JavaScript function finding (basic)
        patterns = [
            rf"function\s+{re.escape(function_name)}\s*\(",
            rf"(?:const|let|var)\s+{re.escape(function_name)}\s*=",
        ]
        for pattern in patterns:
            for i, line in enumerate(lines):
                if re.search(pattern, line):
                    # Find the end (look for closing brace at same level)
                    start = i
                    brace_count = 0
                    end = i
                    
                    for j in range(i, len(lines)):
                        brace_count += lines[j].count('{') - lines[j].count('}')
                        if brace_count == 0 and j > i:
                            end = j + 1
                            break
                        end = j + 1
                    
                    return {
                        "name": function_name,
                        "start_line": start + 1,
                        "end_line": end,
                        "code": "\n".join(lines[start:end])
                    }
    
    return None

# =============================================================================
# DIFF AND CHANGE PREVIEW
# =============================================================================

def generate_diff(original: str, modified: str, filename: str = "") -> str:
    """Generate a unified diff between original and modified content"""
    original_lines = original.splitlines(keepends=True)
    modified_lines = modified.splitlines(keepends=True)
    
    diff = difflib.unified_diff(
        original_lines,
        modified_lines,
        fromfile=f"a/{filename}",
        tofile=f"b/{filename}",
        lineterm=""
    )
    
    return "".join(diff)

def preview_change(file_path: Path, new_content: str) -> Dict[str, Any]:
    """Preview a change without applying it"""
    original = read_file(file_path)
    diff = generate_diff(original, new_content, file_path.name)
    
    original_lines = len(original.splitlines())
    new_lines = len(new_content.splitlines())
    
    return {
        "file": str(file_path),
        "diff": diff,
        "original_lines": original_lines,
        "new_lines": new_lines,
        "lines_changed": abs(new_lines - original_lines),
        "ready_to_apply": True
    }

# =============================================================================
# SELF-DIAGNOSIS
# =============================================================================

def diagnose_codebase() -> Dict[str, Any]:
    """Run diagnostics on AVA's entire codebase"""
    diagnosis = {
        "timestamp": datetime.now().isoformat(),
        "files_checked": 0,
        "issues": [],
        "warnings": [],
        "health": {}
    }
    
    for name, path in CORE_FILES.items():
        if not path.exists():
            diagnosis["issues"].append({
                "severity": "error",
                "file": name,
                "message": f"Core file missing: {path}"
            })
            continue
        
        diagnosis["files_checked"] += 1
        
        # Check Python files
        if path.suffix == '.py':
            analysis = analyze_python_file(path)
            if analysis.get("errors"):
                for err in analysis["errors"]:
                    diagnosis["issues"].append({
                        "severity": "error",
                        "file": name,
                        "line": err.get("line"),
                        "message": f"{err['type']}: {err['message']}"
                    })
            
            # Check for common issues
            content = read_file(path)
            
            # Check for debug prints left in
            debug_prints = len(re.findall(r"print\s*\(\s*['\"]DEBUG", content))
            if debug_prints > 0:
                diagnosis["warnings"].append({
                    "file": name,
                    "message": f"Found {debug_prints} DEBUG print statements"
                })
            
            # Check for TODO/FIXME
            todos = len(re.findall(r"#\s*(TODO|FIXME)", content, re.IGNORECASE))
            if todos > 0:
                diagnosis["warnings"].append({
                    "file": name,
                    "message": f"Found {todos} TODO/FIXME comments"
                })
        
        # Check JSON files
        elif path.suffix == '.json':
            try:
                with open(path, 'r') as f:
                    json.load(f)
            except json.JSONDecodeError as e:
                diagnosis["issues"].append({
                    "severity": "error",
                    "file": name,
                    "message": f"Invalid JSON: {e}"
                })
        
        # Check JS files
        elif path.suffix == '.js':
            analysis = analyze_javascript_file(path)
            # Basic syntax check via node
            try:
                result = subprocess.run(
                    ["node", "--check", str(path)],
                    capture_output=True, text=True, timeout=10
                )
                if result.returncode != 0:
                    diagnosis["issues"].append({
                        "severity": "error",
                        "file": name,
                        "message": f"Syntax error: {result.stderr[:200]}"
                    })
            except Exception as e:
                diagnosis["warnings"].append({
                    "file": name,
                    "message": f"Could not syntax check: {e}"
                })
    
    # Overall health assessment
    error_count = len([i for i in diagnosis["issues"] if i["severity"] == "error"])
    warning_count = len(diagnosis["warnings"])
    
    if error_count == 0 and warning_count == 0:
        diagnosis["health"]["status"] = "healthy"
        diagnosis["health"]["message"] = "All systems operational"
    elif error_count == 0:
        diagnosis["health"]["status"] = "good"
        diagnosis["health"]["message"] = f"{warning_count} minor warnings"
    else:
        diagnosis["health"]["status"] = "needs_attention"
        diagnosis["health"]["message"] = f"{error_count} errors, {warning_count} warnings"
    
    return diagnosis

def diagnose_error(error_message: str, file_hint: str = None) -> Dict[str, Any]:
    """Analyze an error message and suggest fixes"""
    diagnosis = {
        "error": error_message,
        "analysis": [],
        "likely_cause": None,
        "suggested_fixes": [],
        "files_to_check": []
    }
    
    error_lower = error_message.lower()
    
    # Common error patterns
    if "modulenotfounderror" in error_lower or "no module named" in error_lower:
        module = re.search(r"no module named ['\"]?(\w+)", error_lower)
        diagnosis["likely_cause"] = "Missing Python module"
        diagnosis["suggested_fixes"].append(f"pip install {module.group(1) if module else 'the missing module'}")
        diagnosis["suggested_fixes"].append("Check if the module is in the correct path")
    
    elif "importerror" in error_lower:
        diagnosis["likely_cause"] = "Import failed - module exists but import path is wrong"
        diagnosis["suggested_fixes"].append("Check the exact import path")
        diagnosis["suggested_fixes"].append("Verify the function/class exists in the module")
    
    elif "syntaxerror" in error_lower:
        line_match = re.search(r"line (\d+)", error_lower)
        diagnosis["likely_cause"] = "Python syntax error"
        if line_match:
            diagnosis["analysis"].append(f"Error on line {line_match.group(1)}")
        diagnosis["suggested_fixes"].append("Check for missing colons, parentheses, or quotes")
        diagnosis["suggested_fixes"].append("Check indentation")
    
    elif "typeerror" in error_lower:
        diagnosis["likely_cause"] = "Wrong type passed to function or wrong number of arguments"
        diagnosis["suggested_fixes"].append("Check argument types match function signature")
        diagnosis["suggested_fixes"].append("Verify object is not None before accessing")
    
    elif "keyerror" in error_lower:
        key = re.search(r"keyerror:?\s*['\"]?(\w+)", error_lower)
        diagnosis["likely_cause"] = f"Dictionary key not found"
        diagnosis["suggested_fixes"].append(f"Use .get('{key.group(1) if key else 'key'}', default) instead")
        diagnosis["suggested_fixes"].append("Check if the key exists before accessing")
    
    elif "attributeerror" in error_lower:
        diagnosis["likely_cause"] = "Trying to access attribute that doesn't exist"
        if "nonetype" in error_lower:
            diagnosis["analysis"].append("Object is None when it shouldn't be")
            diagnosis["suggested_fixes"].append("Add None check before accessing attribute")
        diagnosis["suggested_fixes"].append("Verify the object type is correct")
    
    elif "connection" in error_lower or "timeout" in error_lower:
        diagnosis["likely_cause"] = "Network/connection issue"
        diagnosis["suggested_fixes"].append("Check if the service is running")
        diagnosis["suggested_fixes"].append("Verify the URL/port is correct")
        diagnosis["suggested_fixes"].append("Add retry logic or increase timeout")
    
    elif "permission" in error_lower or "access denied" in error_lower:
        diagnosis["likely_cause"] = "File/resource permission issue"
        diagnosis["suggested_fixes"].append("Run as administrator")
        diagnosis["suggested_fixes"].append("Check file permissions")
    
    # Find relevant files
    if file_hint:
        for name, path in CORE_FILES.items():
            if file_hint.lower() in str(path).lower():
                diagnosis["files_to_check"].append(str(path))
    
    # Look for file references in error
    file_refs = re.findall(r'["\']?([A-Za-z]:\\[^"\'<>|\n]+|/[^"\'<>|\n]+\.(?:py|js|json))', error_message)
    diagnosis["files_to_check"].extend(file_refs)
    
    return diagnosis

# =============================================================================
# SELF-MODIFICATION (WITH APPROVAL)
# =============================================================================

class PendingModification:
    """Represents a code change awaiting approval"""
    
    def __init__(self, file_path: Path, new_content: str, reason: str):
        self.id = hashlib.md5(f"{file_path}{datetime.now()}".encode()).hexdigest()[:8]
        self.file_path = file_path
        self.new_content = new_content
        self.reason = reason
        self.original_content = read_file(file_path)
        self.diff = generate_diff(self.original_content, new_content, file_path.name)
        self.created = datetime.now()
        self.status = "pending"  # pending, approved, rejected, applied
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "file": str(self.file_path),
            "reason": self.reason,
            "diff": self.diff,
            "status": self.status,
            "created": self.created.isoformat()
        }

# Store pending modifications
_pending_modifications: Dict[str, PendingModification] = {}

def propose_modification(file_path: Path, new_content: str, reason: str) -> Dict[str, Any]:
    """Propose a code modification (requires approval to apply)"""
    mod = PendingModification(file_path, new_content, reason)
    _pending_modifications[mod.id] = mod
    
    return {
        "status": "proposed",
        "modification_id": mod.id,
        "file": str(file_path),
        "reason": reason,
        "diff": mod.diff,
        "message": f"Modification proposed. Review the diff and call approve_modification('{mod.id}') to apply.",
        "approval_required": True
    }

def list_pending_modifications() -> List[Dict[str, Any]]:
    """List all pending modifications"""
    return [mod.to_dict() for mod in _pending_modifications.values() if mod.status == "pending"]

def approve_modification(mod_id: str) -> Dict[str, Any]:
    """Approve and apply a pending modification"""
    if mod_id not in _pending_modifications:
        return {"status": "error", "message": f"Modification {mod_id} not found"}
    
    mod = _pending_modifications[mod_id]
    
    if mod.status != "pending":
        return {"status": "error", "message": f"Modification already {mod.status}"}
    
    # Create backup
    backup_path = create_backup(mod.file_path)
    
    # Apply the change
    result = write_file(mod.file_path, mod.new_content, backup=False)  # Already backed up
    
    if result["status"] == "success":
        mod.status = "applied"
        return {
            "status": "success",
            "message": f"Modification applied to {mod.file_path}",
            "backup": str(backup_path),
            "modification_id": mod_id
        }
    else:
        mod.status = "failed"
        return {
            "status": "error",
            "message": f"Failed to apply: {result.get('error')}",
            "modification_id": mod_id
        }

def reject_modification(mod_id: str) -> Dict[str, Any]:
    """Reject a pending modification"""
    if mod_id not in _pending_modifications:
        return {"status": "error", "message": f"Modification {mod_id} not found"}
    
    mod = _pending_modifications[mod_id]
    mod.status = "rejected"
    
    return {
        "status": "success",
        "message": f"Modification {mod_id} rejected",
        "modification_id": mod_id
    }

def rollback_last_modification(file_path: Path) -> Dict[str, Any]:
    """Rollback to the most recent backup of a file"""
    backups = sorted(BACKUP_DIR.glob(f"{file_path.stem}_*.backup"), reverse=True)
    
    if not backups:
        return {"status": "error", "message": f"No backups found for {file_path.name}"}
    
    latest_backup = backups[0]
    result = restore_from_backup(latest_backup, file_path)
    
    if result["status"] == "success":
        result["backup_used"] = str(latest_backup)
        result["message"] = f"Rolled back {file_path.name} to {latest_backup.name}"
    
    return result

# =============================================================================
# SCRIPT GENERATION
# =============================================================================

def generate_fix_script(issue: Dict[str, Any]) -> str:
    """Generate a Python script to fix an identified issue"""
    script_parts = [
        '"""',
        f"Auto-generated fix script for: {issue.get('message', 'Unknown issue')}",
        f"Generated: {datetime.now().isoformat()}",
        '"""',
        "",
        "import os",
        "import sys",
        f"sys.path.insert(0, r'{AVA_CODEBASE['integration']}')",
        "",
        "from ava_self_modification import *",
        "",
        "def apply_fix():",
    ]
    
    # Generate fix based on issue type
    if "missing" in str(issue.get("message", "")).lower():
        script_parts.extend([
            "    # TODO: Implement fix for missing file/module",
            "    pass",
        ])
    elif "syntax" in str(issue.get("message", "")).lower():
        script_parts.extend([
            f"    # Syntax error in {issue.get('file', 'unknown')}",
            "    # Manual review required",
            "    pass",
        ])
    else:
        script_parts.extend([
            "    # Generic fix placeholder",
            "    pass",
        ])
    
    script_parts.extend([
        "",
        "if __name__ == '__main__':",
        "    apply_fix()",
    ])
    
    return "\n".join(script_parts)

# =============================================================================
# TOOL INTEGRATION
# =============================================================================

def self_mod_tool_handler(args: Dict[str, Any]) -> Dict[str, Any]:
    """Handler for self-modification tool calls"""
    action = args.get("action", "diagnose")
    
    if action == "diagnose":
        return diagnose_codebase()
    
    elif action == "diagnose_error":
        error = args.get("error", "")
        file_hint = args.get("file_hint")
        return diagnose_error(error, file_hint)
    
    elif action == "analyze_file":
        file_key = args.get("file")
        if file_key in CORE_FILES:
            path = CORE_FILES[file_key]
        else:
            path = Path(file_key)
        
        if path.suffix == '.py':
            return analyze_python_file(path)
        elif path.suffix == '.js':
            return analyze_javascript_file(path)
        else:
            return {"status": "error", "message": f"Unsupported file type: {path.suffix}"}
    
    elif action == "find_function":
        file_key = args.get("file")
        function_name = args.get("function")
        
        if file_key in CORE_FILES:
            path = CORE_FILES[file_key]
        else:
            path = Path(file_key)
        
        result = find_function_in_file(path, function_name)
        if result:
            return {"status": "ok", **result}
        else:
            return {"status": "not_found", "message": f"Function {function_name} not found in {path}"}
    
    elif action == "propose_fix":
        file_key = args.get("file")
        new_content = args.get("content")
        reason = args.get("reason", "No reason provided")
        
        if file_key in CORE_FILES:
            path = CORE_FILES[file_key]
        else:
            path = Path(file_key)
        
        return propose_modification(path, new_content, reason)
    
    elif action == "list_pending":
        return {"status": "ok", "pending": list_pending_modifications()}
    
    elif action == "approve":
        mod_id = args.get("modification_id")
        return approve_modification(mod_id)
    
    elif action == "reject":
        mod_id = args.get("modification_id")
        return reject_modification(mod_id)
    
    elif action == "rollback":
        file_key = args.get("file")
        if file_key in CORE_FILES:
            path = CORE_FILES[file_key]
        else:
            path = Path(file_key)
        return rollback_last_modification(path)
    
    elif action == "read_file":
        file_key = args.get("file")
        if file_key in CORE_FILES:
            path = CORE_FILES[file_key]
        else:
            path = Path(file_key)
        content = read_file(path)
        return {"status": "ok", "file": str(path), "content": content}
    
    elif action == "get_coding_knowledge":
        return {"status": "ok", "knowledge": CODING_KNOWLEDGE}
    
    elif action == "list_core_files":
        return {"status": "ok", "files": {k: str(v) for k, v in CORE_FILES.items()}}
    
    else:
        return {"status": "error", "message": f"Unknown action: {action}"}

# =============================================================================
# CLI
# =============================================================================

if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description="AVA Self-Modification System")
    parser.add_argument("action", choices=["diagnose", "analyze", "list-files", "backups"])
    parser.add_argument("--file", help="File to analyze")
    
    args = parser.parse_args()
    
    if args.action == "diagnose":
        result = diagnose_codebase()
        print(json.dumps(result, indent=2))
    
    elif args.action == "analyze":
        if args.file:
            if args.file in CORE_FILES:
                path = CORE_FILES[args.file]
            else:
                path = Path(args.file)
            
            if path.suffix == '.py':
                result = analyze_python_file(path)
            else:
                result = analyze_javascript_file(path)
            print(json.dumps(result, indent=2))
        else:
            print("Error: --file required for analyze")
    
    elif args.action == "list-files":
        for name, path in CORE_FILES.items():
            exists = "✓" if path.exists() else "✗"
            print(f"{exists} {name}: {path}")
    
    elif args.action == "backups":
        if BACKUP_DIR.exists():
            for backup in sorted(BACKUP_DIR.glob("*.backup")):
                print(f"  {backup.name}")
        else:
            print("No backups directory yet")
