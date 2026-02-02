"""
AVA Centralized Logging Framework
==================================
Provides structured, configurable logging for all AVA components.

Features:
- Multiple log levels (DEBUG, INFO, WARNING, ERROR, CRITICAL)
- Console and file output
- Configurable via environment variables
- Structured JSON logging option
- Component-specific loggers
- Performance metrics logging

Usage:
    from ava_logging import get_logger, log_info, log_error
    
    # Module-specific logger
    logger = get_logger("my_module")
    logger.info("Starting process")
    logger.error("Something failed", exc_info=True)
    
    # Quick logging functions
    log_info("Simple message")
    log_error("Error occurred")
"""

import os
import sys
import json
import logging
import logging.handlers
from pathlib import Path
from datetime import datetime
from typing import Optional, Any, Dict
from functools import wraps
import time
import traceback

# =============================================================================
# CONFIGURATION
# =============================================================================

# Default paths
DEFAULT_LOG_DIR = Path(__file__).parent
DEFAULT_LOG_FILE = DEFAULT_LOG_DIR / "ava_runtime.log"
DEFAULT_ERROR_LOG = DEFAULT_LOG_DIR / "ava_error.log"

# Log levels from environment
LOG_LEVEL = os.environ.get("AVA_LOG_LEVEL", "INFO").upper()
LOG_FORMAT = os.environ.get("AVA_LOG_FORMAT", "standard")  # "standard" or "json"
LOG_TO_FILE = os.environ.get("AVA_LOG_TO_FILE", "1") == "1"
LOG_TO_CONSOLE = os.environ.get("AVA_LOG_TO_CONSOLE", "1") == "1"
DEBUG_MODE = os.environ.get("AVA_DEBUG", "0") == "1"

# Component-specific debug flags (from ava_voice_config.json)
DEBUG_ASR = os.environ.get("AVA_DEBUG_ASR", "0") == "1"
DEBUG_AGENT = os.environ.get("AVA_DEBUG_AGENT", "0") == "1"
DEBUG_TOOLS = os.environ.get("AVA_DEBUG_TOOLS", "0") == "1"

# Map string levels to logging constants
LEVEL_MAP = {
    "DEBUG": logging.DEBUG,
    "INFO": logging.INFO,
    "WARNING": logging.WARNING,
    "WARN": logging.WARNING,
    "ERROR": logging.ERROR,
    "CRITICAL": logging.CRITICAL,
}


# =============================================================================
# CUSTOM FORMATTERS
# =============================================================================

class StandardFormatter(logging.Formatter):
    """Standard log formatter with colors for console"""
    
    COLORS = {
        'DEBUG': '\033[36m',     # Cyan
        'INFO': '\033[32m',      # Green
        'WARNING': '\033[33m',   # Yellow
        'ERROR': '\033[31m',     # Red
        'CRITICAL': '\033[35m',  # Magenta
        'RESET': '\033[0m'
    }
    
    def __init__(self, use_colors: bool = True):
        super().__init__()
        self.use_colors = use_colors and sys.stdout.isatty()
    
    def format(self, record: logging.LogRecord) -> str:
        # Timestamp
        timestamp = datetime.fromtimestamp(record.created).strftime('%H:%M:%S.%f')[:-3]
        
        # Level with padding
        level = record.levelname
        
        # Component tag
        component = record.name.replace('ava.', '')
        if component == 'root':
            component = 'ava'
        
        # Format the message
        if self.use_colors:
            color = self.COLORS.get(level, '')
            reset = self.COLORS['RESET']
            prefix = f"{color}[{timestamp}] [{level:7}] [{component}]{reset}"
        else:
            prefix = f"[{timestamp}] [{level:7}] [{component}]"
        
        # Main message
        message = record.getMessage()
        
        # Add exception info if present
        if record.exc_info:
            message += '\n' + self.formatException(record.exc_info)
        
        return f"{prefix} {message}"


