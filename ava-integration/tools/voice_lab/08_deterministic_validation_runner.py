"""Voice Lab tool: 08_deterministic_validation_runner.py

Repeatable end-to-end validation for AVa's local voice path using the existing
WAV-backed deterministic mic input.

This avoids speaker-to-mic acoustics entirely:
- generate a local prompt WAV with Piper
- launch ava_standalone_realtime.py with AVA_INPUT_WAV
- wait for asr_final / llm_done in AVA_LATENCY_LOG
- capture logs, harness wavs, and a machine-readable summary
- optionally sweep a prompt matrix derived from validation wake aliases
"""

from __future__ import annotations

import argparse
import audioop
import json
import os
import re
import shutil
import subprocess
import sys
import time
import wave
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from voice.tts.piper_bin import PiperBinTTS

try:
    from faster_whisper import WhisperModel
except Exception:
    WhisperModel = None


DEFAULT_SINGLE_PROMPT = 'Hey Eva say hello there.'
DEFAULT_PROMPT_SUFFIX = 'say hello there.'


def _load_voice_config() -> dict[str, Any]:
    cfg_path = ROOT / 'ava_voice_config.json'
    return json.loads(cfg_path.read_text(encoding='utf-8'))


def _timestamp() -> str:
    return time.strftime('%Y%m%d_%H%M%S')


def _slugify(text: str, max_len: int = 48) -> str:
    cleaned = re.sub(r'[^a-z0-9]+', '-', str(text or '').strip().lower()).strip('-')
    return cleaned[:max_len] or 'prompt'


