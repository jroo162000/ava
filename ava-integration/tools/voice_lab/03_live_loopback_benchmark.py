"""Voice Lab tool: 03_live_loopback_benchmark.py

Measure live speaker-to-microphone onset latency with PyAudio.

This opens one output device, one input device, plays a short sine tone, and
measures how long it takes the input stream RMS to cross a threshold.

Usage examples:
  python tools/voice_lab/03_live_loopback_benchmark.py
  python tools/voice_lab/03_live_loopback_benchmark.py --input-name "Microphone (Realtek High Definition Audio)" --output-name "Speaker/Headphone (Realtek High Definition Audio)"
  python tools/voice_lab/03_live_loopback_benchmark.py --list-devices
"""

from __future__ import annotations

import argparse
import json
import math
import statistics
import struct
import threading
import time
from pathlib import Path
from typing import Optional

import pyaudio


def load_config() -> dict:
    cfg_path = Path(__file__).resolve().parents[2] / 'ava_voice_config.json'
    try:
        return json.loads(cfg_path.read_text(encoding='utf-8'))
    except Exception:
        return {}


def list_devices(pa: pyaudio.PyAudio) -> None:
    print('Audio devices:')
    for idx in range(pa.get_device_count()):
        info = pa.get_device_info_by_index(idx)
        max_in = int(info.get('maxInputChannels', 0))
        max_out = int(info.get('maxOutputChannels', 0))
        roles = []
        if max_in > 0:
            roles.append(f'IN:{max_in}')
        if max_out > 0:
            roles.append(f'OUT:{max_out}')
        role_str = ', '.join(roles) or 'NONE'
        rate = int(info.get('defaultSampleRate', 0))
        print(f'[{idx:2d}] {role_str:12s} @ {rate:5d} Hz - {info.get("name")}')


def resolve_device(pa: pyaudio.PyAudio, kind: str, device: Optional[int], name: str) -> Optional[int]:
    if device is not None:
        return device
    pref = str(name or '').strip().lower()
    if not pref:
        try:
            if kind == 'input':
                return int(pa.get_default_input_device_info().get('index'))
            return int(pa.get_default_output_device_info().get('index'))
        except Exception:
            return None
    for idx in range(pa.get_device_count()):
        info = pa.get_device_info_by_index(idx)
        if kind == 'input' and int(info.get('maxInputChannels', 0)) <= 0:
            continue
        if kind == 'output' and int(info.get('maxOutputChannels', 0)) <= 0:
            continue
        if pref in str(info.get('name') or '').lower():
            return idx
    return None


def make_tone(rate: int, channels: int, hz: float, ms: int, amplitude: int) -> bytes:
    samples = int(rate * (ms / 1000.0))
    out = bytearray()
    for i in range(samples):
        sample = int(amplitude * math.sin(2.0 * math.pi * hz * i / rate))
        frame = struct.pack('<h', sample) * channels
        out += frame
    return bytes(out)


