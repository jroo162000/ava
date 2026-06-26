"""Shared live-mic input defaults for voice-lab tools."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
CONFIG_PATH = ROOT / "ava_voice_config.json"


def _coerce_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except Exception:
        return int(default)


def load_configured_live_input(
    config_path: Path | str = CONFIG_PATH,
    *,
    fallback_device: int = 14,
    fallback_rate: int = 48000,
) -> dict[str, Any]:
    """Return the input path used by the realtime local runner."""
    try:
        config = json.loads(Path(config_path).read_text(encoding="utf-8"))
    except Exception:
        config = {}
    audio = config.get("audio") if isinstance(config, dict) else {}
    audio = audio if isinstance(audio, dict) else {}
    device_value = audio.get("input_device")
    rate_value = audio.get("input_sample_rate")
    return {
        "device": _coerce_int(device_value, fallback_device),
        "rate": _coerce_int(rate_value, fallback_rate),
        "source": "ava_voice_config.json" if device_value is not None or rate_value is not None else "fallback",
        "device_name": str(audio.get("input_device_name") or ""),
    }


def apply_configured_live_input(args: Any, config_path: Path | str = CONFIG_PATH) -> dict[str, Any]:
    """Fill argparse device/rate fields from config when omitted."""
    defaults = load_configured_live_input(config_path)
    if getattr(args, "device", None) is None:
        args.device = defaults["device"]
    if getattr(args, "rate", None) is None:
        args.rate = defaults["rate"]
    return defaults
