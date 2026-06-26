import argparse
import importlib.util
import json
import sys
from pathlib import Path


ROOT = Path(__file__).parent.parent
DEFAULTS_PATH = ROOT / "tools" / "voice_lab" / "live_input_defaults.py"


def load_defaults():
    spec = importlib.util.spec_from_file_location("live_input_defaults", DEFAULTS_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_apply_configured_live_input_fills_missing_device_and_rate(tmp_path):
    defaults = load_defaults()
    config_path = tmp_path / "ava_voice_config.json"
    config_path.write_text(
        json.dumps({"audio": {"input_device": 2, "input_sample_rate": 44100, "input_device_name": "Realtek"}}),
        encoding="utf-8",
    )
    args = argparse.Namespace(device=None, rate=None)

    result = defaults.apply_configured_live_input(args, config_path)

    assert args.device == 2
    assert args.rate == 44100
    assert result["source"] == "ava_voice_config.json"
    assert result["device_name"] == "Realtek"


def test_apply_configured_live_input_preserves_explicit_overrides(tmp_path):
    defaults = load_defaults()
    config_path = tmp_path / "ava_voice_config.json"
    config_path.write_text(
        json.dumps({"audio": {"input_device": 2, "input_sample_rate": 44100}}),
        encoding="utf-8",
    )
    args = argparse.Namespace(device=15, rate=48000)

    result = defaults.apply_configured_live_input(args, config_path)

    assert args.device == 15
    assert args.rate == 48000
    assert result["device"] == 2
    assert result["rate"] == 44100


def test_configured_live_input_falls_back_when_config_missing(tmp_path):
    defaults = load_defaults()

    result = defaults.load_configured_live_input(tmp_path / "missing.json")

    assert result["device"] == 14
    assert result["rate"] == 48000
    assert result["source"] == "fallback"
