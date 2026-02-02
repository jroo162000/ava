# Minimal Core Tool Definitions - Testing with essential tools only

CORRECTED_TOOLS = [
    {
        "type": "function",
        "name": "fs_ops",
        "description": "File system operations - read, write, copy, move, delete files and directories. Has FULL C: DRIVE ACCESS.",
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
        "name": "web_automation",
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
        "description": "Keyboard control - type text, press keys, keyboard shortcuts, hold/release keys",
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
        "name": "open_item",
        "description": "Open URLs or local files - open websites (auto-confirmed) or local files/apps (requires confirmation)",
        "parameters": {
            "type": "object",
            "properties": {
                "target": {"type": "string", "description": "URL or file path to open"},
                "confirm": {"type": "boolean", "description": "Confirmation for local files"}
            },
            "required": ["target"]
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
    }
]