class JSONFormatter(logging.Formatter):
    """JSON structured log formatter"""
    
    def format(self, record: logging.LogRecord) -> str:
        log_data = {
            "timestamp": datetime.fromtimestamp(record.created).isoformat(),
            "level": record.levelname,
            "component": record.name,
            "message": record.getMessage(),
        }
        
        # Add extra fields if present
        if hasattr(record, 'extra_data'):
            log_data["data"] = record.extra_data
        
        # Add exception info
        if record.exc_info:
            log_data["exception"] = {
                "type": record.exc_info[0].__name__ if record.exc_info[0] else None,
                "message": str(record.exc_info[1]) if record.exc_info[1] else None,
                "traceback": self.formatException(record.exc_info)
            }
        
        return json.dumps(log_data)


class FileFormatter(logging.Formatter):
    """Plain text formatter for file output"""
    
    def format(self, record: logging.LogRecord) -> str:
        timestamp = datetime.fromtimestamp(record.created).strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]
        level = record.levelname
        component = record.name
        message = record.getMessage()
        
        result = f"{timestamp} | {level:7} | {component} | {message}"
        
        if record.exc_info:
            result += '\n' + self.formatException(record.exc_info)
        
        return result


# =============================================================================
# LOGGER SETUP
# =============================================================================

# Keep track of configured loggers
_loggers: Dict[str, logging.Logger] = {}
_root_configured = False


def _setup_root_logger():
    """Configure the root AVA logger"""
    global _root_configured
    
    if _root_configured:
        return
    
    root = logging.getLogger('ava')
    root.setLevel(LEVEL_MAP.get(LOG_LEVEL, logging.INFO))
    
    # Clear any existing handlers
    root.handlers.clear()
    
    # Console handler
    if LOG_TO_CONSOLE:
        console = logging.StreamHandler(sys.stdout)
        console.setLevel(logging.DEBUG if DEBUG_MODE else LEVEL_MAP.get(LOG_LEVEL, logging.INFO))
        
        if LOG_FORMAT == "json":
            console.setFormatter(JSONFormatter())
        else:
            console.setFormatter(StandardFormatter(use_colors=True))
        
        root.addHandler(console)
    
    # File handler
    if LOG_TO_FILE:
        try:
            # Main log file (rotating)
            file_handler = logging.handlers.RotatingFileHandler(
                DEFAULT_LOG_FILE,
                maxBytes=10 * 1024 * 1024,  # 10 MB
                backupCount=5,
                encoding='utf-8'
            )
            file_handler.setLevel(logging.DEBUG)
            file_handler.setFormatter(FileFormatter())
            root.addHandler(file_handler)
            
            # Error log file
            error_handler = logging.handlers.RotatingFileHandler(
                DEFAULT_ERROR_LOG,
                maxBytes=5 * 1024 * 1024,  # 5 MB
                backupCount=3,
                encoding='utf-8'
            )
            error_handler.setLevel(logging.ERROR)
            error_handler.setFormatter(FileFormatter())
            root.addHandler(error_handler)
            
        except Exception as e:
            print(f"Warning: Could not set up file logging: {e}", file=sys.stderr)
    
    _root_configured = True


def get_logger(name: str = "ava") -> logging.Logger:
    """Get a logger instance for a component.
    
    Args:
        name: Component name (will be prefixed with 'ava.')
        
    Returns:
        Configured logger instance
    """
    _setup_root_logger()
    
    # Normalize name
    if not name.startswith('ava.'):
        full_name = f'ava.{name}'
    else:
        full_name = name
    
    if full_name in _loggers:
        return _loggers[full_name]
    
    logger = logging.getLogger(full_name)
    _loggers[full_name] = logger
    
    return logger


# =============================================================================
# CONVENIENCE FUNCTIONS
# =============================================================================

def log_debug(message: str, component: str = "ava", **kwargs):
    """Log a debug message"""
    get_logger(component).debug(message, **kwargs)


def log_info(message: str, component: str = "ava", **kwargs):
    """Log an info message"""
    get_logger(component).info(message, **kwargs)


def log_warning(message: str, component: str = "ava", **kwargs):
    """Log a warning message"""
    get_logger(component).warning(message, **kwargs)


