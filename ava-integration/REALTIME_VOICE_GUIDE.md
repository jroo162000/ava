# AVA Realtime Voice Chat - Complete Guide

**Date**: December 14, 2025
**Status**: ✅ Production Ready
**Model**: gpt-4o-realtime-preview
**Voice**: sage (default)

---

## Overview

AVA Realtime Voice Chat enables natural, bidirectional voice conversations with sub-second latency using OpenAI's Realtime API. This is a major upgrade from the traditional TTS + Transcription approach.

###  Traditional vs Realtime

| Feature | Traditional (TTS + Whisper) | Realtime Voice API |
|---------|----------------------------|-------------------|
| **Latency** | 3-5 seconds | <1 second |
| **Method** | Sequential (record → transcribe → think → speak) | Streaming (bidirectional) |
| **Interruptions** | No | Yes ✅ |
| **Natural Flow** | Turn-based | Continuous ✅ |
| **Function Calling** | Separate step | During conversation ✅ |
| **Voice Activity Detection** | Manual | Automatic ✅ |

---

## Quick Start

### Method 1: Double-click Launcher
```
1. Navigate to: C:\Users\USER 1\ava-integration\
2. Double-click: start_realtime_voice.bat
3. Start talking to AVA!
```

### Method 2: Command Line
```bash
cd "C:\Users\USER 1\ava-integration"
python realtime_voice_chat.py
```

### Method 3: Python Script
```python
import asyncio
from realtime_voice_chat import RealtimeVoiceChat

chat = RealtimeVoiceChat()
asyncio.run(chat.run())
```

---

## Features

### 1. Natural Conversations
- **No wake word needed** - Just start talking
- **Voice Activity Detection** - Automatically detects when you're done speaking
- **Sub-second latency** - Feels like talking to a real person
- **Interruptions** - Can interrupt AVA mid-sentence

### 2. Function Calling
AVA can call tools **during the conversation** without breaking flow:

**Available Functions**:
- `get_calendar_events` - Check your schedule
- `control_lights` - Smart home control
- `check_weather` - Weather information
- `send_email` - Email management

### 3. Intelligent Features
- **Transcription display** - See what you said and AVA's response
- **Session persistence** - Maintains conversation context
- **Error handling** - Graceful recovery from connection issues
- **Audio streaming** - Real-time audio playback

---

## How It Works

### Architecture

```
┌─────────────┐         WebSocket          ┌──────────────────┐
│             │◄──────────────────────────►│                  │
│  Your Mic   │   PCM16 Audio @ 24kHz      │  OpenAI Realtime │
│             │                             │       API        │
└─────────────┘                             │  (gpt-4o-real    │
                                            │   time-preview)  │
┌─────────────┐                             │                  │
│             │◄────────────────────────────│                  │
│  Speakers   │   PCM16 Audio @ 24kHz      └──────────────────┘
│             │                                      ▲
└─────────────┘                                      │
                                                     │
                                            ┌────────▼─────────┐
                                            │   AVA Tools      │
                                            │  - Calendar      │
                                            │  - Email         │
                                            │  - Smart Home    │
                                            │  - Weather       │
                                            └──────────────────┘
```

### Event Flow

1. **Initialization**
   - Connect to WebSocket: `wss://api.openai.com/v1/realtime`
   - Configure session with AVA's personality and tools
   - Start microphone stream

2. **Conversation Loop**
   - You speak → Audio streamed to API
   - Voice Activity Detection triggers processing
   - GPT-4o processes with context
   - Audio response streamed back
   - Played in real-time

3. **Function Calling** (if needed)
   - GPT-4o identifies tool need
   - Sends function call request
   - AVA executes tool
   - Result integrated into response
   - Continues speaking

---

## Example Conversations

### Example 1: Calendar Check
```
You: "Hey AVA, what's on my calendar today?"

AVA: [calls get_calendar_events()]
     "You have three events today: Team meeting at 10 AM,
     lunch with Sarah at noon, and project review at 3 PM."
```

### Example 2: Smart Home Control
```
You: "Turn off the living room lights"

AVA: [calls control_lights(action="off", room="living room")]
     "The living room lights are now off."
```

### Example 3: Multi-step Task
```
You: "What's the weather like and should I bring an umbrella?"

AVA: [calls check_weather()]
     "It's currently 65 degrees and partly cloudy.
     There's a 30% chance of rain this afternoon,
     so bringing an umbrella wouldn't hurt."
```