def _dedupe_texts(items: list[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for item in items:
        normalized = ' '.join(str(item or '').split()).strip()
        if not normalized:
            continue
        key = normalized.casefold()
        if key in seen:
            continue
        seen.add(key)
        result.append(normalized)
    return result


def _default_prompt_matrix() -> list[str]:
    cfg = _load_voice_config()
    validation_cfg = cfg.get('validation_mode') or {}
    wake_words = _dedupe_texts([str(item or '').strip() for item in (validation_cfg.get('wake_words') or [])])
    prompts = [DEFAULT_SINGLE_PROMPT]
    for wake in wake_words:
        prompt = ' '.join(f'{wake} {DEFAULT_PROMPT_SUFFIX}'.split()).strip()
        if prompt and prompt[0].islower():
            prompt = prompt[0].upper() + prompt[1:]
        prompts.append(prompt)
    return _dedupe_texts(prompts)


def _prepare_input_wav(run_dir: Path, input_wav: str) -> tuple[Path, str]:
    source = Path(str(input_wav or '').strip()).expanduser().resolve()
    if not source.exists():
        raise FileNotFoundError(f'Input WAV not found: {source}')
    if source.suffix.lower() != '.wav':
        raise ValueError(f'Input file must be a WAV: {source}')
    target = run_dir / 'deterministic_input.wav'
    if source != target:
        shutil.copy2(source, target)
    return target, str(source)

def _build_prompt_wav(run_dir: Path, prompt_text: str, frame_ms: int = 20) -> Path:
    cfg = _load_voice_config()
    local_cfg = cfg.get('local_fallback') or {}
    piper_cfg = local_cfg.get('piper') or {}
    exe_path = str(piper_cfg.get('exe') or '').strip()
    model_path = str(piper_cfg.get('model') or '').strip()
    if not exe_path or not model_path:
        raise RuntimeError('local_fallback.piper exe/model missing from ava_voice_config.json')

    last_error: Exception | None = None
    for attempt in range(1, 4):
        tts = PiperBinTTS(exe_path=exe_path, model_path=model_path)
        try:
            if not tts.warmup(timeout=8.0):
                raise RuntimeError(f'Piper prompt warmup failed (attempt {attempt})')

            pcm = bytearray()
            tts.speak(prompt_text, lambda chunk: pcm.extend(chunk), frame_ms=max(int(frame_ms or 20), 10))
            sample_rate = int(getattr(tts, 'current_sample_rate', 22050) or 22050)
            wav_path = run_dir / 'deterministic_input.wav'
            with wave.open(str(wav_path), 'wb') as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(sample_rate)
                wf.writeframes(bytes(pcm))
            return wav_path
        except Exception as exc:
            last_error = exc
            if attempt < 3:
                time.sleep(1.0)
        finally:
            try:
                tts.stop()
            except Exception:
                pass

    raise RuntimeError(f'Prompt synthesis failed for {prompt_text!r}: {last_error}')

def _read_latency_records(latency_path: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    if not latency_path.exists():
        return records
    for line in latency_path.read_text(encoding='utf-8', errors='ignore').splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            records.append(json.loads(line))
        except Exception:
            continue
    return records


def _wait_for_ready(proc: subprocess.Popen[Any], stdout_path: Path, timeout_sec: float) -> bool:
    deadline = time.time() + max(timeout_sec, 1.0)
    while time.time() < deadline:
        if proc.poll() is not None:
            break
        if stdout_path.exists():
            raw = stdout_path.read_text(encoding='utf-8', errors='ignore')
            if 'Unified voice session active' in raw:
                return True
        time.sleep(1.0)
    return False


def _wait_for_stage(proc: subprocess.Popen[Any], latency_path: Path, stage: str, timeout_sec: float) -> bool:
    deadline = time.time() + max(timeout_sec, 1.0)
    while time.time() < deadline:
        records = _read_latency_records(latency_path)
        if any(str(rec.get('stage') or '') == stage for rec in records):
            return True
        if proc.poll() is not None:
            break
        time.sleep(0.5)
    return False


def _find_selected_input(stdout_path: Path) -> str:
    if not stdout_path.exists():
        return ''
    selected = ''
    for line in stdout_path.read_text(encoding='utf-8', errors='ignore').splitlines():
        if 'Selected input:' in line or 'Deterministic input file:' in line:
            selected = line.strip()
    return selected


def _transcribe_user_wavs(run_dir: Path, limit: int = 5) -> list[dict[str, Any]]:
    if WhisperModel is None:
        return []
    cfg = _load_voice_config()
    local_cfg = cfg.get('local_fallback') or {}
    model_name = str(local_cfg.get('whisper_model') or 'tiny.en').strip() or 'tiny.en'
    model = WhisperModel(model_name, device='cpu', compute_type='int8')
    candidates: list[tuple[int, float, Path]] = []
    for path in sorted(run_dir.glob('*__user.wav')):
        with wave.open(str(path), 'rb') as wf:
            frames = wf.getnframes()
            rate = wf.getframerate()
            pcm = wf.readframes(frames)
        rms = int(audioop.rms(pcm, 2)) if pcm else 0
        duration = (frames / float(rate)) if rate else 0.0
        candidates.append((rms, duration, path))
    candidates.sort(key=lambda item: (item[0], item[1]), reverse=True)

    results: list[dict[str, Any]] = []
    for rms, duration, path in candidates[:max(int(limit or 0), 0)]:
        segments, _ = model.transcribe(
            str(path),
            language='en',
            beam_size=1,
            best_of=1,
            temperature=0.0,
            vad_filter=False,
            condition_on_previous_text=False,
        )
        text = ' '.join(seg.text.strip() for seg in segments if getattr(seg, 'text', '').strip()).strip()
        results.append({
            'path': str(path),
            'duration_sec': duration,
            'rms': rms,
            'text': text,
        })
    return results


def run_validation(
    prompt_text: str,
    timeout_sec: float,
    realtime: bool,
    output_dir: str = '',
    asr_final_timeout_sec: float = 15.0,
    input_wav: str = '',
) -> tuple[int, Path, dict[str, Any]]:
    run_dir = Path(output_dir).expanduser().resolve() if output_dir else (ROOT / f'tmp_deterministic_voice_validation_{_timestamp()}').resolve()
    run_dir.mkdir(parents=True, exist_ok=True)
    input_wav_source = ''
    if str(input_wav or '').strip():
        prompt_path, input_wav_source = _prepare_input_wav(run_dir, input_wav)
    else:
        prompt_path = _build_prompt_wav(run_dir, prompt_text)
    stdout_path = run_dir / 'runner_stdout.log'
    stderr_path = run_dir / 'runner_stderr.log'
    latency_path = run_dir / 'latency.jsonl'
    summary_path = run_dir / 'summary.json'

    env = os.environ.copy()
    env.update({
        'AVA_INPUT_WAV': str(prompt_path),
        'AVA_INPUT_WAV_REALTIME': '1' if realtime else '0',
        'AVA_HARNESS': '1',
        'AVA_HARNESS_DIR': str(run_dir),
        'AVA_LATENCY_LOG': str(latency_path),
        'VALIDATION_MODE': '1',
        'DISABLE_AUTONOMY': '1',
        'PYTHONUNBUFFERED': '1',
        'PYTHONIOENCODING': 'utf-8',
        'AVA_ASR_FINAL_TIMEOUT_SEC': str(max(float(asr_final_timeout_sec or 0.0), 0.5)),
    })

    ready = False
    process_exit_code = None
    with stdout_path.open('w', encoding='utf-8') as stdout_fh, stderr_path.open('w', encoding='utf-8') as stderr_fh:
        proc = subprocess.Popen(
            [sys.executable, 'ava_standalone_realtime.py'],
            cwd=str(ROOT),
            env=env,
            stdout=stdout_fh,
            stderr=stderr_fh,
        )
        try:
            ready = _wait_for_ready(proc, stdout_path, timeout_sec=min(timeout_sec, 180.0))
            if ready:
                _wait_for_stage(proc, latency_path, 'asr_final', timeout_sec=max(timeout_sec * 0.6, 20.0))
                saw_llm_done = _wait_for_stage(proc, latency_path, 'llm_done', timeout_sec=max(timeout_sec * 0.4, 20.0))
                if saw_llm_done:
                    time.sleep(2.0)
        finally:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=8.0)
                except Exception:
                    proc.kill()
                    proc.wait(timeout=8.0)
            process_exit_code = proc.returncode

    records = _read_latency_records(latency_path)
    stages = [str(rec.get('stage') or '') for rec in records]
    user_transcripts = _transcribe_user_wavs(run_dir, limit=5)
    summary = {
        'run_dir': str(run_dir),
        'summary_json': str(summary_path),
        'prompt_text': prompt_text,
        'prompt_wav': str(prompt_path),
        'input_wav_source': input_wav_source,
        'stdout_log': str(stdout_path),
        'stderr_log': str(stderr_path),
        'latency_log': str(latency_path),
        'selected_input': _find_selected_input(stdout_path),
        'stages': stages,
        'ready': bool(ready),
        'saw_asr_final': 'asr_final' in stages,
        'saw_llm_done': 'llm_done' in stages,
        'asr_final_timeout_sec': float(asr_final_timeout_sec),
        'process_exit_code': process_exit_code,
        'user_transcripts': user_transcripts,
        'error': '',
    }
    summary['exit_code'] = 0 if summary['saw_llm_done'] else 1
    summary_path.write_text(json.dumps(summary, indent=2) + '\n', encoding='utf-8')

    print(f'RUN_DIR={run_dir}')
    print(f'PROMPT_TEXT={prompt_text}')
    print(f'PROMPT_WAV={prompt_path}')
    if input_wav_source:
        print(f'INPUT_WAV_SOURCE={input_wav_source}')
    print(f'SELECTED_INPUT={summary["selected_input"]}')
    print(f'READY={int(summary["ready"])}')
    print(f'STAGES={stages}')
    print(f'ASR_FINAL={int(summary["saw_asr_final"])}')
    print(f'LLM_DONE={int(summary["saw_llm_done"])}')
    print(f'SUMMARY_JSON={summary_path}')
    for item in user_transcripts:
        rel = Path(item['path']).name
        print(f'USER_WAV={rel}	duration={item["duration_sec"]:.2f}	rms={item["rms"]}	text={item["text"]}')

    return int(summary['exit_code']), run_dir, summary


def run_validation_matrix(
    prompt_texts: list[str],
    timeout_sec: float,
    realtime: bool,
    output_dir: str = '',
    asr_final_timeout_sec: float = 15.0,
    stop_on_success: bool = False,
) -> tuple[int, Path, dict[str, Any]]:
    prompts = _dedupe_texts(prompt_texts)
    if not prompts:
        prompts = [DEFAULT_SINGLE_PROMPT]

    base_dir = Path(output_dir).expanduser().resolve() if output_dir else (ROOT / f'tmp_deterministic_voice_validation_matrix_{_timestamp()}').resolve()
    base_dir.mkdir(parents=True, exist_ok=True)

    attempts: list[dict[str, Any]] = []
    for idx, prompt_text in enumerate(prompts, start=1):
        attempt_dir = base_dir / f'attempt_{idx:02d}_{_slugify(prompt_text)}'
        print(f'ATTEMPT_START={idx}/{len(prompts)}\tprompt={prompt_text}')
        try:
            _, _, summary = run_validation(
                prompt_text=prompt_text,
                timeout_sec=timeout_sec,
                realtime=realtime,
                output_dir=str(attempt_dir),
                asr_final_timeout_sec=asr_final_timeout_sec,
            )
            summary = dict(summary)
            summary['attempt_index'] = idx
            print(
                f'ATTEMPT_RESULT={idx}/{len(prompts)}\t'
                f'asr_final={int(summary["saw_asr_final"])}\t'
                f'llm_done={int(summary["saw_llm_done"])}'
            )
        except Exception as exc:
            attempt_dir.mkdir(parents=True, exist_ok=True)
            summary_path = attempt_dir / 'summary.json'
            summary = {
                'run_dir': str(attempt_dir),
                'summary_json': str(summary_path),
                'prompt_text': prompt_text,
                'prompt_wav': '',
                'input_wav_source': '',
                'stdout_log': str(attempt_dir / 'runner_stdout.log'),
                'stderr_log': str(attempt_dir / 'runner_stderr.log'),
                'latency_log': str(attempt_dir / 'latency.jsonl'),
                'selected_input': '',
                'stages': [],
                'ready': False,
                'saw_asr_final': False,
                'saw_llm_done': False,
                'asr_final_timeout_sec': float(asr_final_timeout_sec),
                'process_exit_code': None,
                'user_transcripts': [],
                'error': str(exc),
                'attempt_index': idx,
                'exit_code': 1,
            }
            summary_path.write_text(json.dumps(summary, indent=2) + '\n', encoding='utf-8')
            print(f'ATTEMPT_ERROR={idx}/{len(prompts)}\terror={exc}')
        attempts.append(summary)
        if stop_on_success and summary['saw_llm_done']:
            break

    first_asr_final = next((item for item in attempts if item.get('saw_asr_final')), None)
    first_llm_done = next((item for item in attempts if item.get('saw_llm_done')), None)
    aggregate = {
        'run_dir': str(base_dir),
        'matrix_summary_json': str(base_dir / 'matrix_summary.json'),
        'prompt_texts': [item.get('prompt_text', '') for item in attempts],
        'attempt_count': len(attempts),
        'stop_on_success': bool(stop_on_success),
        'asr_final_timeout_sec': float(asr_final_timeout_sec),
        'saw_any_asr_final': any(bool(item.get('saw_asr_final')) for item in attempts),
        'saw_any_llm_done': any(bool(item.get('saw_llm_done')) for item in attempts),
        'first_asr_final_prompt': first_asr_final.get('prompt_text') if first_asr_final else '',
        'first_llm_done_prompt': first_llm_done.get('prompt_text') if first_llm_done else '',
        'attempts': attempts,
    }
    matrix_summary_path = Path(aggregate['matrix_summary_json'])
    matrix_summary_path.write_text(json.dumps(aggregate, indent=2) + '\n', encoding='utf-8')

    print(f'MATRIX_RUN_DIR={base_dir}')
    print(f'MATRIX_SUMMARY_JSON={matrix_summary_path}')
    print(f'MATRIX_PROMPTS={len(attempts)}')
    print(f'MATRIX_ANY_ASR_FINAL={int(aggregate["saw_any_asr_final"])}')
    print(f'MATRIX_ANY_LLM_DONE={int(aggregate["saw_any_llm_done"])}')
    if aggregate['first_asr_final_prompt']:
        print(f'FIRST_ASR_FINAL_PROMPT={aggregate["first_asr_final_prompt"]}')
    if aggregate['first_llm_done_prompt']:
        print(f'FIRST_LLM_DONE_PROMPT={aggregate["first_llm_done_prompt"]}')

    exit_code = 0 if aggregate['saw_any_llm_done'] else 1
    return exit_code, base_dir, aggregate


def main() -> int:
    parser = argparse.ArgumentParser(description='Deterministic end-to-end validator for AVa local voice')
    parser.add_argument(
        '--prompt-text',
        action='append',
        default=[],
        help='Prompt text to synthesize and inject via AVA_INPUT_WAV; repeat the flag to sweep multiple prompts',
    )
    parser.add_argument(
        '--prompt-matrix',
        action='store_true',
        help='Sweep a default prompt matrix derived from validation_mode.wake_words in ava_voice_config.json',
    )
    parser.add_argument('--input-wav', default='', help='Use an existing WAV as deterministic input instead of Piper synthesis')
    parser.add_argument('--stop-on-success', action='store_true', help='Stop a prompt sweep after the first llm_done success')
    parser.add_argument('--timeout-sec', type=float, default=90.0, help='Per-attempt timeout budget for the validation run')
    parser.add_argument('--output-dir', default='', help='Optional output directory for logs and harness artifacts')
    parser.add_argument('--asr-final-timeout-sec', type=float, default=15.0, help='Override AVA_ASR_FINAL_TIMEOUT_SEC for deterministic validation runs')
    parser.add_argument('--no-realtime', action='store_true', help='Disable realtime pacing for the deterministic mic stream')
    args = parser.parse_args()

    prompt_texts = _dedupe_texts([str(item or '').strip() for item in (args.prompt_text or [])])
    input_wav = str(args.input_wav or '').strip()
    if args.prompt_matrix:
        prompt_texts = _dedupe_texts(prompt_texts + _default_prompt_matrix())
    if input_wav:
        if args.prompt_matrix:
            parser.error('--input-wav cannot be combined with --prompt-matrix')
        if len(prompt_texts) > 1:
            parser.error('--input-wav accepts at most one --prompt-text label')
        if not prompt_texts:
            prompt_texts = [f'input_wav:{Path(input_wav).stem}']
        exit_code, _, _ = run_validation(
            prompt_text=prompt_texts[0],
            timeout_sec=float(args.timeout_sec or 90.0),
            realtime=not bool(args.no_realtime),
            output_dir=str(args.output_dir or '').strip(),
            asr_final_timeout_sec=float(args.asr_final_timeout_sec or 15.0),
            input_wav=input_wav,
        )
        return exit_code
    if not prompt_texts:
        prompt_texts = [DEFAULT_SINGLE_PROMPT]

    use_matrix = bool(args.prompt_matrix or len(prompt_texts) > 1)
    if use_matrix:
        exit_code, _, _ = run_validation_matrix(
            prompt_texts=prompt_texts,
            timeout_sec=float(args.timeout_sec or 90.0),
            realtime=not bool(args.no_realtime),
            output_dir=str(args.output_dir or '').strip(),
            asr_final_timeout_sec=float(args.asr_final_timeout_sec or 15.0),
            stop_on_success=bool(args.stop_on_success),
        )
        return exit_code

    exit_code, _, _ = run_validation(
        prompt_text=prompt_texts[0],
        timeout_sec=float(args.timeout_sec or 90.0),
        realtime=not bool(args.no_realtime),
        output_dir=str(args.output_dir or '').strip(),
        asr_final_timeout_sec=float(args.asr_final_timeout_sec or 15.0),
    )
    return exit_code


if __name__ == '__main__':
    raise SystemExit(main())
