#!/usr/bin/env python3
"""
AVA Preflight Checks - Validate system readiness before starting voice runner.

Checks:
1. Audio device availability (input/output)
2. Sample rate compatibility
3. Required native dependencies
4. Config file validity
"""
import os
import sys
import json
from datetime import datetime
from typing import Dict, List, Tuple, Optional

# Add parent to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_FILE = "ava_voice_config.json"
REQUIRED_SAMPLE_RATE = 22050


class PreflightResult:
    """Result of a preflight check."""
    def __init__(self, name: str, passed: bool, message: str = "", details: Optional[Dict] = None):
        self.name = name
        self.passed = passed
        self.message = message
        self.details = details or {}

    def __repr__(self):
        status = "PASS" if self.passed else "FAIL"
        return f"[{status}] {self.name}: {self.message}"


def check_pyaudio_available() -> PreflightResult:
    """Check if PyAudio is installed and can be imported."""
    try:
        import pyaudio
        pa = pyaudio.PyAudio()
        version = pyaudio.get_portaudio_version_text()
        pa.terminate()
        return PreflightResult(
            "PyAudio",
            True,
            f"Available ({version})",
            {"version": version}
        )
    except ImportError as e:
        return PreflightResult(
            "PyAudio",
            False,
            f"Not installed: {e}",
            {"error": str(e)}
        )
    except Exception as e:
        return PreflightResult(
            "PyAudio",
            False,
            f"Failed to initialize: {e}",
            {"error": str(e)}
        )


def check_audio_devices() -> PreflightResult:
    """Check audio input/output device availability."""
    try:
        import pyaudio
        pa = pyaudio.PyAudio()

        input_devices = []
        output_devices = []
        default_input = None
        default_output = None

        try:
            default_input = pa.get_default_input_device_info()
        except:
            pass

        try:
            default_output = pa.get_default_output_device_info()
        except:
            pass

        for i in range(pa.get_device_count()):
            try:
                info = pa.get_device_info_by_index(i)
                if info.get('maxInputChannels', 0) > 0:
                    input_devices.append({
                        'index': i,
                        'name': info.get('name', 'Unknown'),
                        'sample_rate': int(info.get('defaultSampleRate', 0))
                    })
                if info.get('maxOutputChannels', 0) > 0:
                    output_devices.append({
                        'index': i,
                        'name': info.get('name', 'Unknown'),
                        'sample_rate': int(info.get('defaultSampleRate', 0))
                    })
            except:
                pass

        pa.terminate()

        has_input = len(input_devices) > 0
        has_output = len(output_devices) > 0

        if has_input and has_output:
            return PreflightResult(
                "Audio Devices",
                True,
                f"{len(input_devices)} input, {len(output_devices)} output devices",
                {
                    "input_devices": input_devices,
                    "output_devices": output_devices,
                    "default_input": default_input.get('name') if default_input else None,
                    "default_output": default_output.get('name') if default_output else None
                }
            )
        elif not has_input:
            return PreflightResult(
                "Audio Devices",
                False,
                "No input devices found",
                {"output_devices": output_devices}
            )
        else:
            return PreflightResult(
                "Audio Devices",
                False,
                "No output devices found",
                {"input_devices": input_devices}
            )
    except Exception as e:
        return PreflightResult(
            "Audio Devices",
            False,
            f"Failed to enumerate: {e}",
            {"error": str(e)}
        )


def check_sample_rate_compatibility() -> PreflightResult:
    """Check if required sample rate is supported."""
    try:
        import pyaudio
        pa = pyaudio.PyAudio()

        # Try to open a stream at the required sample rate
        compatible_input = False
        compatible_output = False

        try:
            default_input = pa.get_default_input_device_info()
            input_rate = int(default_input.get('defaultSampleRate', 0))
            # Check if device supports our rate or can resample
            if input_rate == REQUIRED_SAMPLE_RATE or input_rate in [44100, 48000, 16000]:
                compatible_input = True
        except:
            pass

        try:
            default_output = pa.get_default_output_device_info()
            output_rate = int(default_output.get('defaultSampleRate', 0))
            if output_rate == REQUIRED_SAMPLE_RATE or output_rate in [44100, 48000, 24000]:
                compatible_output = True
        except:
            pass

        pa.terminate()

        if compatible_input and compatible_output:
            return PreflightResult(
                "Sample Rate",
                True,
                f"Compatible with {REQUIRED_SAMPLE_RATE} Hz"
            )
        else:
            issues = []
            if not compatible_input:
                issues.append("input")
            if not compatible_output:
                issues.append("output")
            return PreflightResult(
                "Sample Rate",
                False,
                f"Incompatible {', '.join(issues)} sample rate",
                {"required": REQUIRED_SAMPLE_RATE}
            )
    except Exception as e:
        return PreflightResult(
            "Sample Rate",
            False,
            f"Check failed: {e}",
            {"error": str(e)}
        )


