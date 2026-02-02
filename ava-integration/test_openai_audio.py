"""
OpenAI Native Audio Testing
Tests all OpenAI audio capabilities: TTS, transcription, audio-aware conversations
"""

import sys
import os
from datetime import datetime
from pathlib import Path

# Set UTF-8 encoding for Windows console
if sys.platform == 'win32':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except:
        pass

# Add cmp-use to path
sys.path.insert(0, r"C:\Users\USER 1\cmp-use")

from cmpuse.agent_core import Agent, Plan, Step
from cmpuse.config import Config
from cmpuse.secrets import load_into_env
import cmpuse.tools

print("=" * 100)
print("OPENAI NATIVE AUDIO TESTING")
print("=" * 100)
print(f"Started: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")

# Load configuration
load_into_env()
config = Config.from_env()
agent = Agent(config)

# ============================================================================
# TEST 1: TEXT-TO-SPEECH (TTS)
# ============================================================================
print("\n" + "=" * 100)
print("TEST 1: OpenAI Text-to-Speech (TTS)")
print("=" * 100)

print("\n1a. Testing: Basic TTS with Sage voice")
print("-" * 100)
try:
    plan = Plan(steps=[Step(tool="audio_ops", args={
        "action": "speak",
        "text": "Hello Jelani, this is AVA speaking using OpenAI's native text-to-speech with the Sage voice. How does it sound?",
        "voice": "sage",
        "confirm": True
    })])
    results = agent.run(plan, force=True)

    if results:
        status = results[0].get('status')
        print(f"Status: {status}")

        if status == 'ok':
            message = results[0].get('message')
            voice = results[0].get('voice')
            model = results[0].get('model')
            print(f"✅ SUCCESS - {message}")
            print(f"Voice: {voice}, Model: {model}")
        else:
            message = results[0].get('message', 'Unknown error')
            print(f"❌ ERROR: {message}")
except Exception as e:
    print(f"❌ Exception: {str(e)}")

# Test different voices
print("\n1b. Testing: Different voice options")
print("-" * 100)

voices = [
    ("sage", "new female voice, default for AVA"),
    ("coral", "new female voice"),
    ("ash", "new male voice"),
    ("nova", "female, warm"),
    ("alloy", "neutral, balanced"),
    ("echo", "male, clear"),
    ("fable", "expressive, storytelling"),
    ("onyx", "deep, authoritative"),
    ("shimmer", "soft, soothing")
]

for voice, description in voices:
    try:
        print(f"\nTesting {voice} voice ({description})...")
        plan = Plan(steps=[Step(tool="audio_ops", args={
            "action": "tts",
            "text": f"This is the {voice} voice. {description}.",
            "voice": voice,
            "output_file": f"C:\\Users\\USER 1\\.cmpuse\\temp\\test_{voice}.mp3",
            "confirm": True
        })])
        results = agent.run(plan, force=True)

        if results and results[0].get('status') == 'ok':
            output = results[0].get('output_file')
            print(f"  ✅ {voice}: Saved to {output}")
        else:
            print(f"  ❌ {voice}: Failed")
    except Exception as e:
        print(f"  ❌ {voice}: Exception - {str(e)}")

# ============================================================================
# TEST 2: SPEECH-TO-TEXT (Transcription)
# ============================================================================
print("\n\n" + "=" * 100)
print("TEST 2: OpenAI Speech-to-Text (Transcription)")
print("=" * 100)

# First, create a test audio file to transcribe
print("\n2a. Creating test audio file...")
print("-" * 100)
test_audio_path = "C:\\Users\\USER 1\\.cmpuse\\temp\\test_transcription.mp3"

try:
    plan = Plan(steps=[Step(tool="audio_ops", args={
        "action": "speak",
        "text": "The quick brown fox jumps over the lazy dog. This is a test of OpenAI's speech-to-text transcription capability.",
        "voice": "sage",
        "output_file": test_audio_path,
        "confirm": True
    })])
    results = agent.run(plan, force=True)

    if results and results[0].get('status') == 'ok':
        print(f"✅ Test audio created: {test_audio_path}")

        # Now transcribe it
        print("\n2b. Testing: Transcribe the audio file")
        print("-" * 100)

        plan = Plan(steps=[Step(tool="audio_ops", args={
            "action": "transcribe",
            "audio_file": test_audio_path,
            "model": "whisper-1",
            "confirm": True
        })])
        results = agent.run(plan, force=True)

        if results:
            status = results[0].get('status')
            print(f"Status: {status}")

            if status == 'ok':
                text = results[0].get('text')
                model = results[0].get('model')
                print(f"✅ SUCCESS - Transcription complete")
                print(f"Model: {model}")
                print(f"Transcribed text: {text}")
            else:
                message = results[0].get('message', 'Unknown error')
                print(f"❌ ERROR: {message}")
    else:
        print("❌ Failed to create test audio file")