def rms_int16(data: bytes) -> float:
    if not data:
        return 0.0
    vals = struct.unpack('<' + 'h' * (len(data) // 2), data)
    if not vals:
        return 0.0
    return math.sqrt(sum(v * v for v in vals) / len(vals))


def main() -> int:
    cfg = load_config()
    audio_cfg = cfg.get('audio') or {}

    ap = argparse.ArgumentParser(description='AVa Voice Lab live loopback benchmark')
    ap.add_argument('--input-device', type=int, default=audio_cfg.get('input_device'))
    ap.add_argument('--output-device', type=int, default=audio_cfg.get('output_device'))
    ap.add_argument('--input-name', default=audio_cfg.get('input_device_name', ''))
    ap.add_argument('--output-name', default=audio_cfg.get('output_device_name', ''))
    ap.add_argument('--rate', type=int, default=int(audio_cfg.get('input_sample_rate', audio_cfg.get('playback_rate', 44100)) or 44100))
    ap.add_argument('--channels', type=int, default=1)
    ap.add_argument('--trials', type=int, default=5)
    ap.add_argument('--tone-hz', type=float, default=880.0)
    ap.add_argument('--tone-ms', type=int, default=700)
    ap.add_argument('--pre-roll-sec', type=float, default=0.30)
    ap.add_argument('--post-roll-sec', type=float, default=1.20)
    ap.add_argument('--cooldown-sec', type=float, default=0.35)
    ap.add_argument('--amplitude', type=int, default=22000)
    ap.add_argument('--chunk', type=int, default=1024)
    ap.add_argument('--json', action='store_true')
    ap.add_argument('--list-devices', action='store_true')
    args = ap.parse_args()

    pa = pyaudio.PyAudio()
    try:
        if args.list_devices:
            list_devices(pa)
            return 0

        input_device = resolve_device(pa, 'input', args.input_device, args.input_name)
        output_device = resolve_device(pa, 'output', args.output_device, args.output_name)
        if input_device is None or output_device is None:
            print(f'Unable to resolve devices: input={input_device} output={output_device}')
            return 2

        try:
            in_name = pa.get_device_info_by_index(input_device).get('name')
        except Exception:
            in_name = f'idx={input_device}'
        try:
            out_name = pa.get_device_info_by_index(output_device).get('name')
        except Exception:
            out_name = f'idx={output_device}'

        print(f'Input : [{input_device}] {in_name}')
        print(f'Output: [{output_device}] {out_name}')
        print(f'Rate={args.rate} Hz channels={args.channels} trials={args.trials}')

        tone = make_tone(args.rate, args.channels, args.tone_hz, args.tone_ms, args.amplitude)
        frame_bytes = args.chunk * args.channels * 2
        tone_chunks = [tone[i:i + frame_bytes] for i in range(0, len(tone), frame_bytes)]

        results = []
        for trial in range(1, args.trials + 1):
            in_stream = pa.open(
                format=pyaudio.paInt16,
                channels=args.channels,
                rate=args.rate,
                input=True,
                frames_per_buffer=args.chunk,
                input_device_index=input_device,
            )
            out_stream = pa.open(
                format=pyaudio.paInt16,
                channels=args.channels,
                rate=args.rate,
                output=True,
                frames_per_buffer=args.chunk,
                output_device_index=output_device,
            )

            baseline = []
            deadline = time.perf_counter() + args.pre_roll_sec
            while time.perf_counter() < deadline:
                baseline.append(rms_int16(in_stream.read(args.chunk, exception_on_overflow=False)))

            baseline_rms = statistics.mean(baseline) if baseline else 0.0
            baseline_med = statistics.median(baseline) if baseline else 0.0
            baseline_std = statistics.pstdev(baseline) if len(baseline) > 1 else 0.0
            threshold = max(1500.0, baseline_rms + max(1200.0, baseline_std * 0.25))
            stop_reader = threading.Event()
            play_started = threading.Event()
            first_detect = {'ts': None, 'rms': None, 'peak': 0.0}

            def reader() -> None:
                while not stop_reader.is_set():
                    rms = rms_int16(in_stream.read(args.chunk, exception_on_overflow=False))
                    if rms > first_detect['peak']:
                        first_detect['peak'] = rms
                    if play_started.is_set() and first_detect['ts'] is None and rms >= threshold:
                        first_detect['ts'] = time.perf_counter()
                        first_detect['rms'] = rms

            thread = threading.Thread(target=reader, daemon=True)
            thread.start()
            time.sleep(0.05)
            play_ts = time.perf_counter()
            play_started.set()
            for chunk in tone_chunks:
                out_stream.write(chunk)
            time.sleep(args.post_roll_sec)
            stop_reader.set()
            thread.join(timeout=1.0)
            in_stream.stop_stream()
            in_stream.close()
            out_stream.stop_stream()
            out_stream.close()
            if args.cooldown_sec > 0:
                time.sleep(args.cooldown_sec)

            if first_detect['ts'] is None:
                print(f'trial={trial} detected=no baseline_rms={baseline_rms:.1f} baseline_med={baseline_med:.1f} baseline_std={baseline_std:.1f} threshold={threshold:.1f} peak_rms={first_detect["peak"]:.1f}')
                continue

            latency_ms = (first_detect['ts'] - play_ts) * 1000.0
            results.append(latency_ms)
            print(
                f'trial={trial} detected=yes latency_ms={latency_ms:.1f} '
                f'baseline_rms={baseline_rms:.1f} baseline_med={baseline_med:.1f} baseline_std={baseline_std:.1f} threshold={threshold:.1f} '
                f'detect_rms={first_detect["rms"]:.1f} peak_rms={first_detect["peak"]:.1f}'
            )

        if not results:
            print('No loopback detections recorded.')
            return 3

        summary = {
            'input_device': input_device,
            'input_name': str(in_name),
            'output_device': output_device,
            'output_name': str(out_name),
            'rate': args.rate,
            'channels': args.channels,
            'trials': len(results),
            'min_ms': min(results),
            'p50_ms': statistics.median(results),
            'mean_ms': statistics.mean(results),
            'max_ms': max(results),
        }
        print('--- summary ---')
        print(f"min_ms={summary['min_ms']:.1f}")
        print(f"p50_ms={summary['p50_ms']:.1f}")
        print(f"mean_ms={summary['mean_ms']:.1f}")
        print(f"max_ms={summary['max_ms']:.1f}")
        if args.json:
            print(json.dumps(summary, indent=2))
        return 0
    finally:
        pa.terminate()


if __name__ == '__main__':
    raise SystemExit(main())