def check_config_valid() -> PreflightResult:
    """Check if config file exists and is valid JSON."""
    config_path = os.path.join(PROJECT_ROOT, CONFIG_FILE)

    if not os.path.exists(config_path):
        return PreflightResult(
            "Config File",
            False,
            f"{CONFIG_FILE} not found"
        )

    try:
        with open(config_path, 'r') as f:
            config = json.load(f)

        # Check required sections
        required_sections = ['audio', 'vad', 'voice_stabilization']
        missing = [s for s in required_sections if s not in config]

        if missing:
            return PreflightResult(
                "Config File",
                False,
                f"Missing sections: {', '.join(missing)}",
                {"config": config}
            )

        return PreflightResult(
            "Config File",
            True,
            "Valid configuration",
            {"sections": list(config.keys())}
        )
    except json.JSONDecodeError as e:
        return PreflightResult(
            "Config File",
            False,
            f"Invalid JSON: {e}",
            {"error": str(e)}
        )
    except Exception as e:
        return PreflightResult(
            "Config File",
            False,
            f"Read error: {e}",
            {"error": str(e)}
        )


def check_piper_tts() -> PreflightResult:
    """Check if Piper TTS is available."""
    config_path = os.path.join(PROJECT_ROOT, CONFIG_FILE)

    try:
        with open(config_path, 'r') as f:
            config = json.load(f)

        piper_cfg = config.get('local_fallback', {}).get('piper', {})
        piper_exe = piper_cfg.get('exe', '')
        piper_model = piper_cfg.get('model', '')

        exe_exists = os.path.exists(piper_exe) if piper_exe else False
        model_exists = os.path.exists(piper_model) if piper_model else False

        if exe_exists and model_exists:
            return PreflightResult(
                "Piper TTS",
                True,
                "Executable and model found"
            )
        else:
            issues = []
            if not exe_exists:
                issues.append(f"exe not found: {piper_exe}")
            if not model_exists:
                issues.append(f"model not found: {piper_model}")
            return PreflightResult(
                "Piper TTS",
                False,
                "; ".join(issues),
                {"exe": piper_exe, "model": piper_model}
            )
    except Exception as e:
        return PreflightResult(
            "Piper TTS",
            False,
            f"Check failed: {e}",
            {"error": str(e)}
        )


def check_vosk_model() -> PreflightResult:
    """Check if Vosk model is available."""
    # Common Vosk model locations
    model_paths = [
        os.path.join(PROJECT_ROOT, "vosk-model-small-en-us-0.15"),
        os.path.join(PROJECT_ROOT, "models", "vosk-model-small-en-us-0.15"),
        os.path.join(PROJECT_ROOT, "vendor", "vosk-model-small-en-us-0.15"),
    ]

    for path in model_paths:
        if os.path.exists(path):
            return PreflightResult(
                "Vosk Model",
                True,
                f"Found at {os.path.basename(path)}"
            )

    # Check if vosk can be imported
    try:
        import vosk
        return PreflightResult(
            "Vosk Model",
            True,
            "Vosk library available (model may load at runtime)"
        )
    except ImportError:
        return PreflightResult(
            "Vosk Model",
            False,
            "Vosk not installed and no model found"
        )


def run_all_checks(verbose: bool = True) -> Tuple[bool, List[PreflightResult]]:
    """Run all preflight checks and return overall status."""
    checks = [
        check_pyaudio_available,
        check_audio_devices,
        check_sample_rate_compatibility,
        check_config_valid,
        check_piper_tts,
        check_vosk_model,
    ]

    results = []
    all_passed = True
    critical_failed = False

    if verbose:
        print("=" * 60)
        print("AVA PREFLIGHT CHECKS")
        print("=" * 60)

    for check_fn in checks:
        result = check_fn()
        results.append(result)

        if verbose:
            status = "[PASS]" if result.passed else "[FAIL]"
            print(f"{status} {result.name}: {result.message}")

        if not result.passed:
            all_passed = False
            # PyAudio and Audio Devices are critical
            if result.name in ["PyAudio", "Audio Devices"]:
                critical_failed = True

    if verbose:
        print("-" * 60)
        if all_passed:
            print("[OK] All preflight checks passed")
        elif critical_failed:
            print("[XX] CRITICAL: Audio subsystem unavailable")
        else:
            print("[!!] Some checks failed (may still work)")

    return all_passed, results


def get_preflight_summary() -> Dict:
    """Get preflight check results as a dictionary."""
    _, results = run_all_checks(verbose=False)
    return {
        "timestamp": datetime.now().isoformat(),
        "all_passed": all(r.passed for r in results),
        "checks": {r.name: {"passed": r.passed, "message": r.message, "details": r.details} for r in results}
    }


if __name__ == "__main__":
    all_passed, _ = run_all_checks(verbose=True)
    sys.exit(0 if all_passed else 1)
