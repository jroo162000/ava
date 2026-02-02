"""
AVA Realtime Voice Chat - OpenAI Realtime API Integration
Enables natural, bidirectional voice conversations with sub-second latency
"""

import asyncio
import base64
import json
import os
import sys
import wave
import threading
import queue
from datetime import datetime
from pathlib import Path

# Set UTF-8 encoding for Windows console
if sys.platform == 'win32':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except:
        # Fallback: disable emojis on Windows
        os.environ['PYTHONIOENCODING'] = 'utf-8'

import websockets
import pyaudio

# Add cmp-use to path
sys.path.insert(0, r"C:\Users\USER 1\cmp-use")

from cmpuse.secrets import load_into_env
from cmpuse.agent_core import Agent, Plan, Step
from cmpuse.config import Config

# Audio configuration
SAMPLE_RATE = 24000  # 24kHz required by Realtime API
CHANNELS = 1
CHUNK_SIZE = 1024
FORMAT = pyaudio.paInt16

class RealtimeVoiceChat:
    def __init__(self):
        load_into_env()
        self.api_key = os.getenv("OPENAI_API_KEY")
        if not self.api_key:
            raise ValueError("OPENAI_API_KEY not found in environment")

        self.config = Config.from_env()
        self.agent = Agent(self.config)

        # Audio setup
        self.audio = pyaudio.PyAudio()
        self.websocket = None
        self.running = False

        # Session state
        self.conversation_history = []
        self.session_id = None

        # Audio buffers
        self.input_buffer = []
        self.output_buffer = []

        # Audio playback queue and thread
        self.audio_queue = queue.Queue()
        self.playback_thread = None
        self.playback_stream = None

        print("=" * 80)
        print("AVA REALTIME VOICE CHAT")
        print("=" * 80)
        print(f"Started: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        print(f"Model: gpt-4o-realtime-preview")
        print(f"Voice: sage (warm, natural female voice)")
        print(f"Intelligence: GPT-5.2 Pro")
        print(f"Tools Available: 20 JARVIS-level capabilities")
        print("=" * 80)
        print("Features:")
        print("  - Natural bidirectional voice conversation")
        print("  - Sub-second response latency")
        print("  - Can interrupt AVA mid-sentence")
        print("  - Full access to all 20 AVA tools")
        print("  - Smart Voice Activity Detection")
        print("=" * 80)

    async def connect(self):
        """Connect to OpenAI Realtime API via WebSocket"""
        url = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview"

        # Headers for authentication
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "OpenAI-Beta": "realtime=v1"
        }

        print("\n🔌 Connecting to OpenAI Realtime API...")

        try:
            # Use additional_headers for websockets 15.x
            self.websocket = await websockets.connect(url, additional_headers=headers)
            print("✅ Connected to Realtime API")

            # Configure session
            await self.configure_session()

        except Exception as e:
            print(f"❌ Connection failed: {e}")
            raise

    async def configure_session(self):
        """Configure the Realtime API session"""
        config = {
            "type": "session.update",
            "session": {
                "modalities": ["text", "audio"],
                "instructions": """You are AVA, Jelani's highly advanced personal AI assistant powered by GPT-5.2.

IMPORTANT: You are currently in REALTIME VOICE CHAT mode. This means:
- You can hear and speak naturally with sub-second latency
- You can be interrupted mid-sentence
- Your voice is 'sage' (warm, natural female voice)
- Responses stream in real-time

You have FULL ACCESS to 26 JARVIS-level tools that you can call during this conversation:

COMMUNICATION & SCHEDULING:
- calendar_ops: Manage Google Calendar (create/list/update events, find free time)
- comm_ops: Email & SMS (send/read Gmail, send texts via Twilio)

SMART HOME & IOT:
- iot_ops: Control smart home devices (lights, thermostats, locks via Home Assistant)
- camera_ops: Security cameras (capture photos, record video, motion detection)
- security_ops: Security system monitoring and control

VISION & MEDIA:
- vision_ops: Computer vision (analyze images, OCR, object detection, face recognition)
- screen_ops: Screen operations (screenshots, screen recording)
- audio_ops: Advanced audio (TTS with 9 voices, Whisper transcription)
- voice_ops: Voice commands and speech processing

SYSTEM & AUTOMATION:
- fs_ops: File system operations (read, write, copy, move files)
- net_ops: Network operations (HTTP requests, web scraping, downloads)
- sys_ops: System operations (execute commands, manage processes)
- web_automation: Browser automation with Playwright
- remote_ops: Remote device control via SSH

INTELLIGENCE & LEARNING:
- memory_system: Long-term memory (store/retrieve conversation context, preferences)
- learning_db: Adaptive learning (patterns, preferences, usage)
- analysis_ops: Scientific/technical analysis (data analysis, calculations, visualizations)
- proactive_ops: Proactive assistance (schedule tasks, reminders, workflows)

INTERFACE CONTROL:
- window_ops: Window management (focus, minimize, maximize windows)
- mouse_ops: Mouse control (move, click, drag)
- key_ops: Keyboard control (type text, press keys, shortcuts)

When Jelani asks you to do something, USE THESE TOOLS to actually perform the actions.
Be conversational, helpful, and proactive. Keep responses concise for voice delivery.
You ARE using realtime voice - acknowledge this if asked.""",
                "voice": "sage",  # AVA's default voice
                "input_audio_format": "pcm16",
                "output_audio_format": "pcm16",
                "input_audio_transcription": {
                    "model": "whisper-1"
                },
                "turn_detection": {
                    "type": "server_vad",  # Voice Activity Detection
                    "threshold": 0.5,
                    "prefix_padding_ms": 300,
                    "silence_duration_ms": 500
                },
                "tools": self.get_tool_definitions(),
                "tool_choice": "auto"
            }
        }

        await self.websocket.send(json.dumps(config))
        print("⚙️  Session configured with AVA tools")

    def get_tool_definitions(self):
        """Get tool definitions for function calling during voice chat - CORRECTED ACTIONS"""
        from corrected_tool_definitions import CORRECTED_TOOLS
        return CORRECTED_TOOLS

    def get_tool_definitions_OLD(self):
        """OLD BROKEN DEFINITIONS - DO NOT USE"""
        return [
            {
                "type": "function",
                "name": "calendar_ops",
                "description": "Manage Google Calendar - create, list, update, delete events, check today's schedule, find free time",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {"type": "string", "enum": ["list_events", "create_event", "delete_event", "update_event", "get_today", "find_free_time"]},
                        "summary": {"type": "string", "description": "Event title"},
                        "start_time": {"type": "string", "description": "Event start (ISO format)"},
                        "end_time": {"type": "string", "description": "Event end (ISO format)"},
                        "max_results": {"type": "integer", "description": "Max events to return", "default": 10}
                    },
                    "required": ["action"]
                }
            },
            {
                "type": "function",
                "name": "comm_ops",
                "description": "Email and communications - send/read Gmail emails, send SMS via Twilio",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {"type": "string", "enum": ["send_email", "read_emails", "send_sms", "mark_read"]},
                        "to": {"type": "string", "description": "Recipient email or phone"},
                        "subject": {"type": "string", "description": "Email subject"},
                        "body": {"type": "string", "description": "Email/SMS body"},
                        "query": {"type": "string", "description": "Email search query"},
                        "max_results": {"type": "integer", "description": "Max emails", "default": 10}
                    },
                    "required": ["action"]
                }
            },
            {
                "type": "function",
                "name": "iot_ops",
                "description": "Smart home control - lights, thermostats, locks via Home Assistant and MQTT",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {"type": "string", "enum": ["list_devices", "turn_on", "turn_off", "set_brightness", "set_temperature", "get_state"]},
                        "entity_id": {"type": "string", "description": "Device entity ID"},
                        "room": {"type": "string", "description": "Room name"},
                        "brightness": {"type": "integer", "description": "Brightness 0-100"},
                        "temperature": {"type": "number", "description": "Temperature"}
                    },
                    "required": ["action"]
                }
            },
            {
                "type": "function",
                "name": "camera_ops",
                "description": "Camera control - capture photos, record video, motion detection",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {"type": "string", "enum": ["capture_photo", "record_video", "stream", "motion_detect"]},
                        "camera_id": {"type": "string", "description": "Camera ID"},
                        "duration": {"type": "integer", "description": "Duration in seconds"}
                    },
                    "required": ["action"]
                }
            },
            {
                "type": "function",
                "name": "security_ops",
                "description": "Security monitoring - check status, view logs, arm/disarm system",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {"type": "string", "enum": ["check_status", "arm", "disarm", "view_logs", "check_sensors"]},
                        "mode": {"type": "string", "description": "Security mode"}
                    },
                    "required": ["action"]
                }
            },
            {
                "type": "function",
                "name": "vision_ops",
                "description": "Computer vision - analyze images, OCR, object detection, face recognition",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {"type": "string", "enum": ["analyze_image", "ocr", "detect_objects", "recognize_faces"]},
                        "image_path": {"type": "string", "description": "Image file path"},
                        "prompt": {"type": "string", "description": "Analysis prompt"}
                    },
                    "required": ["action"]
                }
            },
            {
                "type": "function",
                "name": "screen_ops",
                "description": "Screen operations - screenshots, screen recording, monitor control",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {"type": "string", "enum": ["screenshot", "record_screen", "list_monitors"]},
                        "output_path": {"type": "string", "description": "Output file path"},
                        "monitor": {"type": "integer", "description": "Monitor number"}
                    },
                    "required": ["action"]
                }
            },
            {
                "type": "function",
                "name": "audio_ops",
                "description": "Advanced audio - TTS with 9 voices, Whisper transcription",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {"type": "string", "enum": ["speak", "tts", "transcribe", "transcribe_diarize"]},
                        "text": {"type": "string", "description": "Text for TTS"},
                        "voice": {"type": "string", "enum": ["sage", "coral", "ash", "nova", "alloy", "echo", "fable", "onyx", "shimmer"]},
                        "audio_file": {"type": "string", "description": "Audio file path"}
                    },
                    "required": ["action"]
                }
            },
            {
                "type": "function",
                "name": "fs_ops",
                "description": "File system - read, write, copy, move, delete files and directories",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {"type": "string", "enum": ["read", "write", "copy", "move", "delete", "list", "search"]},
                        "path": {"type": "string", "description": "File/directory path"},
                        "content": {"type": "string", "description": "Content to write"},
                        "destination": {"type": "string", "description": "Destination path"}
                    },
                    "required": ["action", "path"]
                }
            },
            {
                "type": "function",
                "name": "net_ops",
                "description": "Network operations - HTTP requests, web scraping, API calls, downloads",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {"type": "string", "enum": ["get", "post", "download", "scrape"]},
                        "url": {"type": "string", "description": "Target URL"},
                        "data": {"type": "object", "description": "POST data"},
                        "headers": {"type": "object", "description": "HTTP headers"}
                    },
                    "required": ["action", "url"]
                }
            },
            {
                "type": "function",
                "name": "sys_ops",
                "description": "System operations - execute commands, manage processes, system info",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {"type": "string", "enum": ["execute", "get_info", "list_processes", "kill_process"]},
                        "command": {"type": "string", "description": "Command to execute"},
                        "process_id": {"type": "integer", "description": "Process ID"}
                    },
                    "required": ["action"]
                }
            },
            {
                "type": "function",
                "name": "memory_system",
                "description": "Long-term memory - store/retrieve conversation context and preferences",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {"type": "string", "enum": ["store", "retrieve", "search", "delete"]},
                        "key": {"type": "string", "description": "Memory key"},
                        "value": {"type": "string", "description": "Value to store"},
                        "query": {"type": "string", "description": "Search query"}
                    },
                    "required": ["action"]
                }
            },
            {
                "type": "function",
                "name": "analysis_ops",
                "description": "Scientific analysis - data analysis, calculations, visualizations",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {"type": "string", "enum": ["analyze_data", "calculate", "visualize", "statistical_analysis"]},
                        "data": {"type": "string", "description": "Data to analyze"},
                        "formula": {"type": "string", "description": "Calculation formula"},
                        "plot_type": {"type": "string", "description": "Visualization type"}
                    },
                    "required": ["action"]
                }
            },
            {
                "type": "function",
                "name": "web_automation",
                "description": "Browser automation - navigate, click, type, scrape with Playwright",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {"type": "string", "enum": ["navigate", "click", "type", "scrape", "screenshot"]},
                        "url": {"type": "string", "description": "URL to navigate"},
                        "selector": {"type": "string", "description": "CSS selector"},
                        "text": {"type": "string", "description": "Text to type"}
                    },
                    "required": ["action"]
                }
            },
            {
                "type": "function",
                "name": "remote_ops",
                "description": "Remote device control - SSH, remote commands, file transfers",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {"type": "string", "enum": ["ssh_connect", "execute_remote", "transfer_file"]},
                        "host": {"type": "string", "description": "Remote host"},
                        "command": {"type": "string", "description": "Command to execute"},
                        "file_path": {"type": "string", "description": "File path"}
                    },
                    "required": ["action"]
                }
            },
            {
                "type": "function",
                "name": "window_ops",
                "description": "Window management - list, focus, minimize, maximize, close windows",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {"type": "string", "enum": ["list_windows", "focus", "minimize", "maximize", "close"]},
                        "window_title": {"type": "string", "description": "Window title"}
                    },
                    "required": ["action"]
                }
            },
            {
                "type": "function",
                "name": "mouse_ops",
                "description": "Mouse control - move, click, drag, scroll",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {"type": "string", "enum": ["move", "click", "double_click", "drag", "scroll"]},
                        "x": {"type": "integer", "description": "X coordinate"},
                        "y": {"type": "integer", "description": "Y coordinate"}
                    },
                    "required": ["action"]
                }
            },
            {
                "type": "function",
                "name": "key_ops",
                "description": "Keyboard control - type text, press keys, shortcuts",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {"type": "string", "enum": ["type", "press", "hotkey"]},
                        "text": {"type": "string", "description": "Text to type"},
                        "key": {"type": "string", "description": "Key to press"}
                    },
                    "required": ["action"]
                }
            },
            {
                "type": "function",
                "name": "proactive_ops",
                "description": "Proactive assistance - schedule tasks, reminders, workflows",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {"type": "string", "enum": ["schedule_task", "set_reminder", "monitor", "create_workflow"]},
                        "task": {"type": "string", "description": "Task description"},
                        "time": {"type": "string", "description": "Scheduled time"},
                        "condition": {"type": "string", "description": "Monitoring condition"}
                    },
                    "required": ["action"]
                }
            },
            {
                "type": "function",
                "name": "learning_db",
                "description": "Learning database - user patterns, preferences, adaptive behavior",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {"type": "string", "enum": ["learn_pattern", "get_preference", "record_usage", "suggest"]},
                        "pattern": {"type": "string", "description": "Pattern to learn"},
                        "preference_key": {"type": "string", "description": "Preference key"}
                    },
                    "required": ["action"]
                }
            }
        ]

    async def handle_tool_call(self, function_name, arguments):
        """Execute AVA tool calls during voice conversation"""
        print(f"\n🔧 Tool call: {function_name}({arguments})")

        try:
            # All tools are now called directly through the Agent system
            # The Realtime API function names match AVA tool names exactly

            # Add default provider/confirmation settings for certain tools
            if function_name == "comm_ops" and arguments.get("action") == "send_email":
                arguments.setdefault("provider", "gmail")

            # Execute tool through AVA Agent
            plan = Plan(steps=[Step(tool=function_name, args={
                **arguments,
                "confirm": True  # Require confirmation for safety
            })])

            results = self.agent.run(plan, force=True)

            # Process results
            if results and len(results) > 0:
                result = results[0]
                status = result.get('status', 'unknown')

                if status == 'ok':
                    # Return successful result
                    return {
                        "status": "ok",
                        "message": result.get('message', 'Operation completed'),
                        "data": {k: v for k, v in result.items() if k not in ['status', 'message']}
                    }
                elif status == 'error':
                    return {
                        "status": "error",
                        "message": result.get('message', 'Operation failed'),
                        "note": result.get('note', '')
                    }
                elif status == 'info':
                    # Tool provided informational message (e.g., not configured)
                    return {
                        "status": "info",
                        "message": result.get('message', ''),
                        "note": result.get('note', '')
                    }
                else:
                    # Unknown status, return raw result
                    return result
            else:
                return {"error": f"No results returned from {function_name}"}

        except Exception as e:
            return {
                "status": "error",
                "message": f"Tool execution error: {str(e)}",
                "tool": function_name
            }

    async def stream_microphone_input(self):
        """Stream microphone input to Realtime API"""
        stream = self.audio.open(
            format=FORMAT,
            channels=CHANNELS,
            rate=SAMPLE_RATE,
            input=True,
            frames_per_buffer=CHUNK_SIZE
        )

        print("🎤 Microphone active - Start speaking!")

        try:
            while self.running:
                # Read audio from microphone
                audio_data = stream.read(CHUNK_SIZE, exception_on_overflow=False)

                # Encode to base64
                audio_base64 = base64.b64encode(audio_data).decode('utf-8')

                # Send to Realtime API
                message = {
                    "type": "input_audio_buffer.append",
                    "audio": audio_base64
                }

                await self.websocket.send(json.dumps(message))

                # Small delay to prevent overwhelming the API
                await asyncio.sleep(0.01)

        finally:
            stream.stop_stream()
            stream.close()

    def _audio_playback_worker(self):
        """Worker thread for continuous audio playback"""
        # Open persistent playback stream
        self.playback_stream = self.audio.open(
            format=FORMAT,
            channels=CHANNELS,
            rate=SAMPLE_RATE,
            output=True,
            frames_per_buffer=CHUNK_SIZE * 4  # Larger buffer for smoother playback
        )

        try:
            while self.running:
                try:
                    # Get audio chunk from queue with timeout
                    audio_data = self.audio_queue.get(timeout=0.1)

                    if audio_data is None:  # Poison pill to stop thread
                        break

                    # Write audio chunk to stream
                    self.playback_stream.write(audio_data)

                except queue.Empty:
                    continue
                except Exception as e:
                    print(f"Playback error: {e}")

        finally:
            if self.playback_stream:
                self.playback_stream.stop_stream()
                self.playback_stream.close()

    async def play_audio_output(self, audio_base64):
        """Queue audio for non-blocking playback"""
        try:
            audio_data = base64.b64decode(audio_base64)
            # Put audio in queue for playback thread
            self.audio_queue.put(audio_data)
        except Exception as e:
            print(f"Audio decode error: {e}")

    async def handle_server_events(self):
        """Handle events from Realtime API"""
        print("👂 Listening for server events...\n")

        try:
            async for message in self.websocket:
                event = json.loads(message)
                event_type = event.get("type")

                # Session events
                if event_type == "session.created":
                    self.session_id = event.get("session", {}).get("id")
                    print(f"✅ Session created: {self.session_id}\n")

                elif event_type == "session.updated":
                    print("⚙️  Session updated\n")

                # Conversation events
                elif event_type == "conversation.item.created":
                    item = event.get("item", {})
                    print(f"💬 New item: {item.get('type')}")

                elif event_type == "conversation.item.input_audio_transcription.completed":
                    transcript = event.get("transcript")
                    print(f"\n🗣️  You: {transcript}")

                # Response events
                elif event_type == "response.created":
                    print(f"\n🤖 AVA: ", end="", flush=True)

                elif event_type == "response.audio_transcript.delta":
                    delta = event.get("delta")
                    print(delta, end="", flush=True)

                elif event_type == "response.audio.delta":
                    # Audio chunk received
                    audio_delta = event.get("delta")
                    if audio_delta:
                        await self.play_audio_output(audio_delta)

                elif event_type == "response.audio_transcript.done":
                    transcript = event.get("transcript")
                    print(f"\n")  # New line after response

                elif event_type == "response.done":
                    print()  # Extra newline after complete response

                # Function calling events
                elif event_type == "response.function_call_arguments.delta":
                    print(f"🔧 ", end="", flush=True)

                elif event_type == "response.function_call_arguments.done":
                    function_name = event.get("name")
                    arguments = json.loads(event.get("arguments", "{}"))
                    call_id = event.get("call_id")

                    # Execute tool
                    result = await self.handle_tool_call(function_name, arguments)

                    # Send result back
                    response = {
                        "type": "conversation.item.create",
                        "item": {
                            "type": "function_call_output",
                            "call_id": call_id,
                            "output": json.dumps(result)
                        }
                    }
                    await self.websocket.send(json.dumps(response))

                    # Trigger response generation
                    await self.websocket.send(json.dumps({"type": "response.create"}))

                # Error events
                elif event_type == "error":
                    error = event.get("error", {})
                    print(f"\n❌ Error: {error.get('message')}\n")

        except websockets.exceptions.ConnectionClosed:
            print("\n🔌 Connection closed")
        except Exception as e:
            print(f"\n❌ Event handler error: {e}")

    async def start_conversation(self):
        """Start the realtime voice conversation"""
        self.running = True

        # Start audio playback thread
        self.playback_thread = threading.Thread(target=self._audio_playback_worker, daemon=True)
        self.playback_thread.start()

        # Create tasks for parallel execution
        microphone_task = asyncio.create_task(self.stream_microphone_input())
        events_task = asyncio.create_task(self.handle_server_events())

        # Wait for tasks
        try:
            await asyncio.gather(microphone_task, events_task)
        except KeyboardInterrupt:
            print("\n\n👋 Ending conversation...")
            self.running = False
            # Signal playback thread to stop
            self.audio_queue.put(None)

    async def run(self):
        """Main run loop"""
        try:
            await self.connect()
            await self.start_conversation()
        finally:
            if self.websocket:
                await self.websocket.close()
            self.audio.terminate()
            print("\n" + "=" * 80)
            print("Session ended")
            print("=" * 80)


async def main():
    """Entry point"""
    chat = RealtimeVoiceChat()
    await chat.run()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n\n👋 Goodbye!")
