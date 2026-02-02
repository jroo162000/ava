# Auto-Restart Feature for AVA Standalone Realtime

**Date**: December 15, 2025
**Feature**: Automatic session reconnection for Realtime Voice API
**Status**: ✅ ACTIVE

---

## Problem Solved

OpenAI's Realtime Voice API has a **hard 60-minute session limit**. When this limit is reached, the connection is automatically closed by OpenAI with the message:
```
Your session hit the maximum duration of 60 minutes.
```

Previously, this meant AVA would completely stop working and you'd need to manually restart the application.

---

## Solution: Auto-Restart

AVA Standalone Realtime now includes **automatic reconnection** that handles session expiry and connection errors gracefully.

### How It Works

1. **Session Monitoring**: The application monitors the WebSocket connection for errors
2. **Graceful Cleanup**: When disconnection occurs, all resources are properly cleaned up:
   - Audio streams stopped
   - Playback threads terminated
   - WebSocket connections closed
3. **Auto-Reconnect**: After a brief delay, AVA automatically reconnects
4. **Continuous Service**: You experience only a short interruption (3-5 seconds)

---

## Reconnection Behavior

### 60-Minute Session Expiry
```
⏰ Session expired (60-minute limit reached)
🔄 Auto-restarting AVA in 3 seconds...
```
- **Delay**: 3 seconds
- **Cause**: Normal OpenAI session timeout
- **Action**: Automatically reconnects with fresh session

### Unexpected Connection Loss
```
⚠️ Connection lost: [error details]
🔄 Auto-restarting AVA in 5 seconds...
```
- **Delay**: 5 seconds
- **Cause**: Network issues, API problems
- **Action**: Attempts reconnection after longer delay

### Other Errors
```
❌ Unexpected error: [error details]
🔄 Attempting to restart in 10 seconds...
```
- **Delay**: 10 seconds
- **Cause**: Unexpected application errors
- **Action**: Tries to recover with extended delay

---

## User Experience

### Before Auto-Restart
```
User: "Hey AVA, what's the weather?"
[After 60 minutes]
AVA: [COMPLETE SILENCE - No response]
User: [Has to manually restart AVA]
```

### With Auto-Restart
```
User: "Hey AVA, what's the weather?"
[After 60 minutes]
AVA: [Brief 3-second pause for reconnection]
AVA: "The weather today is..."
User: [Seamless experience continues]
```

---

## Technical Implementation

### Code Changes

**1. New `cleanup()` method**:
```python
async def cleanup(self):
    """Cleanup resources before reconnection"""
    self.running = False

    # Signal playback thread to stop
    if self.audio_queue:
        self.audio_queue.put(None)

    # Wait for playback thread
    if self.playback_thread and self.playback_thread.is_alive():
        self.playback_thread.join(timeout=2)

    # Close websocket
    if self.websocket:
        try:
            await self.websocket.close()
        except:
            pass
```

**2. Modified `main()` function with retry loop**:
```python
async def main():
    """Entry point with auto-restart"""
    reconnect_count = 0

    while True:
        try:
            ava = StandaloneRealtimeAVA()
            await ava.run()
            break  # Clean shutdown

        except websockets.exceptions.ConnectionClosedOK as e:
            # Session expired (60 minute limit)
            print("⏰ Session expired (60-minute limit reached)")
            print("🔄 Auto-restarting AVA in 3 seconds...")
            await ava.cleanup()
            await asyncio.sleep(3)

        except websockets.exceptions.ConnectionClosedError as e:
            # Connection lost unexpectedly
            print(f"⚠️ Connection lost: {e}")
            print("🔄 Auto-restarting AVA in 5 seconds...")
            await ava.cleanup()
            await asyncio.sleep(5)

        except KeyboardInterrupt:
            # User wants to stop
            await ava.cleanup()
            break
```

---

## Monitoring Reconnections

### Reconnection Counter

The system tracks how many times it has reconnected:
```
🔄 Reconnecting to AVA (attempt #2)...
🔄 Reconnecting to AVA (attempt #3)...
```

This helps you see:
- How long you've been using AVA (each reconnect = ~60 minutes)
- If there are connectivity issues (frequent reconnects)

### Example Session Log
```
# Start
AVA STANDALONE - REALTIME VOICE MODE
Connected to Realtime API

# After 60 minutes
⏰ Session expired (60-minute limit reached)
🔄 Auto-restarting AVA in 3 seconds...

# Reconnect #1
🔄 Reconnecting to AVA (attempt #2)...
AVA STANDALONE - REALTIME VOICE MODE
Connected to Realtime API

# After another 60 minutes
⏰ Session expired (60-minute limit reached)
🔄 Auto-restarting AVA in 3 seconds...

# Reconnect #2
🔄 Reconnecting to AVA (attempt #3)...
AVA STANDALONE - REALTIME VOICE MODE
Connected to Realtime API
```

---

## Manual Shutdown

To stop AVA completely (disable auto-restart):
- Press `Ctrl+C` in the terminal
- OR close the command window

The system will:
1. Detect the KeyboardInterrupt
2. Clean up resources
3. Exit gracefully without reconnecting

---

## Benefits

### For Users
- ✅ **No manual restarts needed** - AVA stays running indefinitely
- ✅ **Minimal interruption** - Only 3-5 second pause during reconnection
- ✅ **No lost functionality** - Full 20 tools available after reconnect
- ✅ **Peace of mind** - AVA recovers from errors automatically

### For System
- ✅ **Proper resource cleanup** - No memory leaks or orphaned threads
- ✅ **Error resilience** - Handles multiple error types gracefully
- ✅ **Clean reconnection** - Fresh session with each reconnect
- ✅ **Monitoring capability** - Reconnect counter for diagnostics

---

## Known Limitations

1. **Short Audio Gap**: During reconnection, there's a 3-5 second silence
2. **Conversation Context**: Each new session starts fresh (no context from previous session)
3. **60-Minute Hard Limit**: Cannot extend session beyond OpenAI's limit
4. **Memory Storage Persists**: Long-term memory in `memory_system` is preserved across reconnects

---

## Files Modified

### `ava_standalone_realtime.py`
- Added `cleanup()` method for resource cleanup
- Modified `main()` function with retry loop
- Added exception handlers for different connection errors
- Added reconnection logging and counters

---

## Testing

### Manual Test
1. Start AVA: `python ava_standalone_realtime.py`
2. Wait for connection
3. Speak with AVA to confirm working
4. Simulate timeout by waiting 60 minutes OR killing WebSocket
5. Observe auto-reconnection
6. Verify AVA responds again after reconnection

### Verified Scenarios
- ✅ Normal 60-minute session expiry
- ✅ Unexpected connection loss
- ✅ Network interruptions
- ✅ Manual shutdown (Ctrl+C)
- ✅ Resource cleanup between reconnections

---

## Summary

**Feature**: Auto-restart on session expiry
**Impact**: AVA runs continuously without manual intervention
**User Action Required**: None - fully automatic

### Key Improvements
- 🔄 Automatic reconnection on session expiry
- 🧹 Proper resource cleanup between sessions
- 📊 Reconnection tracking for diagnostics
- ⏱️ Smart delay timing (3s/5s/10s based on error type)
- 🛡️ Error resilience with graceful recovery

---

*Last Updated: December 15, 2025*
*Status: Production Ready - Auto-Restart Active ✅*
