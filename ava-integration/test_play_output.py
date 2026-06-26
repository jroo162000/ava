import json
import os
import wave
import math
import pyaudio
import numpy as np

CFG_PATH = os.path.join(os.path.dirname(__file__), 'ava_voice_config.json')

def load_cfg():
    try:
        with open(CFG_PATH, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {}

def _open_stream(p: pyaudio.PyAudio, rate: int, device_index: int | None):
    # Moderate buffer; avoid excessive latency
    return p.open(
        format=pyaudio.paInt16,
        channels=1,
        rate=rate,
        output=True,
        frames_per_buffer=4096,
        output_device_index=device_index if device_index is not None else None,
    )

def _write_silence(stream, rate: int, ms: int = 1000):
    # Prime with digital silence (zeros)
    total = int(rate * ms / 1000)
    if total <= 0:
        return
    chunk = b"\x00\x00" * 2048
    remaining = total
    while remaining > 0:
        n = min(remaining, 2048)
        stream.write(chunk[:n*2])
        remaining -= n

def _fade_in_int16(audio: bytes, rate: int, ms: int = 400) -> bytes:
    try:
        arr = np.frombuffer(audio, dtype=np.int16)
        n = min(len(arr), int(rate * ms / 1000))
        if n <= 0:
            return audio
        ramp = np.linspace(0.0, 1.0, n, endpoint=True, dtype=np.float32)
        arr[:n] = (arr[:n].astype(np.float32) * ramp).astype(np.int16)
        return arr.tobytes()
    except Exception:
        return audio

def _resample_int16(audio: bytes, src_rate: int, dst_rate: int) -> bytes:
    if src_rate == dst_rate:
        return audio
    try:
        x = np.frombuffer(audio, dtype=np.int16).astype(np.float32)
        if len(x) == 0:
            return audio
        new_len = int(len(x) * dst_rate / src_rate)
        if new_len <= 0:
            return audio
        a = np.linspace(0.0, 1.0, len(x), endpoint=False, dtype=np.float32)
        b = np.linspace(0.0, 1.0, new_len, endpoint=False, dtype=np.float32)
        y = np.interp(b, a, x)
        return y.astype(np.int16).tobytes()
    except Exception:
        return audio

def _write_pcm(stream, data: bytes, chunk: int = 8192):
    for i in range(0, len(data), chunk):
        stream.write(data[i:i+chunk])

def play_wav(p: pyaudio.PyAudio, wav_path: str, device_index: int | None, target_rate: int | None = None, stream=None):
    if not os.path.exists(wav_path):
        print(f"[wav] missing: {wav_path}")
        return
    with wave.open(wav_path, 'rb') as wf:
        ch = wf.getnchannels()
        sr = wf.getframerate()
        sw = wf.getsampwidth()
        print(f"[wav] playing {wav_path} ch={ch} sr={sr} sampwidth={sw}")
        # Read entire WAV, convert to int16 mono, resample to target_rate if provided
        frames = wf.readframes(wf.getnframes())
        if ch == 2:
            arr = np.frombuffer(frames, dtype=np.int16).reshape(-1, 2)
            mono = arr.mean(axis=1).astype(np.int16).tobytes()
        else:
            mono = frames
        dst_rate = target_rate or sr
        data = _resample_int16(mono, sr, dst_rate)
        data = _fade_in_int16(data, dst_rate, ms=400)
        # If a persistent stream is provided, use it; else open/close a temporary one
        if stream is None:
            stream = _open_stream(p, dst_rate, device_index)
            _write_silence(stream, dst_rate, ms=1000)
            _write_pcm(stream, data)
            stream.stop_stream(); stream.close()
        else:
            _write_pcm(stream, data)
    print("[wav] played")

def main():
    cfg = load_cfg()
    audio = cfg.get('audio', {}) if isinstance(cfg, dict) else {}
    out_idx = audio.get('output_device')
    try:
        out_idx = int(out_idx) if out_idx is not None else None
    except Exception:
        out_idx = None
    rate = int(audio.get('playback_rate', 44100) or 44100)

    p = pyaudio.PyAudio()
    try:
        # Show default output for clarity
        try:
            dinfo = p.get_default_output_device_info()
            print(f"[default_out] idx={int(dinfo.get('index'))} name={dinfo.get('name')} @ {int(dinfo.get('defaultSampleRate',0))}Hz")
        except Exception as e:
            print(f"[default_out] error: {e}")

        # Open a single persistent stream to avoid repeated open transients
        stream = _open_stream(p, rate, out_idx)
        _write_silence(stream, rate, ms=1000)

        # 1) Play last_tts.wav if present (resample to target rate, fade-in)
        last_wav = os.path.join(os.path.dirname(__file__), 'last_tts.wav')
        play_wav(p, last_wav, out_idx, target_rate=rate, stream=stream)
        _write_silence(stream, rate, ms=300)

        # 2) Play piper_test.wav if present (resample to target rate, fade-in)
        piper_wav = os.path.join(os.path.dirname(__file__), 'piper_test.wav')
        play_wav(p, piper_wav, out_idx, target_rate=rate, stream=stream)
        stream.stop_stream(); stream.close()
    finally:
        p.terminate()

if __name__ == '__main__':
    main()
