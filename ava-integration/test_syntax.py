import ast
import sys
try:
    with open(r'C:\Users\USER 1\ava-integration\ava_standalone_realtime.py', 'r', encoding='utf-8') as f:
        code = f.read()
    ast.parse(code)
    print("SUCCESS: Syntax OK")
except SyntaxError as e:
    print(f"SYNTAX ERROR at line {e.lineno}: {e.msg}")
    print(f"  Text: {e.text}")
except Exception as e:
    print(f"ERROR: {type(e).__name__}: {e}")
