# Corrected Tool Definitions - Based on actual cmp-use tool actions
# Use this to replace the get_tool_definitions() method in ava_standalone_realtime.py

CORRECTED_TOOLS = [
    {
        "type": "function",
        "name": "calendar_ops",
        "description": "Manage Google Calendar - create, list, update, delete events, check today's schedule, find free time",
        "parameters": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["create_event", "list_events", "delete_event", "update_event", "get_today", "find_free_time"]},
                "summary": {"type": "string", "description": "Event title"},
                "start_time": {"type": "string", "description": "Event start (ISO format)"},
                "end_time": {"type": "string", "description": "Event end (ISO format)"},
                "max_results": {"type": "integer", "description": "Max events to return"}
            },
            "required": ["action"]
        }
    },
    {
        "type": "function",
        "name": "computer_use",
        "description": "Autonomous computer-use via screenshots, mouse clicks, OCR text targeting, and window control (general purpose)",
        "parameters": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": [
                    "save_notepad_as",
                    "focus_window",
                    "open_start",
                    "type",
                    "press_key",
                    "hotkey",
                    "click_text",
                    "wait_text",
                "run_sequence"
            ]},
                "path": {"type": "string", "description": "File path for save_notepad_as"},
                "title": {"type": "string", "description": "Window title for focus_window"},
                "query": {"type": "string", "description": "Search/app query for open_start"},
                "text": {"type": "string", "description": "Text for click_text/type/wait_text"},
                "timeout": {"type": "number", "description": "Timeout seconds for wait_text"},
                "keys": {"type": "array", "items": {"type": "string"}, "description": "Key combo for hotkey"},
                "key": {"type": "string", "description": "Single key for press_key"},
                "region": {"type": "array", "items": {"type": "integer"}, "description": "Region [l,t,w,h] to constrain OCR/click"},
                "steps": {"type": "array", "items": {"type": "object"}, "description": "Run sequence steps"},
                "window_title": {"type": "string", "description": "UIA window title (regex ok)"},
                "name": {"type": "string", "description": "UIA control name"},
                "control_type": {"type": "string", "description": "UIA control type (e.g., Button)"}
            },
            "required": ["action"]
        }
    },
    {
        "type": "function",
        "name": "computer_use_control",
        "description": "Control computer-use automation by voice: pause/resume/stop",
        "parameters": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["pause", "resume", "stop", "abort", "continue"]}
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
                "max_results": {"type": "integer", "description": "Max emails"}
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
                "action": {"type": "string", "enum": ["list_devices", "turn_on", "turn_off", "set_brightness", "set_temperature", "mqtt_publish", "mqtt_subscribe", "get_state"]},
                "entity_id": {"type": "string", "description": "Device entity ID"},
                "room": {"type": "string", "description": "Room name"},
                "brightness": {"type": "integer", "description": "Brightness 0-100"},
                "temperature": {"type": "number", "description": "Temperature"},
                "topic": {"type": "string", "description": "MQTT topic"},
                "payload": {"type": "string", "description": "MQTT payload"}
            },
            "required": ["action"]
        }
    },
    {
        "type": "function",
        "name": "camera_ops",
        "description": "Camera & video - webcam capture, face/hand/pose detection, motion analysis, video analysis",
        "parameters": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["capture", "detect_faces", "detect_hands", "detect_pose", "close", "analyze_motion", "analyze_video"]},
                "camera_index": {"type": "integer", "description": "Camera index (0 for default)"},
                "save_path": {"type": "string", "description": "Path to save capture"},
                "save_annotated": {"type": "string", "description": "Path to save annotated image"},
                "use_mediapipe": {"type": "boolean", "description": "Use MediaPipe for detection"},
                "duration": {"type": "integer", "description": "Duration in seconds"},
                "threshold": {"type": "integer", "description": "Motion detection threshold"},
                "video_path": {"type": "string", "description": "Path to video file"},
                "detect_type": {"type": "string", "enum": ["faces", "hands", "pose"], "description": "Type of detection for video"}
            },
            "required": ["action"]
        }
    },
    {
        "type": "function",
        "name": "security_ops",
        "description": "Security operations - port scanning, log analysis, process monitoring, network scanning, file monitoring, security audit",
        "parameters": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["scan_ports", "analyze_logs", "check_processes", "network_scan", "monitor_files", "status", "full_audit"]},
                "target": {"type": "string", "description": "Target host/IP for scanning"},
                "log_file": {"type": "string", "description": "Log file path"},
                "network_range": {"type": "string", "description": "Network range to scan"},
                "watch_path": {"type": "string", "description": "Path to monitor"}
            },
            "required": ["action"]
        }
    },
    {
        "type": "function",
        "name": "vision_ops",
        "description": "Computer vision - OCR text reading, screen analysis with GPT-4o Vision, image understanding",
        "parameters": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["ocr", "ocr_region", "analyze_screen", "describe_image"]},
                "image_path": {"type": "string", "description": "Path to image file"},
                "region": {"type": "array", "items": {"type": "integer"}, "description": "Region [left, top, width, height]"},
                "question": {"type": "string", "description": "Question about the image"}
            },
            "required": ["action"]
        }
    },
    {
        "type": "function",
        "name": "screen_ops",
        "description": "Screen operations - screenshots, locate elements, screen info, pixel color",
        "parameters": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["screenshot", "screenshot_region", "locate", "locate_all", "screen_size", "pixel_color"]},
                "output_path": {"type": "string", "description": "Output file path"},
                "region": {"type": "array", "items": {"type": "integer"}, "description": "Region [left, top, width, height]"},
                "image_path": {"type": "string", "description": "Image to locate on screen"},
                "x": {"type": "integer", "description": "X coordinate"},
                "y": {"type": "integer", "description": "Y coordinate"}
            },
            "required": ["action"]
        }
    },
    {
        "type": "function",
        "name": "audio_ops",
        "description": "Audio control and OpenAI audio - system volume, TTS with 9 voices, Whisper transcription, audio conversations",
        "parameters": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["get_volume", "set_volume", "mute", "unmute", "increase", "decrease", "speak", "tts", "transcribe", "transcribe_diarize", "audio_conversation", "realtime_info"]},
                "volume": {"type": "integer", "description": "Volume level 0-100"},
                "amount": {"type": "integer", "description": "Amount to change volume"},
                "text": {"type": "string", "description": "Text for TTS"},
                "voice": {"type": "string", "enum": ["sage", "coral", "ash", "nova", "alloy", "echo", "fable", "onyx", "shimmer"]},
                "audio_file": {"type": "string", "description": "Audio file path"},
                "output_file": {"type": "string", "description": "Output file path"},
                "model": {"type": "string", "description": "Model name"},
                "prompt": {"type": "string", "description": "Context prompt"}
            },
            "required": ["action"]
        }
    },
    {
        "type": "function",
        "name": "fs_ops",
        "description": "File system operations - read, write, copy, move, delete files and directories",
        "parameters": {
            "type": "object",
            "properties": {
                "operation": {"type": "string", "enum": ["read", "write", "copy", "move", "delete", "list"]},
                "path": {"type": "string", "description": "File/directory path"},
                "content": {"type": "string", "description": "Content to write"},
                "src": {"type": "string", "description": "Source path for copy/move"},
                "dest": {"type": "string", "description": "Destination path for copy/move"}
            },
            "required": ["path"]
        }
    },
    {
        "type": "function",
        "name": "net_ops",
        "description": "Network operations - HTTP GET requests to fetch web content",
        "parameters": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "URL to fetch"}
            },
            "required": ["url"]
        }
    },
    {
        "type": "function",
        "name": "sys_ops",
        "description": "System operations - get comprehensive system information (CPU, memory, disk, network, processes)",
        "parameters": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["get_info"], "description": "Get system info"}
            }
        }
    },
    {
        "type": "function",
        "name": "memory_system",
        "description": "Long-term memory - store/retrieve conversation context, learn patterns, get context summaries",
        "parameters": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["store", "recall", "learn", "get_context", "summary"]},
                "key": {"type": "string", "description": "Memory key"},
                "value": {"type": "string", "description": "Value to store"},
                "query": {"type": "string", "description": "Search query"},
                "context": {"type": "string", "description": "Context description"}
            },
            "required": ["action"]
        }
    },
    {
        "type": "function",
        "name": "analysis_ops",
        "description": "Scientific & technical analysis - calculations, statistics, data analysis, code analysis, research",
        "parameters": {
            "type": "object",
            "properties": {
                "operation": {"type": "string", "enum": ["calculate", "statistics", "data_analysis", "code_analysis", "scientific", "research", "analyze"]},
                "data": {"type": "string", "description": "Data to analyze"},
                "formula": {"type": "string", "description": "Calculation formula"},
                "code": {"type": "string", "description": "Code to analyze"},
                "query": {"type": "string", "description": "Research query"}
            },
            "required": ["operation"]
        }
    },
    {
        "type": "function",
        "name": "browser_automation",
        "description": "Browser automation - launch, navigate, click, type, close browser with Playwright",
        "parameters": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["launch", "navigate", "click", "type", "close"]},
                "url": {"type": "string", "description": "URL to navigate"},
                "selector": {"type": "string", "description": "CSS selector for element"},
                "text": {"type": "string", "description": "Text to type"}
            },
            "required": ["action"]
        }
    },
    {
        "type": "function",
        "name": "remote_ops",
        "description": "Remote device control - SSH connections, execute remote commands, file transfers, network scanning, Wake-on-LAN",
        "parameters": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["connect", "execute", "disconnect", "list_connections", "scan_network", "wake_on_lan", "upload_file", "download_file"]},
                "host": {"type": "string", "description": "Remote host/IP"},
                "command": {"type": "string", "description": "Command to execute"},
                "local_path": {"type": "string", "description": "Local file path"},
                "remote_path": {"type": "string", "description": "Remote file path"},
                "mac_address": {"type": "string", "description": "MAC address for WOL"}
            },
            "required": ["action"]
        }
    },
    {
        "type": "function",
        "name": "window_ops",
        "description": "Window management - list, focus, minimize, maximize, restore, close, move, resize windows",
        "parameters": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["list", "focus", "minimize", "maximize", "restore", "close", "move", "resize", "move_resize"]},
                "window_title": {"type": "string", "description": "Window title or partial title"},
                "x": {"type": "integer", "description": "X position"},
                "y": {"type": "integer", "description": "Y position"},
                "width": {"type": "integer", "description": "Window width"},
                "height": {"type": "integer", "description": "Window height"}
            },
            "required": ["action"]
        }
    },
    {
        "type": "function",
        "name": "mouse_ops",
        "description": "Mouse control - move, click, double-click, right-click, drag, scroll, get position",
        "parameters": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["move", "click", "double_click", "right_click", "drag", "scroll", "position"]},
                "x": {"type": "integer", "description": "X coordinate"},
                "y": {"type": "integer", "description": "Y coordinate"},
                "to_x": {"type": "integer", "description": "Drag to X coordinate"},
                "to_y": {"type": "integer", "description": "Drag to Y coordinate"},
                "clicks": {"type": "integer", "description": "Number of scroll clicks"}
            },
            "required": ["action"]
        }
    },
    {
        "type": "function",
        "name": "key_ops",
        "description": "Keyboard control - type text, press keys, keyboard shortcuts, hold/release keys, type with delay",
        "parameters": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["type", "press", "hotkey", "hold", "release", "type_with_delay"]},
                "text": {"type": "string", "description": "Text to type"},
                "key": {"type": "string", "description": "Key to press"},
                "keys": {"type": "array", "items": {"type": "string"}, "description": "Keys for hotkey combination"},
                "delay": {"type": "number", "description": "Delay between keystrokes in seconds"}
            },
            "required": ["action"]
        }
    },
    {
        "type": "function",
        "name": "proactive_ops",
        "description": "Proactive assistance - start/stop monitoring, schedule tasks, get suggestions, system health checks",
        "parameters": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["start", "stop", "status", "schedule_task", "list_tasks", "cancel_task", "get_suggestions", "clear_suggestions", "system_health"]},
                "task": {"type": "string", "description": "Task description"},
                "task_id": {"type": "string", "description": "Task ID"},
                "schedule": {"type": "string", "description": "Task schedule"},
                "condition": {"type": "string", "description": "Monitoring condition"}
            },
            "required": ["action"]
        }
    },
    {
        "type": "function",
        "name": "learning_db",
        "description": "Learning database - user preferences, patterns, facts, corrections for adaptive behavior",
        "parameters": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["set_preference", "get_preference", "learn_correction", "learn_fact", "get_facts", "record_pattern", "get_patterns", "stats"]},
                "key": {"type": "string", "description": "Preference/pattern key"},
                "value": {"type": "string", "description": "Preference value"},
                "fact": {"type": "string", "description": "Fact to learn"},
                "correction": {"type": "string", "description": "Correction to learn"},
                "pattern": {"type": "string", "description": "Pattern to record"}
            },
            "required": ["action"]
        }
    },
    {
        "type": "function",
        "name": "self_awareness",
        "description": "AVA self-awareness and introspection - query own identity, capabilities, learned facts, run self-diagnosis, check configuration. Use this when asked about yourself.",
        "parameters": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["introspect", "diagnose", "who_am_i", "get_capabilities", "get_learned_facts", "get_corrections", "get_config"]},
                "query": {"type": "string", "description": "Specific aspect to query"}
            },
            "required": ["action"]
        }
    },
    {
        "type": "function",
        "name": "self_mod",
        "description": "AVA self-modification system - diagnose own code, analyze files, propose fixes, read/write own source code. REQUIRES USER APPROVAL for any changes. Use this to fix bugs in yourself, understand your own code, or improve your capabilities.",
        "parameters": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["diagnose", "diagnose_error", "analyze_file", "find_function", "read_file", "propose_fix", "list_pending", "approve", "reject", "rollback", "get_coding_knowledge", "list_core_files"]},
                "file": {"type": "string", "description": "File key (voice_main, server_main, etc.) or full path"},
                "function": {"type": "string", "description": "Function name to find"},
                "error": {"type": "string", "description": "Error message to diagnose"},
                "file_hint": {"type": "string", "description": "Hint about which file has the error"},
                "content": {"type": "string", "description": "New file content for proposed fix"},
                "reason": {"type": "string", "description": "Reason for the proposed change"},
                "modification_id": {"type": "string", "description": "ID of pending modification to approve/reject"}
            },
            "required": ["action"]
        }
    }
]