def log_error(message: str, component: str = "ava", exc_info: bool = False, **kwargs):
    """Log an error message"""
    get_logger(component).error(message, exc_info=exc_info, **kwargs)


def log_critical(message: str, component: str = "ava", **kwargs):
    """Log a critical message"""
    get_logger(component).critical(message, **kwargs)


def log_exception(message: str, component: str = "ava"):
    """Log an exception with full traceback"""
    get_logger(component).exception(message)


# =============================================================================
# SPECIALIZED LOGGING
# =============================================================================

def log_tool_call(tool_name: str, args: dict, result: Any = None, duration_ms: float = None):
    """Log a tool call with structured data"""
    logger = get_logger("tools")
    
    if not DEBUG_TOOLS and not DEBUG_MODE:
        return
    
    msg = f"Tool: {tool_name}"
    if duration_ms:
        msg += f" ({duration_ms:.1f}ms)"
    
    logger.debug(msg)
    
    if DEBUG_MODE:
        logger.debug(f"  Args: {json.dumps(args, default=str)[:500]}")
        if result:
            logger.debug(f"  Result: {json.dumps(result, default=str)[:500]}")


def log_asr_event(event_type: str, data: Any = None):
    """Log an ASR (speech recognition) event"""
    if not DEBUG_ASR and not DEBUG_MODE:
        return
    
    logger = get_logger("asr")
    msg = f"ASR: {event_type}"
    
    if data:
        if isinstance(data, str):
            msg += f" - {data[:200]}"
        else:
            msg += f" - {json.dumps(data, default=str)[:200]}"
    
    logger.debug(msg)


def log_agent_event(event_type: str, data: Any = None):
    """Log an agent event"""
    if not DEBUG_AGENT and not DEBUG_MODE:
        return
    
    logger = get_logger("agent")
    msg = f"Agent: {event_type}"
    
    if data:
        if isinstance(data, str):
            msg += f" - {data[:300]}"
        else:
            msg += f" - {json.dumps(data, default=str)[:300]}"
    
    logger.debug(msg)


# =============================================================================
# PERFORMANCE LOGGING
# =============================================================================

def log_timing(operation: str):
    """Decorator to log function execution time"""
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            start = time.perf_counter()
            try:
                result = func(*args, **kwargs)
                duration = (time.perf_counter() - start) * 1000
                
                if DEBUG_MODE or duration > 1000:  # Log if debug or > 1 second
                    get_logger("perf").debug(f"{operation}: {duration:.1f}ms")
                
                return result
            except Exception as e:
                duration = (time.perf_counter() - start) * 1000
                get_logger("perf").error(f"{operation} FAILED after {duration:.1f}ms: {e}")
                raise
        return wrapper
    return decorator


class TimingContext:
    """Context manager for timing operations"""
    
    def __init__(self, operation: str, component: str = "perf"):
        self.operation = operation
        self.component = component
        self.start = None
    
    def __enter__(self):
        self.start = time.perf_counter()
        return self
    
    def __exit__(self, exc_type, exc_val, exc_tb):
        duration = (time.perf_counter() - self.start) * 1000
        logger = get_logger(self.component)
        
        if exc_type:
            logger.error(f"{self.operation} FAILED after {duration:.1f}ms: {exc_val}")
        elif DEBUG_MODE or duration > 1000:
            logger.debug(f"{self.operation}: {duration:.1f}ms")


# =============================================================================
# CONFIGURATION HELPERS
# =============================================================================

def load_debug_config():
    """Load debug configuration from ava_voice_config.json"""
    global DEBUG_ASR, DEBUG_AGENT, DEBUG_TOOLS, DEBUG_MODE
    
    config_path = DEFAULT_LOG_DIR / "ava_voice_config.json"
    
    try:
        if config_path.exists():
            with open(config_path, 'r') as f:
                config = json.load(f)
            
            DEBUG_ASR = config.get('debug_asr', False)
            DEBUG_AGENT = config.get('debug_agent', False)
            DEBUG_TOOLS = config.get('debug_tools', False)
            DEBUG_MODE = config.get('debug', False)
            
            get_logger().debug(f"Loaded debug config: asr={DEBUG_ASR}, agent={DEBUG_AGENT}, tools={DEBUG_TOOLS}")
    except Exception as e:
        get_logger().warning(f"Could not load debug config: {e}")


