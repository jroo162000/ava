"""Live microphone test - shows RMS levels in real-time"""
import pyaudio
import struct
import math
import time

p = pyaudio.PyAudio()

# Use device 1 (iTalk)
device = 1
rate = 44100
chunk = 1323

print(f"Testing microphone device {device} at {rate} Hz")
print("Speak into the microphone - you should see RMS values above 1000 when speaking")
print("Press Ctrl+C to stop\n")

stream = p.open(format=pyaudio.paInt16, channels=1, rate=rate, input=True,
                frames_per_buffer=chunk, input_device_index=device)

try:
    while True:
        data = stream.read(chunk, exception_on_overflow=False)
        samples = struct.unpack('<' + 'h' * (len(data) // 2), data)
        rms = math.sqrt(sum(s * s for s in samples) / len(samples))

        # Visual bar
        bars = int(rms / 100)
        bar_str = '█' * min(bars, 50)

        print(f"\rRMS: {int(rms):5d} | {bar_str:<50}", end='', flush=True)
        time.sleep(0.05)

except KeyboardInterrupt:
    print("\n\nTest stopped")
finally:
    stream.stop_stream()
    stream.close()
    p.terminate()
