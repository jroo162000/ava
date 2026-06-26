import pyaudio

p = pyaudio.PyAudio()
print("\nOUTPUT DEVICES:\n" + "="*80)
default_out = None
try:
    info = p.get_default_output_device_info()
    default_out = int(info.get('index'))
    print(f"DEFAULT OUTPUT: [{default_out}] {info.get('name')} @ {int(info.get('defaultSampleRate',0))} Hz")
except Exception as e:
    print("DEFAULT OUTPUT: (error)", e)

for i in range(p.get_device_count()):
    try:
        info = p.get_device_info_by_index(i)
        max_out = int(info.get('maxOutputChannels', 0))
        if max_out > 0:
            name = info.get('name', 'Unknown')
            rate = int(info.get('defaultSampleRate', 0))
            mark = " (DEFAULT)" if default_out is not None and i == default_out else ""
            print(f"[{i:2d}] OUT (ch={max_out}) @ {rate:5d} Hz - {name}{mark}")
    except Exception as e:
        print(f"[{i:2d}] ERROR: {e}")

p.terminate()

