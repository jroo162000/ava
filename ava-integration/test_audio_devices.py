"""Quick test to check audio device availability"""
import pyaudio

p = pyaudio.PyAudio()
print(f"\nTotal audio devices: {p.get_device_count()}\n")
print("=" * 80)
print("AUDIO DEVICES:")
print("=" * 80)

for i in range(p.get_device_count()):
    try:
        info = p.get_device_info_by_index(i)
        max_in = int(info.get('maxInputChannels', 0))
        max_out = int(info.get('maxOutputChannels', 0))
        rate = int(info.get('defaultSampleRate', 0))
        name = info.get('name', 'Unknown')

        device_type = []
        if max_in > 0:
            device_type.append(f"INPUT (ch={max_in})")
        if max_out > 0:
            device_type.append(f"OUTPUT (ch={max_out})")

        type_str = " | ".join(device_type) if device_type else "UNKNOWN"

        marker = ""
        if i == 16:
            marker = " <<< CONFIGURED IN CONFIG"

        print(f"[{i:2d}] {type_str:25s} @ {rate:5d} Hz - {name}{marker}")
    except Exception as e:
        print(f"[{i:2d}] ERROR: {e}")

p.terminate()

print("\n" + "=" * 80)
print("CONFIG CHECK:")
print("=" * 80)

# Check if device 16 is valid
try:
    p = pyaudio.PyAudio()
    if 16 < p.get_device_count():
        info = p.get_device_info_by_index(16)
        max_in = int(info.get('maxInputChannels', 0))
        if max_in > 0:
            print(f"✅ Device 16 is VALID for input (has {max_in} input channels)")
        else:
            print(f"❌ Device 16 is NOT valid for input (has {max_in} input channels)")
    else:
        print(f"❌ Device 16 does NOT exist (only {p.get_device_count()} devices available)")
    p.terminate()
except Exception as e:
    print(f"❌ Error checking device 16: {e}")
