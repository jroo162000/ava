"""Simple microphone test"""
import pyaudio

audio = pyaudio.PyAudio()

print("Available audio devices:")
for i in range(audio.get_device_count()):
    info = audio.get_device_info_by_index(i)
    print(f"{i}: {info['name']} (inputs: {info['maxInputChannels']})")

print("\nDefault input device:")
default = audio.get_default_input_device_info()
print(f"{default['name']}")

audio.terminate()
