"""AVA Voice Watchdog - Auto-restart voice client on crash"""
import subprocess
import sys
import time
from datetime import datetime

def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)

def main():
    log("AVA Voice Watchdog started")
    log("Will auto-restart voice client on crash")

    restart_count = 0
    while True:
        restart_count += 1
        log(f"Starting voice client (attempt #{restart_count})...")

        try:
            result = subprocess.run(
                [sys.executable, "ava_standalone_realtime.py"],
                cwd=r"C:\Users\USER 1\ava-integration"
            )
            exit_code = result.returncode
            log(f"Voice client exited with code {exit_code}")
        except Exception as e:
            log(f"Error: {e}")
            exit_code = -1

        if exit_code == 0:
            log("Clean exit, stopping watchdog")
            break

        log("Restarting in 3 seconds...")
        time.sleep(3)

if __name__ == "__main__":
    main()