except Exception as e:
    print(f"❌ Exception: {str(e)}")

# ============================================================================
# TEST 3: AUDIO-AWARE CONVERSATION
# ============================================================================
print("\n\n" + "=" * 100)
print("TEST 3: Audio-Aware Conversation (gpt-4o-audio-preview)")
print("=" * 100)

print("\n3a. Testing: Text-only audio-aware conversation")
print("-" * 100)
try:
    plan = Plan(steps=[Step(tool="audio_ops", args={
        "action": "audio_conversation",
        "prompt": "Explain what OpenAI's Realtime Voice API is and what makes it different from traditional TTS.",
        "model": "gpt-4o-audio-preview",
        "confirm": True
    })])
    results = agent.run(plan, force=True)

    if results:
        status = results[0].get('status')
        print(f"Status: {status}")

        if status == 'ok':
            response = results[0].get('response')
            model = results[0].get('model')
            print(f"✅ SUCCESS")
            print(f"Model: {model}")
            print(f"Response: {response[:500]}...")  # First 500 chars
        else:
            message = results[0].get('message', 'Unknown error')
            print(f"❌ ERROR: {message}")
except Exception as e:
    print(f"❌ Exception: {str(e)}")

# ============================================================================
# TEST 4: REALTIME API INFORMATION
# ============================================================================
print("\n\n" + "=" * 100)
print("TEST 4: OpenAI Realtime Voice API Information")
print("=" * 100)

print("\nTesting: Get Realtime API info")
print("-" * 100)
try:
    plan = Plan(steps=[Step(tool="audio_ops", args={
        "action": "realtime_info",
        "confirm": True
    })])
    results = agent.run(plan, force=True)

    if results:
        status = results[0].get('status')
        print(f"Status: {status}")

        if status == 'info':
            message = results[0].get('message')
            note = results[0].get('note')
            models = results[0].get('models', [])
            features = results[0].get('features', [])
            docs = results[0].get('documentation')

            print(f"✅ {message}")
            print(f"\nNote: {note}")
            print(f"\nAvailable Models:")
            for model in models:
                print(f"  - {model}")
            print(f"\nFeatures:")
            for feature in features:
                print(f"  - {feature}")
            print(f"\nDocumentation: {docs}")
        else:
            message = results[0].get('message', 'Unknown')
            print(f"❌ ERROR: {message}")
except Exception as e:
    print(f"❌ Exception: {str(e)}")

# ============================================================================
# TEST 5: SYSTEM TTS INTEGRATION
# ============================================================================
print("\n\n" + "=" * 100)
print("TEST 5: System TTS Module Integration")
print("=" * 100)

print("\nTesting: cmpuse.tts.speak() with OpenAI TTS")
print("-" * 100)
try:
    from cmpuse.tts import speak

    success = speak("Testing AVA's native TTS integration using OpenAI. This should use the Nova voice by default.")

    if success:
        print("✅ SUCCESS - TTS module working with OpenAI")
    else:
        print("❌ FAILED - TTS module returned False")
except Exception as e:
    print(f"❌ Exception: {str(e)}")

# ============================================================================
# SUMMARY
# ============================================================================
print("\n\n" + "=" * 100)
print("OPENAI AUDIO TEST SUMMARY")
print("=" * 100)

print("\n✅ Tests Completed:")
print("  1. Text-to-Speech (TTS) - Multiple voices")
print("  2. Speech-to-Text (Transcription)")
print("  3. Audio-aware conversation")
print("  4. Realtime API information")
print("  5. System TTS integration")

print("\n📊 OpenAI Audio Capabilities:")
print("  - TTS Models: tts-1-hd (high quality), tts-1 (standard), gpt-4o-mini-tts")
print("  - Transcription Models: whisper-1, gpt-4o-transcribe, gpt-4o-transcribe-diarize, gpt-4o-mini-transcribe")
print("  - Audio-aware Models: gpt-4o-audio-preview, gpt-audio, gpt-audio-mini")
print("  - Realtime Models: gpt-4o-realtime-preview, gpt-realtime, gpt-4o-mini-realtime-preview, gpt-realtime-mini")
print("  - Voices: sage (default, new), coral (new), ash (new), nova, alloy, echo, fable, onyx, shimmer")

print("\n🎯 Configuration:")
print(f"  - CMPUSE_TTS: {os.getenv('CMPUSE_TTS', 'openai')}")
print(f"  - CMPUSE_TTS_MODEL: {os.getenv('CMPUSE_TTS_MODEL', 'tts-1-hd')}")
print(f"  - CMPUSE_TTS_VOICE: {os.getenv('CMPUSE_TTS_VOICE', 'sage')}")

print("\n📁 Test Files Location:")
print(f"  {Path.home() / '.cmpuse' / 'temp'}")

print("\n" + "=" * 100)
print("TESTING COMPLETE")
print("=" * 100)
print(f"Finished: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