### Example 4: Interruption
```
You: "Can you tell me about—"
AVA: "Of course! Let me explain the quantum physics of—"
You: [interrupting] "Actually, just tell me the time"
AVA: [stops mid-sentence] "It's 2:47 PM."
```

---

## Configuration

### Session Settings (in realtime_voice_chat.py)

```python
{
    "modalities": ["text", "audio"],  # Both text and audio
    "voice": "sage",                   # AVA's voice (changeable)
    "input_audio_format": "pcm16",    # 16-bit PCM
    "output_audio_format": "pcm16",
    "sample_rate": 24000,              # 24kHz required
    "turn_detection": {
        "type": "server_vad",          # Voice Activity Detection
        "threshold": 0.5,               # Sensitivity
        "prefix_padding_ms": 300,       # Pre-speech buffer
        "silence_duration_ms": 500      # Silence before processing
    }
}
```

### Changing Voice

Edit `realtime_voice_chat.py` line ~94:
```python
"voice": "coral",  # Options: sage, coral, ash, nova, alloy, echo, fable, onyx, shimmer
```

### Adjusting VAD Sensitivity

More sensitive (catches quick speech):
```python
"silence_duration_ms": 300  # Process faster
```

Less sensitive (wait for longer pauses):
```python
"silence_duration_ms": 800  # Wait longer
```

---

## Troubleshooting

### Issue: No audio input detected
**Solution**: Check microphone permissions
```bash
# Windows: Settings → Privacy → Microphone
# Ensure Python has microphone access
```

### Issue: Echo or feedback
**Solution**: Use headphones or reduce speaker volume

### Issue: Connection errors
**Solution**: Check API key and internet connection
```python
# Verify API key
import os
from cmpuse.secrets import load_into_env
load_into_env()
print(os.getenv("OPENAI_API_KEY"))
```

### Issue: High latency
**Possible causes**:
- Slow internet connection
- High CPU usage
- Background processes

**Solution**: Close unnecessary apps, check network speed

### Issue: Microphone not found
**Solution**: List available audio devices
```python
import pyaudio
p = pyaudio.PyAudio()
for i in range(p.get_device_count()):
    info = p.get_device_info_by_index(i)
    print(f"{i}: {info['name']}")
```

---

## Advanced Usage

### Custom Tool Integration

Add your own tools to the conversation:

```python
def get_tool_definitions(self):
    return [
        {
            "type": "function",
            "name": "your_custom_tool",
            "description": "What your tool does",
            "parameters": {
                "type": "object",
                "properties": {
                    "param1": {
                        "type": "string",
                        "description": "Parameter description"
                    }
                },
                "required": ["param1"]
            }
        }
    ]

async def handle_tool_call(self, function_name, arguments):
    if function_name == "your_custom_tool":
        # Your implementation
        result = do_something(arguments)
        return {"status": "ok", "result": result}
```

### Recording Conversations

Save conversation audio:

```python
# Add to RealtimeVoiceChat class
self.recording = []

# In play_audio_output method
self.recording.append(audio_data)

# Save at end
def save_conversation(self, filename):
    with wave.open(filename, 'wb') as wf:
        wf.setnchannels(CHANNELS)
        wf.setsampwidth(self.audio.get_sample_size(FORMAT))
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(b''.join(self.recording))
```

### Conversation Analytics

Track conversation metrics:

```python
# Add metrics tracking
self.metrics = {
    "turns": 0,
    "user_words": 0,
    "ava_words": 0,
    "function_calls": 0,
    "duration": 0
}

# Update in event handlers
# Display at end of conversation
```

---

## Performance

### Latency Breakdown

| Component | Time |
|-----------|------|
| Audio capture | ~20ms |
| Network transmission | ~50-100ms |
| GPT-4o processing | ~200-500ms |
| Audio response | ~50-100ms |
| **Total** | **~500ms-1s** |

Compare to traditional:
- Whisper transcription: ~1-2s
- GPT thinking: ~2-3s
- TTS generation: ~1-2s
- **Total**: ~4-7s

### Cost

Realtime API pricing (as of Dec 2024):
- **Audio input**: $0.100 / minute
- **Audio output**: $0.200 / minute
- **Text tokens**: Standard GPT-4o pricing

**Example**: 10-minute conversation ≈ $3.00

---

## Comparison with Other Modes

### When to Use Each Mode