def set_log_level(level: str):
    """Change the log level at runtime"""
    global LOG_LEVEL
    
    level = level.upper()
    if level in LEVEL_MAP:
        LOG_LEVEL = level
        root = logging.getLogger('ava')
        root.setLevel(LEVEL_MAP[level])
        
        for handler in root.handlers:
            if isinstance(handler, logging.StreamHandler) and handler.stream == sys.stdout:
                handler.setLevel(LEVEL_MAP[level])
        
        get_logger().info(f"Log level changed to {level}")
    else:
        get_logger().warning(f"Invalid log level: {level}")


def get_log_stats() -> Dict[str, Any]:
    """Get logging statistics"""
    return {
        "log_level": LOG_LEVEL,
        "log_format": LOG_FORMAT,
        "log_to_file": LOG_TO_FILE,
        "log_to_console": LOG_TO_CONSOLE,
        "debug_mode": DEBUG_MODE,
        "debug_asr": DEBUG_ASR,
        "debug_agent": DEBUG_AGENT,
        "debug_tools": DEBUG_TOOLS,
        "log_file": str(DEFAULT_LOG_FILE),
        "error_log": str(DEFAULT_ERROR_LOG),
        "active_loggers": list(_loggers.keys())
    }


# =============================================================================
# PRINT REPLACEMENT
# =============================================================================

class LogPrint:
    """Drop-in replacement for print() that uses logging.
    
    Usage:
        from ava_logging import log_print as print
    """
    
    def __init__(self, component: str = "output"):
        self.logger = get_logger(component)
    
    def __call__(self, *args, **kwargs):
        """Handle print() calls"""
        # Get the message
        sep = kwargs.get('sep', ' ')
        message = sep.join(str(arg) for arg in args)
        
        # Determine log level from message content
        msg_lower = message.lower()
        
        if any(x in msg_lower for x in ['error', 'fail', 'exception', '❌']):
            self.logger.error(message)
        elif any(x in msg_lower for x in ['warn', 'warning', '⚠']):
            self.logger.warning(message)
        elif any(x in msg_lower for x in ['debug', '[d]']):
            self.logger.debug(message)
        else:
            self.logger.info(message)


# Global print replacement instance
log_print = LogPrint()


# =============================================================================
# CLI
# =============================================================================

def main():
    """CLI for testing and configuring logging"""
    import argparse
    
    parser = argparse.ArgumentParser(description="AVA Logging Framework")
    parser.add_argument("command", choices=["test", "stats", "tail", "clear"])
    parser.add_argument("--level", default="INFO", help="Log level for test")
    
    args = parser.parse_args()
    
    if args.command == "test":
        set_log_level(args.level)
        
        logger = get_logger("test")
        print(f"\n📋 Testing logging at level: {args.level}\n")
        
        logger.debug("This is a DEBUG message")
        logger.info("This is an INFO message")
        logger.warning("This is a WARNING message")
        logger.error("This is an ERROR message")
        
        try:
            raise ValueError("Test exception")
        except:
            logger.exception("This is an EXCEPTION message")
        
        log_tool_call("test_tool", {"arg1": "value1"}, {"result": "ok"}, 123.4)
        
        print("\n✅ Logging test complete")
    
    elif args.command == "stats":
        stats = get_log_stats()
        print("\n📊 Logging Statistics:\n")
        for key, value in stats.items():
            print(f"  {key}: {value}")
    
    elif args.command == "tail":
        if DEFAULT_LOG_FILE.exists():
            with open(DEFAULT_LOG_FILE, 'r') as f:
                lines = f.readlines()
                for line in lines[-50:]:
                    print(line.rstrip())
        else:
            print("No log file found")
    
    elif args.command == "clear":
        for log_file in [DEFAULT_LOG_FILE, DEFAULT_ERROR_LOG]:
            if log_file.exists():
                log_file.unlink()
                print(f"Deleted: {log_file}")


if __name__ == "__main__":
    main()
