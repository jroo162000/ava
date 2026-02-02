# How to Stop Old TTS Standalone and Use Only Realtime Voice

**Problem**: Both standalone versions are running simultaneously
- **OLD**: `ava_standalone.py` - TTS with wake word "AVA"
- **NEW**: `ava_standalone_realtime.py` - Realtime Voice (always listening)

---

## Quick Fix: Stop the Old Standalone

### Method 1: Task Manager
1. Press `Ctrl + Shift + Esc` to open Task Manager
2. Go to "Details" tab
3. Look for Python processes running `ava_standalone.py`
4. Right-click → End Task

### Method 2: Command Line
```bash
# Find Python processes
tasklist | findstr python

# Kill specific process by PID
taskkill /PID <process_id> /F

# Or kill all Python processes (WARNING: will stop ALL Python)
taskkill /IM python.exe /F
```

### Method 3: System Tray
- If you started it from system tray (ava_tray.pyw)
- Look for AVA icon in system tray (bottom-right)
- Right-click → Exit

---

## Which One Should You Use?

| Feature | OLD (ava_standalone.py) | NEW (ava_standalone_realtime.py) |
|---------|-------------------------|----------------------------------|
| **Wake Word** | Required ("AVA") | Not needed - always listening |
| **Voice** | TTS (pyttsx3/OpenAI TTS) | Realtime API (sage voice) |
| **Latency** | 3-5 seconds | <1 second |
| **Audio Quality** | Choppy with TTS | Smooth, continuous |
| **Can Interrupt** | No | Yes |
| **Tool Access** | 20 tools | 20 tools |
| **Recommendation** | ⛔ Old method | ✅ **USE THIS** |

---

## Start Only the New Realtime Standalone

**Double-click this file**:
```
C:\Users\USER 1\ava-integration\start_ava_standalone_realtime.bat
```

**Or command line**:
```bash
cd "C:\Users\USER 1\ava-integration"
python ava_standalone_realtime.py
```

---

## Prevent Both from Running on Startup

### Check Windows Startup
1. Press `Win + R`
2. Type: `shell:startup`
3. Look for any AVA shortcuts
4. Delete OLD standalone shortcuts
5. (Optional) Add NEW standalone shortcut

### Check Task Scheduler
1. Press `Win + R`
2. Type: `taskschd.msc`
3. Look for AVA tasks
4. Disable OLD standalone tasks

---

## Files You Can Delete (Optional)

Once you're sure you only want Realtime Voice, you can delete:

```
C:\Users\USER 1\ava-integration\ava_standalone.py  ← OLD TTS version
C:\Users\USER 1\ava-integration\ava_tray.pyw       ← OLD TTS tray version
```

**Keep these**:
```
C:\Users\USER 1\ava-integration\ava_standalone_realtime.py  ✅ NEW
C:\Users\USER 1\ava-integration\start_ava_standalone_realtime.bat  ✅
```

---

## Verify Only One is Running

After stopping the old one, say something - you should hear:
- ✅ **ONE response** with smooth sage voice (Realtime)
- ❌ **NOT TWO responses** with different voices

---

## Summary

**Stop**: `ava_standalone.py` (OLD TTS with wake word)
**Use**: `ava_standalone_realtime.py` (NEW Realtime Voice)

The new Realtime Voice standalone is:
- Faster (<1s latency vs 3-5s)
- Smoother audio (fixed choppy playback)
- Always listening (no wake word needed)
- Same 20 tools
- Better overall experience

---

*Just close/kill the old Python process running ava_standalone.py and keep only the realtime version running!*