**Realtime Voice (realtime_voice_chat.py)**:
- ✅ Natural conversations
- ✅ Quick back-and-forth
- ✅ Hands-free interaction
- ✅ When latency matters
- ❌ Higher cost
- ❌ Requires good internet

**Traditional TTS (ava_standalone.py, ava_tray.pyw)**:
- ✅ More reliable
- ✅ Works offline (local TTS)
- ✅ Lower cost
- ✅ Better for complex tasks
- ❌ Higher latency
- ❌ No interruptions

**Web Interface (ava_bridge.py + ava_client)**:
- ✅ Visual feedback
- ✅ File uploads
- ✅ Rich formatting
- ✅ Multi-modal
- ❌ Requires browser
- ❌ Not hands-free

---

## Tips for Best Results

### 1. Environment
- **Quiet room** - Minimize background noise
- **Good microphone** - Use a quality mic
- **Headphones** - Prevent echo/feedback

### 2. Speaking
- **Clear speech** - Enunciate clearly
- **Natural pace** - Don't speak too fast
- **Pauses** - Pause briefly between thoughts
- **Close to mic** - Stay within 6-12 inches

### 3. Commands
- **Be specific** - "Turn off bedroom lights" vs "lights off"
- **Natural language** - Speak naturally, not robot-like
- **Context** - Reference previous conversation

### 4. Performance
- **Close apps** - Free up CPU/memory
- **Good internet** - 5+ Mbps recommended
- **Wired connection** - Better than WiFi for stability

---

## Integration with Other AVA Modes

### Hybrid Usage

You can run multiple AVA modes simultaneously:

**Scenario 1: Voice + Web**
```bash
# Terminal 1: Realtime Voice
python realtime_voice_chat.py

# Terminal 2: Web Interface
python ava_bridge.py

# Terminal 3: Web Frontend
cd ava-client && npm run dev
```

**Use voice for**: Quick queries, hands-free control
**Use web for**: Complex tasks, file uploads, visual feedback

**Scenario 2: Background + Realtime**
```bash
# Always-on background mode
pythonw ava_tray.pyw

# When needed: Start voice conversation
python realtime_voice_chat.py
```

---

## Future Enhancements

### Planned Features
- [ ] Wake word activation ("Hey AVA")
- [ ] Conversation history UI
- [ ] Multi-language support
- [ ] Voice cloning/customization
- [ ] Group conversations
- [ ] Screen sharing integration
- [ ] Mobile app integration

---

## FAQ

**Q: Can I use this on my phone?**
A: Not yet - currently desktop only. Mobile support planned.

**Q: Does it work offline?**
A: No - requires internet connection to OpenAI API.

**Q: Can multiple people talk to AVA at once?**
A: Current version is single-user. Multi-user support planned.

**Q: How do I end a conversation?**
A: Press `Ctrl+C` or just stop talking and close the window.

**Q: Can AVA make phone calls?**
A: Not yet - but this could be integrated with Twilio.

**Q: Does it remember previous conversations?**
A: Within a session, yes. Cross-session memory requires integration with AVA's memory_system.

**Q: Can I change the wake word?**
A: Current version doesn't use wake words - always listening when active.

---

## Technical Details

### Audio Format
- **Sample Rate**: 24,000 Hz (24 kHz)
- **Channels**: Mono (1)
- **Format**: 16-bit PCM
- **Chunk Size**: 1024 samples (~43ms per chunk)

### Protocol
- **Transport**: WebSocket (wss://)
- **Encoding**: JSON events + base64 audio
- **Compression**: None (raw PCM)

### Models
- **Primary**: gpt-4o-realtime-preview
- **Fallback**: gpt-realtime (production model)
- **Mini**: gpt-4o-mini-realtime-preview (faster, cheaper)

---

## Resources

- **OpenAI Realtime Docs**: https://platform.openai.com/docs/guides/realtime
- **WebSocket Protocol**: https://websockets.readthedocs.io/
- **PyAudio Docs**: https://people.csail.mit.edu/hubert/pyaudio/docs/

---

## Summary

### What You Get
✅ Natural voice conversations with AVA
✅ Sub-second response latency
✅ Ability to interrupt mid-sentence
✅ Function calling during conversation
✅ Smart voice activity detection
✅ Integration with all 26 AVA tools
✅ Production-ready implementation

### How to Start
```bash
# Just run this:
start_realtime_voice.bat

# Or:
python realtime_voice_chat.py
```

**That's it!** Start talking naturally to AVA.

---

*Last Updated: December 14, 2025*
*Status: Production Ready ✅*
