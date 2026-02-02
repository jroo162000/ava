from deepgram.listen.v2 import LiveOptions
from deepgram import __version__ as dg_version
from deepgram import DeepgramClient

print(f"Deepgram SDK Version: {dg_version}")
print("Successfully imported LiveOptions")

try:
    with open("deepgram key.txt", "r") as f:
        DEEPGRAM_API_KEY = f.read().strip()
    deepgram = DeepgramClient(api_key=DEEPGRAM_API_KEY)
    print("DeepgramClient initialized successfully.")
except Exception as e:
    print(f"Error initializing DeepgramClient: {e}")
