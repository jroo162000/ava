import asyncio
import base64
import json
import os
import sys
import pyaudio
import websockets

# Read API keys from files
try:
    with open("deepgram key.txt", "r") as f:
        DEEPGRAM_API_KEY = f.read().strip()
    with open("gemini api key.txt", "r") as f:
        GEMINI_API_KEY = f.read().strip()
except FileNotFoundError as e:
    print(f"Error: {e}. Make sure 'deepgram key.txt' and 'gemini api key.txt' are in the same directory.")
    sys.exit(1)

# PyAudio constants
FORMAT = pyaudio.paInt16
CHANNELS = 1
RATE = 16000
CHUNK = 1024

async def main():
    uri = "wss://agent.deepgram.com/v1/agent/converse"
    headers = {"Authorization": f"Token {DEEPGRAM_API_KEY}"}

    async with websockets.connect(uri, additional_headers=headers) as websocket:
        print("Connected to Deepgram")

        async def microphone_thread():
            async def keep_alive(websocket):
                while True:
                    print("Sending KeepAlive")
                    await websocket.send(json.dumps({"type": "KeepAlive"}))
                    await asyncio.sleep(5)

            p = pyaudio.PyAudio()
            mic_stream = p.open(format=FORMAT,
                                channels=CHANNELS,
                                rate=RATE,
                                input=True,
                                frames_per_buffer=CHUNK)
            
            asyncio.create_task(keep_alive(websocket))

            while True:
                in_data = mic_stream.read(CHUNK)
                try:
                    await websocket.send(in_data)
                    await asyncio.sleep(0.01)
                except Exception as e:
                    print(f"Error sending audio data: {e}")
                    break
            mic_stream.stop_stream()
            mic_stream.close()
            p.terminate()

        async def receiver_thread():
            p = pyaudio.PyAudio()
            speaker_stream = p.open(format=pyaudio.paInt16,
                                    channels=1,
                                    rate=24000,
                                    output=True)
            while True:
                message = await websocket.recv()
                if isinstance(message, str):
                    data = json.loads(message)
                    if data.get("type") == "ConversationText":
                        print(f"{data['role']}: {data['content']}")
                elif isinstance(message, bytes):
                    speaker_stream.write(message)
            speaker_stream.stop_stream()
            speaker_stream.close()
            p.terminate()

        settings = {
            "type": "Settings",
            "audio": {
                "input": {
                    "encoding": "linear16",
                    "sample_rate": RATE,
                },
                "output": {
                    "encoding": "linear16",
                    "sample_rate": 24000,
                    "container": "wav",
                },
            },
            "agent": {
                "language": "en",
                "listen": {
                    "provider": {
                        "type": "deepgram",
                        "model": "nova-2",
                    }
                },
                "think": {
                    "provider": {
                        "type": "google",
                        "model": "gemini-1.0-pro",
                    },
                    "prompt": "You are a friendly AI assistant named AVA.",
                },
                "speak": {
                    "provider": {
                        "type": "deepgram",
                        "model": "aura-2-thalia-en",
                    }
                },
            },
        }
        await websocket.send(json.dumps(settings))

        await asyncio.gather(
            microphone_thread(),
            receiver_thread(),
        )

if __name__ == "__main__":
    os.chdir(sys.path[0])
    with open("gemini api key.txt", "r") as f:
        os.environ["GEMINI_API_KEY"] = f.read().strip()
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("Interrupted by user.")
    except Exception as e:
        print(f"An error occurred: {e}")
