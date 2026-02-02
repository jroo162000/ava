import sys
import os
import json

# Ensure cmp-use on path
sys.path.insert(0, r"C:\Users\USER 1\cmp-use")

from cmpuse.secrets import load_into_env
from cmpuse.tool_registry import list_tools, get_tool
import cmpuse.tools  # noqa: F401  # side-effect: registers tools

EXPECTED = [
    'calendar_ops','comm_ops','iot_ops','camera_ops','security_ops',
    'vision_ops','screen_ops','audio_ops','fs_ops','net_ops',
    'sys_ops','memory_system','analysis_ops','browser_automation','remote_ops',
    'window_ops','mouse_ops','key_ops','proactive_ops','learning_db'
]

def main():
    load_into_env()
    reg = list_tools()
    results = []

    for name in EXPECTED:
        present = name in reg
        info = {
            'tool': name,
            'present': present,
            'plan_check': None,
            'notes': ''
        }
        if not present:
            info['notes'] = 'Not registered'
            results.append(info)
            continue
        tool = get_tool(name)
        # Try a minimal plan call to ensure interface works (non-executing)
        try:
            # Many tools expect an 'action' in plan; call with empty and expect a validation error or usage
            plan = tool.plan({})
            info['plan_check'] = 'ok'
            if isinstance(plan, dict) and plan.get('status') == 'error':
                info['notes'] = plan.get('message','')
        except Exception as e:
            info['plan_check'] = 'error'
            info['notes'] = str(e)
        results.append(info)

    summary = {
        'total_expected': len(EXPECTED),
        'registered': sum(1 for r in results if r['present']),
        'missing': [r['tool'] for r in results if not r['present']],
        'details': results,
    }
    print(json.dumps(summary, indent=2))

if __name__ == '__main__':
    main()
