"""
Quick script to check available OpenAI audio models
"""
import sys
sys.path.insert(0, r"C:\Users\USER 1\cmp-use")

from openai import OpenAI
from cmpuse.secrets import load_into_env

load_into_env()
client = OpenAI()

print("Fetching all OpenAI models...")
models = client.models.list()

print("\n" + "="*80)
print("AUDIO/TTS/SPEECH MODELS:")
print("="*80)

audio_keywords = ['tts', 'whisper', 'audio', 'speech', 'realtime', 'transcribe']
audio_models = []

for model in models.data:
    model_id = model.id.lower()
    if any(keyword in model_id for keyword in audio_keywords):
        audio_models.append(model.id)

for model in sorted(audio_models):
    print(f"  - {model}")

if not audio_models:
    print("  None found with keywords. Showing ALL models:")
    for model in sorted([m.id for m in models.data]):
        print(f"  - {model}")
