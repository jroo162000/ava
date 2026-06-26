import ast
import sys
from pathlib import Path
try:
    target = Path(__file__).resolve().parent / 'ava_standalone_realtime.py'
    with open(target, 'r', encoding='utf-8') as f:
        code = f.read()
    ast.parse(code)
    print("SUCCESS: Syntax OK")
except SyntaxError as e:
    print(f"SYNTAX ERROR at line {e.lineno}: {e.msg}")
    print(f"  Text: {e.text}")
except Exception as e:
    print(f"ERROR: {type(e).__name__}: {e}")
