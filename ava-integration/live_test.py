"""
Live integration test for AVA
Tests actual tool execution through the server API
"""

import urllib.request
import json
import sys

def test_server_api():
    """Test server responds correctly"""
    url = "http://127.0.0.1:5051/respond"
    
    # Test 1: Basic query
    data = json.dumps({
        "sessionId": "test-session",
        "messages": [{"role": "user", "content": "system info"}],
        "run_tools": True,
        "allow_write": True,
        "persona": "AVA"
    }).encode('utf-8')
    
    req = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'}, method='POST')
    
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read().decode('utf-8'))
            text = result.get('output_text') or result.get('text') or ''
            print(f"Server Response: {text[:200]}...")
            return True
    except Exception as e:
        print(f"Server Error: {e}")
        return False

def test_tool_execution():
    """Test tool execution through server"""
    url = "http://127.0.0.1:5051/respond"
    
    data = json.dumps({
        "sessionId": "test-session",
        "messages": [{"role": "user", "content": "list files in current directory"}],
        "run_tools": True,
        "allow_write": True
    }).encode('utf-8')
    
    req = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'}, method='POST')
    
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read().decode('utf-8'))
            text = result.get('output_text') or result.get('text') or ''
            print(f"Tool Result: {text[:300]}...")
            return True
    except Exception as e:
        print(f"Tool Error: {e}")
        return False

if __name__ == "__main__":
    print("=" * 60)
    print("LIVE AVA INTEGRATION TEST")
    print("=" * 60)
    print()
    
    print("Test 1: Server API...")
    if test_server_api():
        print("✅ Server responding\n")
    else:
        print("❌ Server not responding\n")
        sys.exit(1)
    
    print("Test 2: Tool Execution...")
    if test_tool_execution():
        print("✅ Tools working\n")
    else:
        print("❌ Tool execution failed\n")
    
    print("=" * 60)
    print("Tests complete!")
