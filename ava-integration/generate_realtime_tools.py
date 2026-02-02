"""
Generate OpenAI Realtime API tool definitions from AVA's tool registry
"""

import sys
sys.path.insert(0, r"C:\Users\USER 1\cmp-use")

# Import all tools to register them
import cmpuse.tools
from cmpuse.tool_registry import list_tools

def generate_realtime_tool_definitions():
    """Generate tool definitions in OpenAI Realtime API format"""
    tools = list_tools()

    realtime_tools = []

    # Define tool mappings with their key parameters
    tool_configs = {
        "calendar_ops": {
            "description": "Manage Google Calendar - create, list, update, delete events, check today's schedule, find free time",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["list_events", "create_event", "delete_event", "update_event", "get_today", "find_free_time"],
                        "description": "Calendar action to perform"
                    },
                    "summary": {"type": "string", "description": "Event title/summary"},
                    "start_time": {"type": "string", "description": "Event start time (ISO format)"},
                    "end_time": {"type": "string", "description": "Event end time (ISO format)"},
                    "max_results": {"type": "integer", "description": "Maximum events to return", "default": 10}
                },
                "required": ["action"]
            }
        },
        "comm_ops": {
            "description": "Email and communications - send/read Gmail emails, send SMS via Twilio",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["send_email", "read_emails", "send_sms", "mark_read"],
                        "description": "Communication action"
                    },
                    "to": {"type": "string", "description": "Recipient email or phone number"},
                    "subject": {"type": "string", "description": "Email subject"},
                    "body": {"type": "string", "description": "Email or SMS body"},
                    "query": {"type": "string", "description": "Email search query (e.g., 'is:unread')"},
                    "max_results": {"type": "integer", "description": "Maximum emails to retrieve", "default": 10}
                },
                "required": ["action"]
            }
        },
        "iot_ops": {
            "description": "Smart home control - control lights, thermostats, locks via Home Assistant and MQTT",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["list_devices", "turn_on", "turn_off", "set_brightness", "set_temperature", "get_state"],
                        "description": "IoT action"
                    },
                    "entity_id": {"type": "string", "description": "Device entity ID (e.g., 'light.living_room')"},
                    "room": {"type": "string", "description": "Room name"},
                    "brightness": {"type": "integer", "description": "Brightness level (0-100)"},
                    "temperature": {"type": "number", "description": "Temperature in degrees"}
                },
                "required": ["action"]
            }
        },
        "camera_ops": {
            "description": "Camera control - capture photos, record video, stream camera feed, motion detection",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["capture_photo", "record_video", "stream", "motion_detect"],
                        "description": "Camera action"
                    },
                    "camera_id": {"type": "string", "description": "Camera identifier"},
                    "duration": {"type": "integer", "description": "Duration in seconds for video recording"}
                },
                "required": ["action"]
            }
        },
        "security_ops": {
            "description": "Security monitoring - check system status, view security logs, arm/disarm security system",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["check_status", "arm", "disarm", "view_logs", "check_sensors"],
                        "description": "Security action"
                    },
                    "mode": {"type": "string", "description": "Security mode (home, away, night)"}
                },
                "required": ["action"]
            }
        },
        "voice_ops": {
            "description": "Voice operations - text-to-speech, speech-to-text transcription, voice commands",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["speak", "transcribe", "voice_command"],
                        "description": "Voice action"
                    },
                    "text": {"type": "string", "description": "Text to speak"},
                    "audio_file": {"type": "string", "description": "Audio file path for transcription"}
                },
                "required": ["action"]
            }
        },
        "audio_ops": {
            "description": "Advanced audio operations - TTS with multiple voices, Whisper transcription, audio-aware conversations",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["speak", "tts", "transcribe", "transcribe_diarize", "audio_conversation"],
                        "description": "Audio action"
                    },
                    "text": {"type": "string", "description": "Text for TTS"},
                    "voice": {"type": "string", "enum": ["sage", "coral", "ash", "nova", "alloy", "echo", "fable", "onyx", "shimmer"], "description": "Voice to use"},
                    "audio_file": {"type": "string", "description": "Audio file path"}
                },
                "required": ["action"]
            }
        },
        "vision_ops": {
            "description": "Computer vision - analyze images, OCR text extraction, object detection, face recognition",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["analyze_image", "ocr", "detect_objects", "recognize_faces"],
                        "description": "Vision action"
                    },
                    "image_path": {"type": "string", "description": "Path to image file"},
                    "prompt": {"type": "string", "description": "Analysis prompt"}
                },
                "required": ["action"]
            }
        },
        "screen_ops": {
            "description": "Screen operations - capture screenshots, screen recording, monitor control",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["screenshot", "record_screen", "list_monitors"],
                        "description": "Screen action"
                    },
                    "output_path": {"type": "string", "description": "Output file path"},
                    "monitor": {"type": "integer", "description": "Monitor number"}
                },
                "required": ["action"]
            }
        },
        "fs_ops": {
            "description": "File system operations - read, write, copy, move, delete files and directories",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["read", "write", "copy", "move", "delete", "list", "search"],
                        "description": "File system action"
                    },
                    "path": {"type": "string", "description": "File or directory path"},
                    "content": {"type": "string", "description": "Content to write"},
                    "destination": {"type": "string", "description": "Destination path for copy/move"}
                },
                "required": ["action", "path"]
            }
        },
        "net_ops": {
            "description": "Network operations - HTTP requests, web scraping, API calls, download files",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["get", "post", "download", "scrape"],
                        "description": "Network action"
                    },
                    "url": {"type": "string", "description": "Target URL"},
                    "data": {"type": "object", "description": "Request data for POST"},
                    "headers": {"type": "object", "description": "HTTP headers"}
                },
                "required": ["action", "url"]
            }
        },
        "sys_ops": {
            "description": "System operations - execute commands, manage processes, system info, environment variables",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["execute", "get_info", "list_processes", "kill_process"],
                        "description": "System action"
                    },
                    "command": {"type": "string", "description": "Command to execute"},
                    "process_id": {"type": "integer", "description": "Process ID"}
                },
                "required": ["action"]
            }
        },
        "memory_system": {
            "description": "Long-term memory - store and retrieve conversation context, user preferences, learned information",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["store", "retrieve", "search", "delete"],
                        "description": "Memory action"
                    },
                    "key": {"type": "string", "description": "Memory key"},
                    "value": {"type": "string", "description": "Value to store"},
                    "query": {"type": "string", "description": "Search query"}
                },
                "required": ["action"]
            }
        },
        "analysis_ops": {
            "description": "Scientific and technical analysis - data analysis, calculations, scientific computations, visualizations",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["analyze_data", "calculate", "visualize", "statistical_analysis"],
                        "description": "Analysis action"
                    },
                    "data": {"type": "string", "description": "Data to analyze"},
                    "formula": {"type": "string", "description": "Calculation formula"},
                    "plot_type": {"type": "string", "description": "Visualization type"}
                },
                "required": ["action"]
            }
        },
        "web_automation": {
            "description": "Web browser automation - navigate websites, fill forms, click elements, scrape data with Playwright",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["navigate", "click", "type", "scrape", "screenshot"],
                        "description": "Web automation action"
                    },
                    "url": {"type": "string", "description": "URL to navigate to"},
                    "selector": {"type": "string", "description": "CSS selector for element"},
                    "text": {"type": "string", "description": "Text to type"}
                },
                "required": ["action"]
            }
        },
        "remote_ops": {
            "description": "Remote device control - SSH connections, remote command execution, file transfers",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["ssh_connect", "execute_remote", "transfer_file"],
                        "description": "Remote action"
                    },
                    "host": {"type": "string", "description": "Remote host address"},
                    "command": {"type": "string", "description": "Command to execute"},
                    "file_path": {"type": "string", "description": "File path for transfer"}
                },
                "required": ["action"]
            }
        },
        "window_ops": {
            "description": "Window management - list, focus, minimize, maximize, close windows",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["list_windows", "focus", "minimize", "maximize", "close"],
                        "description": "Window action"
                    },
                    "window_title": {"type": "string", "description": "Window title or pattern"}
                },
                "required": ["action"]
            }
        },
        "mouse_ops": {
            "description": "Mouse control - move cursor, click, double-click, drag, scroll",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["move", "click", "double_click", "drag", "scroll"],
                        "description": "Mouse action"
                    },
                    "x": {"type": "integer", "description": "X coordinate"},
                    "y": {"type": "integer", "description": "Y coordinate"}
                },
                "required": ["action"]
            }
        },
        "key_ops": {
            "description": "Keyboard control - type text, press keys, keyboard shortcuts",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["type", "press", "hotkey"],
                        "description": "Keyboard action"
                    },
                    "text": {"type": "string", "description": "Text to type"},
                    "key": {"type": "string", "description": "Key to press"}
                },
                "required": ["action"]
            }
        },
        "proactive_ops": {
            "description": "Proactive assistance - schedule tasks, set reminders, monitor conditions, automated workflows",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["schedule_task", "set_reminder", "monitor", "create_workflow"],
                        "description": "Proactive action"
                    },
                    "task": {"type": "string", "description": "Task description"},
                    "time": {"type": "string", "description": "Scheduled time"},
                    "condition": {"type": "string", "description": "Monitoring condition"}
                },
                "required": ["action"]
            }
        },
        "learning_db": {
            "description": "Learning database - store user patterns, preferences, frequently used commands, adaptive behavior",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["learn_pattern", "get_preference", "record_usage", "suggest"],
                        "description": "Learning action"
                    },
                    "pattern": {"type": "string", "description": "Pattern to learn"},
                    "preference_key": {"type": "string", "description": "Preference key"}
                },
                "required": ["action"]
            }
        }
    }

    # Generate tool definitions for each configured tool
    for tool_name, config in tool_configs.items():
        if tool_name in tools:
            realtime_tools.append({
                "type": "function",
                "name": tool_name,
                "description": config["description"],
                "parameters": config["parameters"]
            })

    print(f"Generated {len(realtime_tools)} tool definitions for Realtime API")
    print("\nTools included:")
    for tool in realtime_tools:
        print(f"  - {tool['name']}: {tool['description']}")

    return realtime_tools

if __name__ == "__main__":
    import json
    tools = generate_realtime_tool_definitions()

    # Save to file
    with open("realtime_tools_config.json", "w") as f:
        json.dump(tools, f, indent=2)

    print(f"\n\nSaved to realtime_tools_config.json")
