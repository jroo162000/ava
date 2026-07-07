"""AVA gaze tracker — camera -> gaze.target events, fully autonomous.

Watches the webcam with OpenCV's Haar frontal-face detector (no new heavy
deps; ships inside opencv), tracks the largest face's center, EMA-smooths it,
and posts `gaze.target` events (~8Hz) to the AVA server so her eyes (and 60%
of her head) follow Jelani's REAL position. Core3D releases to autonomous idle
whenever no event has arrived within its hold window, so simply not posting
(no face / camera busy) hands control back gracefully.

Runs as a sidecar of the voice stack: start_local_voice.bat launches it, a
localhost socket lock keeps it single-instance, and it survives server
restarts (posts just fail silently until the server is back).

Env knobs:
  AVA_GAZE_CAM     camera index (default 0)
  AVA_GAZE_MIRROR  1 (default) = she looks toward where you ARE relative to
                   the screen (mirror-style); 0 flips the x axis
  AVA_GAZE_OFF     1 = exit immediately (kill switch)
"""

import json
import os
import socket
import sys
import time
import urllib.request

SERVER = os.environ.get("AVA_SERVER_URL", "http://127.0.0.1:5051").rstrip("/")
# Shared live frame: the tracker is the ONE owner of the webcam; it publishes
# its latest frame here so camera_ops (snapshots, "what do you see") can read
# it instead of fighting over the device. Atomic replace = readers never see a
# torn file. AVA_GAZE_FRAME_OFF=1 disables publishing.
FRAME_PATH = os.path.join(os.path.expanduser("~"), ".cmpuse", "camera_live.jpg")
FRAME_EVERY_S = 0.5
LOCK_PORT = 5077
POST_HZ = 8.0
HOLD_MS = 3500          # bridge brief detection dropouts instead of releasing to idle
COAST_S = 2.5           # keep posting the last position this long after losing the face
BASELINE_TAU = 120.0    # seconds: her 'center' auto-calibrates to where you usually are


