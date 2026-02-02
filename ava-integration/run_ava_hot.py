import os
import sys
import time
import subprocess
from pathlib import Path
import json


# Basic, predictable hot runner:
# - Restarts the AVA Python runtime when files under ava-integration change
# - Restarts the Node server when files under ava-server change
# - No health polling, no extra supervision logic

WATCH_EXTS = {
    ".py", ".json", ".yaml", ".yml", ".txt", ".env", ".ini", ".toml", ".cfg",
}
EXCLUDE_DIRS = {"__pycache__", ".git", ".venv", "node_modules"}


def read_voice_config(base: Path):
    cfg_path = base / "ava_voice_config.json"
    try:
        with open(cfg_path, "r", encoding="utf-8") as f:
            return json.load(f) or {}
    except Exception:
        return {}


def list_integration_files(base: Path):
    files = []
    for fp in base.rglob("*"):
        try:
            if any(part in EXCLUDE_DIRS for part in fp.parts):
                continue
            if fp.is_file():
                if fp.suffix.lower() in WATCH_EXTS and fp.name != "run_ava_hot.py":
                    files.append(str(fp.resolve()))
        except Exception:
            pass
    return list(dict.fromkeys(files))


def list_server_files(server_base: Path):
    files = []
    if not server_base.exists():
        return files
    for fp in server_base.rglob("*"):
        try:
            if any(part in EXCLUDE_DIRS for part in fp.parts):
                continue
            if fp.is_file() and fp.suffix.lower() in {".js", ".json", ".mjs"}:
                files.append(str(fp.resolve()))
        except Exception:
            pass
    return list(dict.fromkeys(files))


def snapshot(paths):
    snaps = {}
    for p in paths:
        try:
            st = os.stat(p)
            snaps[p] = (st.st_mtime, st.st_size)
        except OSError:
            snaps[p] = (0, 0)
    return snaps


def changed(prev, curr):
    for k, v in curr.items():
        if k not in prev or prev[k] != v:
            return k
    for k in prev:
        if k not in curr:
            return k
    return None


def spawn_python(py_exe: str, script: str):
    env = os.environ.copy()
    env.setdefault("PYTHONUNBUFFERED", "1")
    env.setdefault("PYTHONIOENCODING", "utf-8")
    return subprocess.Popen([py_exe, "-u", script], cwd=str(Path(script).parent), env=env)


def spawn_server(server_dir: Path):
    env = os.environ.copy()
    try:
        if (server_dir / "src" / "server.js").exists():
            return subprocess.Popen(["node", "src/server.js"], cwd=str(server_dir), env=env)
        else:
            return subprocess.Popen(["node", "server.js"], cwd=str(server_dir), env=env)
    except Exception:
        return None


def terminate(proc: subprocess.Popen, timeout: float = 5.0):
    if proc is None:
        return
    if proc.poll() is not None:
        return
    try:
        proc.terminate()
    except Exception:
        pass
    t0 = time.time()
    while time.time() - t0 < timeout:
        if proc.poll() is not None:
            return
        time.sleep(0.1)
    try:
        proc.kill()
    except Exception:
        pass


def main():
    base = Path(__file__).resolve().parent
    py_exe = sys.executable
    target = str((base / "ava_standalone_realtime.py").resolve())

    # Determine server directory (config override or default next to repo)
    cfg = read_voice_config(base)
    default_server_dir = (base / "ava-server") if (base / "ava-server").exists() else (base.parent / "ava-server")
    server_dir = Path(cfg.get("server_dir", str(default_server_dir)))

    # Initial file lists and snapshots
    integ_files = list_integration_files(base)
    integ_mtimes = snapshot(integ_files)
    server_files = list_server_files(server_dir)
    server_mtimes = snapshot(server_files)

    # Start processes
    print(f"[hot] Starting {target}")
    py_proc = spawn_python(py_exe, target)
    node_proc = None
    if server_dir.exists():
        node_proc = spawn_server(server_dir)
        if node_proc:
            print(f"[hot] Started server.js (PID {node_proc.pid})")

    try:
        while True:
            time.sleep(1.0)

            # Manual restart trigger
            flag = base / "ava_restart.flag"
            if flag.exists():
                print("[hot] Manual restart requested via ava_restart.flag")
                try:
                    flag.unlink()
                except Exception:
                    pass
                terminate(py_proc)
                time.sleep(0.2)
                py_proc = spawn_python(py_exe, target)
                # Restart Node server too if present
                if node_proc and node_proc.poll() is None:
                    try:
                        node_proc.terminate()
                    except Exception:
                        pass
                    time.sleep(0.5)
                if server_dir.exists():
                    node_proc = spawn_server(server_dir)
                    if node_proc:
                        print(f"[hot] Started server.js (PID {node_proc.pid})")
                continue

            # Rebuild file lists (new files can appear)
            curr_integ_files = list_integration_files(base)
            curr_server_files = list_server_files(server_dir)

            # Detect integration changes
            curr_integ = snapshot(curr_integ_files)
            diff = changed(integ_mtimes, curr_integ)
            if diff:
                print(f"[hot] Change detected in {diff}. Restarting Python runtime.")
                terminate(py_proc)
                time.sleep(0.2)
                py_proc = spawn_python(py_exe, target)
                integ_mtimes = curr_integ
                # Update list in case of file add/remove
                integ_files = curr_integ_files

            # Detect server changes
            curr_server = snapshot(curr_server_files)
            sdiff = changed(server_mtimes, curr_server)
            if sdiff:
                print(f"[hot] Server change detected in {sdiff}. Restarting server.")
                if node_proc and node_proc.poll() is None:
                    try:
                        node_proc.terminate()
                    except Exception:
                        pass
                    time.sleep(0.5)
                if server_dir.exists():
                    node_proc = spawn_server(server_dir)
                    if node_proc:
                        print(f"[hot] Started server.js (PID {node_proc.pid})")
                server_mtimes = curr_server
                server_files = curr_server_files

            # If Python child crashed, restart with backoff
            if py_proc and py_proc.poll() is not None:
                code = py_proc.returncode
                print(f"[hot] Python runtime exited with code {code}. Restarting...")
                time.sleep(1.0)
                py_proc = spawn_python(py_exe, target)

            # If Node server died, try to relaunch (best-effort)
            if node_proc and node_proc.poll() is not None and server_dir.exists():
                print("[hot] server.js exited. Restarting...")
                time.sleep(0.5)
                node_proc = spawn_server(server_dir)
                if node_proc:
                    print(f"[hot] Started server.js (PID {node_proc.pid})")

    except KeyboardInterrupt:
        print("\n[hot] Stopping...")
        terminate(py_proc)
        if node_proc:
            terminate(node_proc)


if __name__ == "__main__":
    main()

