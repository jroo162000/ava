import importlib.util
import sys
from pathlib import Path


ROOT = Path(__file__).parent.parent
PROBE_PATH = ROOT / "tools" / "voice_lab" / "11_live_mic_level_probe.py"


def load_probe():
    spec = importlib.util.spec_from_file_location("live_mic_level_probe", PROBE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_live_mic_probe_uses_bounded_wall_clock_reads_and_runner_style_ranking():
    src = PROBE_PATH.read_text(encoding="utf-8")

    assert "expected_reads = max(1, int(math.ceil(duration_sec / frame_sec)))" in src
    assert "wall_elapsed_sec" in src
    assert "confirm_frames" in src
    assert '"wasapi" in host_low' in src
    assert '"host_api": host_name' in src


def test_live_mic_probe_percentile_helper():
    probe = load_probe()

    assert probe._percentile([1, 2, 3, 4, 5], 50) == 3
    assert probe._percentile([1, 2, 3, 4, 5], 95) == 5
