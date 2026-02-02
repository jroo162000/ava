#!/usr/bin/env python3
"""
AVA Crash Supervisor - Robust process supervision with crash containment.

Features:
1. Preflight checks before starting
2. Subprocess monitoring with crash detection
3. Exponential backoff restart
4. Safe mode fallback after repeated crashes
5. Crash report generation
"""
import os
import sys
import json
import time
import signal
import subprocess
import traceback
from datetime import datetime
from typing import Optional, Dict, List
from collections import deque

# Add parent and scripts to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from preflight_check import run_all_checks, get_preflight_summary

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_FILE = "ava_voice_config.json"
CANONICAL_RUNNER = "ava_standalone_realtime.py"

# Exit codes that indicate segfault or native crash
SEGFAULT_CODES = [-11, 139, -6, 134, 3221225477]  # SIGSEGV, SIGABRT, Windows access violation


class CrashSupervisor:
    """Supervises the voice runner process with crash containment."""

    def __init__(self, config_path: Optional[str] = None):
        self.config_path = config_path or os.path.join(PROJECT_ROOT, CONFIG_FILE)
        self.config = self._load_config()
        self.supervisor_cfg = self.config.get('crash_supervision', {})

        # Supervisor settings
        self.max_restarts = self.supervisor_cfg.get('max_restarts', 5)
        self.restart_window_sec = self.supervisor_cfg.get('restart_window_sec', 300)
        self.initial_backoff = self.supervisor_cfg.get('initial_backoff_sec', 3)
        self.max_backoff = self.supervisor_cfg.get('max_backoff_sec', 60)
        self.safe_mode_threshold = self.supervisor_cfg.get('safe_mode_after_crashes', 3)
        self.crash_report_dir = os.path.join(
            PROJECT_ROOT,
            self.supervisor_cfg.get('crash_report_dir', 'logs/crash_reports')
        )
        self.state_file = os.path.join(
            PROJECT_ROOT,
            self.supervisor_cfg.get('state_file', 'logs/runner_state.json')
        )

        # Runtime state
        self.crash_times: deque = deque(maxlen=self.max_restarts)
        self.current_backoff = self.initial_backoff
        self.restart_count = 0
        self.safe_mode_active = False
        self.process: Optional[subprocess.Popen] = None
        self.running = True
        self.log_buffer: deque = deque(maxlen=200)

        # Ensure directories exist
        os.makedirs(self.crash_report_dir, exist_ok=True)
        os.makedirs(os.path.dirname(self.state_file), exist_ok=True)

    def _load_config(self) -> Dict:
        """Load configuration file."""
        try:
            with open(self.config_path, 'r') as f:
                return json.load(f)
        except Exception as e:
            self.log(f"[WARN] Failed to load config: {e}")
            return {}

    def log(self, msg: str):
        """Log message with timestamp."""
        timestamp = datetime.now().strftime('%H:%M:%S')
        line = f"[{timestamp}] {msg}"
        print(line, flush=True)
        self.log_buffer.append(line)

    def run_preflight(self) -> bool:
        """Run preflight checks."""
        self.log("Running preflight checks...")
        all_passed, results = run_all_checks(verbose=False)

        for r in results:
            status = "OK" if r.passed else "XX"
            self.log(f"  [{status}] {r.name}: {r.message}")

        if all_passed:
            self.log("[OK] All preflight checks passed")
        else:
            critical = any(not r.passed and r.name in ["PyAudio", "Audio Devices"] for r in results)
            if critical:
                self.log("[XX] CRITICAL: Audio subsystem unavailable")
                return False
            else:
                self.log("[!!] Some checks failed, proceeding with caution")

        return True

    def get_runner_state(self) -> Dict:
        """Read the runner's state file if available."""
        try:
            if os.path.exists(self.state_file):
                with open(self.state_file, 'r') as f:
                    return json.load(f)
        except Exception as e:
            self.log(f"[WARN] Could not read runner state: {e}")
        return {}

    def get_effective_config(self) -> Dict:
        """Get config with safe mode overrides applied."""
        config = self._load_config()

        if self.safe_mode_active:
            safe_cfg = config.get('safe_mode', {})

            # Override barge-in
            if safe_cfg.get('disable_barge_in', True):
                if 'barge_in' in config:
                    config['barge_in']['enabled'] = False

            # Override realtime ASR if configured
            if safe_cfg.get('disable_realtime_asr', False):
                if 'asr' in config:
                    config['asr']['early_commit'] = {'enabled': False}

        return config

    def write_crash_report(self, exit_code: int, runtime_sec: float):
        """Write a crash report with diagnostic information."""
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        report_file = os.path.join(self.crash_report_dir, f"crash_{timestamp}.json")

        runner_state = self.get_runner_state()
        is_segfault = exit_code in SEGFAULT_CODES

        report = {
            "timestamp": datetime.now().isoformat(),
            "exit_code": exit_code,
            "is_segfault": is_segfault,
            "runtime_seconds": runtime_sec,
            "restart_count": self.restart_count,
            "safe_mode_active": self.safe_mode_active,
            "runner_state": runner_state,
            "audio_backend": {
                "sample_rate": self.config.get('audio', {}).get('playback_rate'),
                "input_device": self.config.get('audio', {}).get('input_device'),
                "output_device": self.config.get('audio', {}).get('output_device'),
            },
            "config_flags": {
                "barge_in_enabled": self.config.get('barge_in', {}).get('enabled'),
                "half_duplex": self.config.get('voice_stabilization', {}).get('half_duplex'),
                "echo_cancellation": self.config.get('echo_cancellation', {}).get('enabled'),
            },
            "preflight": get_preflight_summary(),
            "last_200_log_lines": list(self.log_buffer),
        }

        try:
            with open(report_file, 'w') as f:
                json.dump(report, f, indent=2)
            self.log(f"[CRASH] Report written: {report_file}")
            return report_file
        except Exception as e:
            self.log(f"[ERROR] Failed to write crash report: {e}")
            return None

    def should_enter_safe_mode(self) -> bool:
        """Check if we should enter safe mode based on crash history."""
        now = time.time()

        # Count crashes in the restart window
        recent_crashes = sum(1 for t in self.crash_times if now - t < self.restart_window_sec)

        return recent_crashes >= self.safe_mode_threshold

    def should_give_up(self) -> bool:
        """Check if we've exceeded max restarts in the window."""
        now = time.time()
        recent_crashes = sum(1 for t in self.crash_times if now - t < self.restart_window_sec)
        return recent_crashes >= self.max_restarts

    def start_runner(self) -> subprocess.Popen:
        """Start the voice runner subprocess."""
        runner_path = os.path.join(PROJECT_ROOT, CANONICAL_RUNNER)

        # Build environment with safe mode flag
        env = os.environ.copy()
        if self.safe_mode_active:
            env['AVA_SAFE_MODE'] = '1'
            self.log("[SAFE_MODE] Starting runner in safe mode")

        return subprocess.Popen(
            [sys.executable, runner_path],
            cwd=PROJECT_ROOT,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            bufsize=1,
            universal_newlines=True
        )

    def monitor_process(self, process: subprocess.Popen) -> int:
        """Monitor process and capture output."""
        start_time = time.time()

        try:
            while process.poll() is None:
                if process.stdout:
                    line = process.stdout.readline()
                    if line:
                        line = line.rstrip()
                        self.log_buffer.append(line)
                        print(line, flush=True)

            # Process exited, read remaining output
            if process.stdout:
                for line in process.stdout:
                    line = line.rstrip()
                    self.log_buffer.append(line)
                    print(line, flush=True)

        except Exception as e:
            self.log(f"[ERROR] Monitor error: {e}")

        runtime = time.time() - start_time
        exit_code = process.returncode or 0

        return exit_code

    def handle_crash(self, exit_code: int, runtime_sec: float):
        """Handle a crash event."""
        is_segfault = exit_code in SEGFAULT_CODES
        crash_type = "SEGFAULT" if is_segfault else "CRASH"

        self.log(f"[{crash_type}] Runner exited with code {exit_code} after {runtime_sec:.1f}s")

        # Record crash time
        self.crash_times.append(time.time())
        self.restart_count += 1

        # Write crash report
        self.write_crash_report(exit_code, runtime_sec)

        # Check if we should enter safe mode
        if not self.safe_mode_active and self.should_enter_safe_mode():
            self.log("[SAFE_MODE] Entering safe mode after repeated crashes")
            self.safe_mode_active = True
            self.current_backoff = self.initial_backoff  # Reset backoff on safe mode entry

        # Check if we should give up
        if self.should_give_up():
            self.log("[FATAL] Max restarts exceeded, giving up")
            return False

        # Apply backoff
        self.log(f"[RESTART] Waiting {self.current_backoff}s before restart...")
        time.sleep(self.current_backoff)

        # Increase backoff for next time (exponential)
        self.current_backoff = min(self.current_backoff * 2, self.max_backoff)

        return True

    def run(self):
        """Main supervisor loop."""
        self.log("=" * 60)
        self.log("AVA CRASH SUPERVISOR")
        self.log("=" * 60)

        # Run preflight
        if not self.run_preflight():
            self.log("[FATAL] Preflight checks failed, cannot start")
            return 1

        self.log(f"Supervising: {CANONICAL_RUNNER}")
        self.log(f"Max restarts: {self.max_restarts} in {self.restart_window_sec}s")
        self.log(f"Safe mode after: {self.safe_mode_threshold} crashes")
        self.log("-" * 60)

        # Register signal handlers
        def signal_handler(sig, frame):
            self.log("[SIGNAL] Shutdown requested")
            self.running = False
            if self.process:
                self.process.terminate()

        signal.signal(signal.SIGINT, signal_handler)
        signal.signal(signal.SIGTERM, signal_handler)

        while self.running:
            start_time = time.time()

            try:
                self.log(f"[START] Starting runner (attempt #{self.restart_count + 1})")
                self.process = self.start_runner()
                exit_code = self.monitor_process(self.process)
                runtime = time.time() - start_time

                if exit_code == 0:
                    self.log("[EXIT] Clean exit, stopping supervisor")
                    return 0

                # Handle the crash
                if not self.handle_crash(exit_code, runtime):
                    return 1

            except Exception as e:
                self.log(f"[ERROR] Supervisor error: {e}")
                traceback.print_exc()
                time.sleep(self.initial_backoff)

        return 0


def simulate_crash(exit_code: int = 1):
    """
    Simulate a crash for testing the supervisor.

    Usage: python crash_supervisor.py --simulate-crash [exit_code]
    """
    print(f"[TEST] Simulating crash with exit code {exit_code}")
    time.sleep(1)  # Brief runtime
    os._exit(exit_code)


def main():
    """Entry point."""
    if len(sys.argv) > 1:
        if sys.argv[1] == '--simulate-crash':
            code = int(sys.argv[2]) if len(sys.argv) > 2 else 1
            simulate_crash(code)
        elif sys.argv[1] == '--preflight-only':
            from preflight_check import run_all_checks
            passed, _ = run_all_checks(verbose=True)
            sys.exit(0 if passed else 1)
        elif sys.argv[1] == '--help':
            print("AVA Crash Supervisor")
            print()
            print("Usage:")
            print("  python crash_supervisor.py              Run supervisor")
            print("  python crash_supervisor.py --preflight-only  Run preflight checks only")
            print("  python crash_supervisor.py --simulate-crash [code]  Simulate crash")
            sys.exit(0)

    supervisor = CrashSupervisor()
    sys.exit(supervisor.run())


if __name__ == "__main__":
    main()