def _api_token() -> str:
    tok = (os.environ.get("AVA_API_TOKEN") or "").strip()
    if tok:
        return tok
    try:
        env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
        with open(env_path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line.startswith("AVA_API_TOKEN="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    except Exception:
        pass
    return ""


def _post(events) -> None:
    body = json.dumps(events).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    tok = _api_token()
    if tok:
        headers["Authorization"] = "Bearer " + tok
    req = urllib.request.Request(url=SERVER + "/voice/event/batch", data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=2) as resp:
        resp.read(64)


def main() -> int:
    if os.environ.get("AVA_GAZE_OFF") == "1":
        return 0
    # single instance
    lock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        lock.bind(("127.0.0.1", LOCK_PORT))
        lock.listen(1)
    except OSError:
        print("gaze-tracker: another instance holds the lock; exiting")
        return 0

    import cv2  # late import: opencv load is slow

    cam_idx = int(os.environ.get("AVA_GAZE_CAM", "0") or 0)
    mirror = os.environ.get("AVA_GAZE_MIRROR", "1").strip().lower() not in {"0", "false", "no", "off"}
    cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    profile = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_profileface.xml")
    if cascade.empty():
        print("gaze-tracker: haar cascade missing")
        return 1

    cap = None
    ema_x = ema_y = None
    base_x = base_y = None
    publish_frames = os.environ.get("AVA_GAZE_FRAME_OFF") != "1"
    last_publish = 0.0
    try:
        os.makedirs(os.path.dirname(FRAME_PATH), exist_ok=True)
    except Exception:
        publish_frames = False
    last_face = 0.0
    interval = 1.0 / POST_HZ
    fails = 0
    while True:
        t0 = time.time()
        try:
            if cap is None or not cap.isOpened():
                if cap is not None:
                    cap.release()
                cap = cv2.VideoCapture(cam_idx, cv2.CAP_DSHOW if os.name == "nt" else 0)
                # 720p best-effort: detection downsamples anyway, and the shared
                # snapshot frame benefits from the extra resolution.
                cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
                cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
                if not cap.isOpened():
                    time.sleep(5)
                    continue
            ok, frame = cap.read()
            if not ok or frame is None:
                fails += 1
                if fails > 20:            # camera unplugged / grabbed by another app
                    cap.release()
                    cap = None
                    fails = 0
                    time.sleep(5)
                time.sleep(interval)
                continue
            fails = 0
            # publish the shared live frame (atomic tmp+replace)
            now_ts = time.time()
            if publish_frames and now_ts - last_publish >= FRAME_EVERY_S:
                last_publish = now_ts
                try:
                    # tmp name MUST keep .jpg: cv2.imwrite picks the codec from
                    # the extension and silently fails on ".tmp"
                    tmp = FRAME_PATH.replace("camera_live.jpg", "camera_live_tmp.jpg")
                    if cv2.imwrite(tmp, frame, [int(cv2.IMWRITE_JPEG_QUALITY), 85]):
                        os.replace(tmp, FRAME_PATH)
                except Exception:
                    pass
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            small = cv2.resize(gray, (320, 240))
            faces = cascade.detectMultiScale(small, scaleFactor=1.12, minNeighbors=4, minSize=(28, 28))
            if not len(faces) and not profile.empty():
                # frontal missed (head turned): try profile, then mirrored profile
                faces = profile.detectMultiScale(small, scaleFactor=1.15, minNeighbors=4, minSize=(28, 28))
                if not len(faces):
                    flipped = cv2.flip(small, 1)
                    ff = profile.detectMultiScale(flipped, scaleFactor=1.15, minNeighbors=4, minSize=(28, 28))
                    if len(ff):
                        faces = [(320 - x - w, y, w, h) for (x, y, w, h) in ff]
            if len(faces):
                x, y, w, h = max(faces, key=lambda f: f[2] * f[3])
                cx = (x + w / 2.0) / 320.0
                cy = (y + h / 2.0) / 240.0
                gx = (0.5 - cx) * 2.0 if mirror else (cx - 0.5) * 2.0
                gy = (0.5 - cy) * 2.0
                # Auto-calibrating center: cameras rarely sit dead-on, so her "front"
                # is the slow average of where the face actually is; she reacts to
                # DEVIATION from that. (Jelani stood dead center and read -0.41 raw.)
                if base_x is None:
                    base_x, base_y = gx, gy
                else:
                    k = min(1.0, interval / BASELINE_TAU)
                    base_x += (gx - base_x) * k
                    base_y += (gy - base_y) * k
                gx = max(-1.0, min(1.0, (gx - base_x) * 2.0))
                gy = max(-1.0, min(1.0, (gy - base_y) * 1.6))
                ema_x = gx if ema_x is None else ema_x * 0.6 + gx * 0.4
                ema_y = gy if ema_y is None else ema_y * 0.6 + gy * 0.4
                last_face = time.time()
                try:
                    _post([{
                        "type": "gaze.target",
                        "data": {"x": round(ema_x, 3), "y": round(ema_y, 3), "hold_ms": HOLD_MS, "source": "camera"},
                        "timestamp": time.time(),
                        "source": "gaze-tracker",
                    }])
                except Exception:
                    pass  # server restarting; keep tracking
            elif ema_x is not None and time.time() - last_face <= COAST_S:
                # brief dropout (head turned / blur): coast on the last position
                try:
                    _post([{
                        "type": "gaze.target",
                        "data": {"x": round(ema_x, 3), "y": round(ema_y, 3), "hold_ms": HOLD_MS, "source": "camera"},
                        "timestamp": time.time(),
                        "source": "gaze-tracker",
                    }])
                except Exception:
                    pass
            elif time.time() - last_face > COAST_S:
                ema_x = ema_y = None       # face truly gone: stop posting, she returns to idle
        except KeyboardInterrupt:
            return 0
        except Exception:
            time.sleep(1)
        dt = time.time() - t0
        if dt < interval:
            time.sleep(interval - dt)


if __name__ == "__main__":
    sys.exit(main())
