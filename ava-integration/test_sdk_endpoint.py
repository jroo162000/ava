import sys
sys.path.insert(0, r"C:\Users\USER 1\cmp-use")

try:
    from deepgram.extensions.types.sockets import AgentV1Endpoint, AgentV1GoogleThinkProvider, AgentV1Think
    print("Imports OK")
    
    e = AgentV1Endpoint(url="https://test.com", headers={"key": "val"})
    print(f"Endpoint created: {e}")
    
    t = AgentV1Think(
        provider=AgentV1GoogleThinkProvider(type="google", model="gemini-2.5-flash"),
        endpoint=e,
        prompt="test"
    )
    print(f"Think with endpoint created: {t}")
except Exception as ex:
    print(f"ERROR: {ex}")
    import traceback
    traceback.print_exc()
