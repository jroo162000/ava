"""Test if microphone can actually capture audio"""
import pyaudio
import time
import struct
import sys

# Fix encoding for Windows
if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')

SAMPLE_RATE = 24000
CHANNELS = 1
CHUNK_SIZE = 1024
FORMAT = pyaudio.paInt16

audio = pyaudio.PyAudio()

print("Opening microphone stream...")
try:
    stream = audio.open(
        format=FORMAT,
        channels=CHANNELS,
        rate=SAMPLE_RATE,
        input=True,
        frames_per_buffer=CHUNK_SIZE
    )

    print("[OK] Microphone stream opened successfully")
    print("Speak into your microphone for 3 seconds...")
    print()

    max_volume = 0
    for i in range(int(SAMPLE_RATE / CHUNK_SIZE * 3)):  # 3 seconds
        audio_data = stream.read(CHUNK_SIZE, exception_on_overflow=False)

        # Calculate volume level
        shorts = struct.unpack(f'{len(audio_data)//2}h', audio_data)
        volume = max(abs(s) for s in shorts)
        max_volume = max(max_volume, volume)

        # Visual indicator
        bar_length = int(volume / 1000)
        print(f"\rVolume: {'#' * min(bar_length, 50)} {volume:5d}", end='', flush=True)

    print()
    print()
    print(f"Maximum volume detected: {max_volume}")

    if max_volume < 100:
        print("[WARNING] Very low volume detected!")
        print("   - Check if microphone is muted")
        print("   - Check Windows microphone privacy settings")
        print("   - Check microphone volume in Windows settings")
    elif max_volume < 1000:
        print("[WARNING] Low volume detected - may have trouble detecting speech")
    else:
        print("[OK] Good microphone volume detected!")

    stream.stop_stream()
    stream.close()

except Exception as e:
    print(f"[ERROR] Error opening microphone: {e}")
    print()
    print("Possible solutions:")
    print("1. Check Windows microphone privacy settings:")
    print("   Settings > Privacy > Microphone > Allow desktop apps")
    print("2. Make sure the microphone is not muted")
    print("3. Try selecting a different microphone in Windows settings")

audio.terminate()
