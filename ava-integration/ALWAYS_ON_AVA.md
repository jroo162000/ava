# ALWAYS-ON AVA - Voice Assistant Setup

**AVA can now run in the background 24/7, listening for your voice commands!**

---

## 🚀 QUICK START

### Option 1: Run Once (Temporary)

**Double-click:**
```
start_ava_background.bat
```

This starts AVA in the background. Say **"AVA"** or **"Hey AVA"** to activate!

---

### Option 2: Auto-Start with Windows (Recommended)

**Double-click:**
```
install_ava_startup.bat
```

This makes AVA start automatically when you login to Windows!

After installation:
1. ✅ AVA will start automatically on every Windows login
2. 🔍 Look for the green circle icon in your system tray
3. 🎤 Say "AVA" anytime to activate

---

## 🎤 HOW TO USE

### Wake AVA:
Just say: **"AVA"** or **"Hey AVA"**

### Example Commands:
```
"AVA, what time is it?"
"AVA, what's my system health?"
"AVA, turn on the living room lights"
"AVA, read my emails"
"AVA, what's on my calendar today?"
"AVA, take a screenshot"
"AVA, check for security threats"
```

### Stop Listening:
- Right-click the system tray icon → "Stop Listening"
- Or say: "AVA, stop listening"

---

## 🎯 THREE MODES OF OPERATION

### 1. **System Tray Mode** (Recommended)
- ✅ Runs silently in background
- ✅ Green icon in system tray
- ✅ Right-click for controls
- ✅ Auto-starts with Windows

**Start with:**
```batch
pythonw ava_tray.pyw
```

### 2. **Console Mode**
- ✅ Shows conversation history
- ✅ Logs all interactions
- ✅ Good for debugging

**Start with:**
```batch
python ava_standalone.py
```

### 3. **Web Interface Mode** (Original)
- ✅ Full visual interface
- ✅ Rich UI with history
- ✅ Access from any device

**Start with:**
```batch
python ava_bridge.py
```
Then visit: http://localhost:5173

---

## 📊 SYSTEM TRAY ICON MEANINGS

🟢 **Green Circle** = AVA is listening
🔴 **Red Circle** = AVA stopped
⚪ **Gray Circle** = AVA ready (not listening yet)

---

## 🎛️ SYSTEM TRAY CONTROLS

**Right-click the tray icon:**
- **Start Listening** - Begin voice recognition
- **Stop Listening** - Pause voice recognition
- **Open Web Interface** - Launch browser UI
- **Quit** - Exit AVA completely

---

## 🔧 CONFIGURATION

### Wake Word
Default: **"AVA"** or **"Hey AVA"**

To change, edit `ava_standalone.py` or `ava_tray.pyw`:
```python
wake_word="jarvis"  # Change to any word you want
```

### Voice Settings
AVA uses your system's default microphone and speakers.

**To change:**
- Windows Settings → System → Sound
- Set your preferred microphone as default

---

## 🚀 STARTUP OPTIONS

### Method 1: Windows Startup Folder (Automatic)
Run `install_ava_startup.bat` - done!

### Method 2: Task Scheduler (Advanced)
1. Open Task Scheduler
2. Create Task: "AVA Assistant"
3. Trigger: At logon
4. Action: `pythonw.exe "C:\Users\USER 1\ava\ava-integration\ava_tray.pyw"`

### Method 3: Registry Run Key (Advanced)
Add to: `HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run`
```
Name: AVA
Value: pythonw.exe "C:\Users\USER 1\ava\ava-integration\ava_tray.pyw"
```

---

## 🛠️ TROUBLESHOOTING

### "AVA doesn't hear me"
- ✅ Check microphone permissions
- ✅ Ensure microphone is set as default
- ✅ Speak clearly and say "AVA" first
- ✅ Check console for errors

### "No system tray icon"
- Install dependencies: `pip install pystray pillow`
- Or use console mode: `python ava_standalone.py`

### "AVA won't start on login"
- Re-run `install_ava_startup.bat`
- Check: `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`
- Look for "AVA Assistant.lnk"

### "Can't find pythonw"
- Python is installed but pythonw might be missing
- Use regular Python: Edit batch file to use `python.exe` instead

---

## 📁 FILES CREATED

```
C:\Users\USER 1\ava\ava-integration\
  ├── ava_standalone.py          # Console mode AVA
  ├── ava_tray.pyw               # System tray AVA
  ├── start_ava_background.bat   # Quick start script
  ├── install_ava_startup.bat    # Windows startup installer
  └── ALWAYS_ON_AVA.md           # This file
```

---

## 🌟 FEATURES

### Always Listening ✅
- Background voice recognition
- Minimal CPU usage
- Works while other apps run

### Full Tool Access ✅
- All 25 JARVIS-level tools available
- IoT control, camera, security, email, calendar
- Remote device management
- Proactive monitoring

### GPT-5.2 Pro Intelligence ✅
- Latest AI model
- Multimodal capabilities
- Superior reasoning

### Privacy ✅
- Runs 100% locally
- No data sent except to OpenAI API (your account)
- Microphone only active when wake word detected

---

## 💡 ADVANCED USAGE

### Run Multiple Instances
You can run both modes simultaneously:
- System tray for voice (always-on)
- Web interface for visual tasks
- They share the same tools and memory

### Custom Wake Words
Edit the Python files to use different wake words for different purposes:
```python
# ava_standalone.py
wake_word="jarvis"      # For general tasks
wake_word="computer"    # For system tasks
wake_word="friday"      # For scheduling
```

### Logging
Console mode (`ava_standalone.py`) logs all conversations:
- See what AVA heard
- See what tools were used
- Track response times

---

## 🎊 YOU NOW HAVE TRUE JARVIS-STYLE ASSISTANT!

**Just like Tony Stark:**
- 🎤 "JARVIS, what's my schedule?"
- 🎤 "JARVIS, run diagnostics"
- 🎤 "JARVIS, what's the weather?"

**With AVA:**
- 🎤 "AVA, what's on my calendar?"
- 🎤 "AVA, check system health"
- 🎤 "AVA, turn on the lights"

---

## 📞 QUICK REFERENCE

| Task | Command |
|------|---------|
| **Start AVA (once)** | Double-click `start_ava_background.bat` |
| **Auto-start on login** | Double-click `install_ava_startup.bat` |
| **Wake AVA** | Say "AVA" or "Hey AVA" |
| **Stop listening** | Right-click tray → Stop Listening |
| **Open web UI** | Right-click tray → Open Web Interface |
| **Quit completely** | Right-click tray → Quit |

---

**AVA is now truly always-on, just like JARVIS!** 🤖✨

*Created: December 14, 2025*
