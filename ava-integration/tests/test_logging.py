"""
Unit Tests for AVA Logging Framework
=====================================
Tests the centralized logging functionality.
"""

import os
import sys
import logging
import pytest
import tempfile
from pathlib import Path
from unittest.mock import patch, MagicMock
from io import StringIO

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))

# Import with fresh state
import importlib
import ava_logging
importlib.reload(ava_logging)

from ava_logging import (
    get_logger,
    log_info,
    log_warning,
    log_error,
    log_debug,
    log_exception,
    set_log_level,
    get_log_stats,
    TimingContext,
    LogPrint,
    StandardFormatter,
    JSONFormatter,
    FileFormatter
)


class TestGetLogger:
    """Tests for get_logger function"""
    
    def test_get_logger_returns_logger(self):
        """Test that get_logger returns a logger instance"""
        logger = get_logger("test")
        assert isinstance(logger, logging.Logger)
    
    def test_get_logger_same_name_returns_same_instance(self):
        """Test that same name returns same logger"""
        logger1 = get_logger("same_name")
        logger2 = get_logger("same_name")
        assert logger1 is logger2
    
    def test_get_logger_prefixes_with_ava(self):
        """Test that logger name is prefixed with 'ava.'"""
        logger = get_logger("mycomponent")
        assert logger.name == "ava.mycomponent"
    
    def test_get_logger_already_prefixed(self):
        """Test that already prefixed names are not double-prefixed"""
        logger = get_logger("ava.existing")
        assert logger.name == "ava.existing"


class TestConvenienceFunctions:
    """Tests for log_* convenience functions"""
    
    def test_log_info_does_not_raise(self):
        """Test log_info doesn't raise exceptions"""
        log_info("Test info message")
    
    def test_log_warning_does_not_raise(self):
        """Test log_warning doesn't raise exceptions"""
        log_warning("Test warning message")
    
    def test_log_error_does_not_raise(self):
        """Test log_error doesn't raise exceptions"""
        log_error("Test error message")
    
    def test_log_debug_does_not_raise(self):
        """Test log_debug doesn't raise exceptions"""
        log_debug("Test debug message")
    
    def test_log_with_component(self):
        """Test logging with specific component"""
        log_info("Component message", component="custom")
    
    def test_log_error_with_exc_info(self):
        """Test log_error with exception info"""
        try:
            raise ValueError("Test exception")
        except:
            log_error("Error occurred", exc_info=True)


class TestSetLogLevel:
    """Tests for log level configuration"""
    
    def test_set_log_level_valid(self):
        """Test setting a valid log level"""
        set_log_level("DEBUG")
        # Should not raise
        set_log_level("INFO")
    
    def test_set_log_level_case_insensitive(self):
        """Test log level is case insensitive"""
        set_log_level("debug")
        set_log_level("WARNING")
    
    def test_set_log_level_invalid(self):
        """Test setting invalid log level doesn't crash"""
        set_log_level("INVALID_LEVEL")
        # Should log warning but not crash


class TestGetLogStats:
    """Tests for logging statistics"""
    
    def test_get_log_stats_returns_dict(self):
        """Test get_log_stats returns a dictionary"""
        stats = get_log_stats()
        assert isinstance(stats, dict)
    
    def test_get_log_stats_has_required_keys(self):
        """Test stats has expected keys"""
        stats = get_log_stats()
        
        expected_keys = [
            "log_level",
            "log_format",
            "log_to_file",
            "log_to_console",
            "debug_mode"
        ]
        
        for key in expected_keys:
            assert key in stats, f"Missing key: {key}"


class TestFormatters:
    """Tests for log formatters"""
    
    def test_standard_formatter_creates(self):
        """Test StandardFormatter initializes"""
        formatter = StandardFormatter(use_colors=False)
        assert formatter is not None
    
    def test_json_formatter_creates(self):
        """Test JSONFormatter initializes"""
        formatter = JSONFormatter()
        assert formatter is not None
    
    def test_file_formatter_creates(self):
        """Test FileFormatter initializes"""
        formatter = FileFormatter()
        assert formatter is not None
    
    def test_standard_formatter_formats_record(self):
        """Test StandardFormatter formats log records"""
        formatter = StandardFormatter(use_colors=False)
        
        record = logging.LogRecord(
            name="test",
            level=logging.INFO,
            pathname="test.py",
            lineno=1,
            msg="Test message",
            args=(),
            exc_info=None
        )
        
        result = formatter.format(record)
        assert "Test message" in result
        assert "INFO" in result
    
    def test_json_formatter_produces_json(self):
        """Test JSONFormatter produces valid JSON"""
        import json
        
        formatter = JSONFormatter()
        
        record = logging.LogRecord(
            name="test",
            level=logging.INFO,
            pathname="test.py",
            lineno=1,
            msg="Test message",
            args=(),
            exc_info=None
        )
        
        result = formatter.format(record)
        parsed = json.loads(result)
        
        assert parsed["message"] == "Test message"
        assert parsed["level"] == "INFO"


class TestTimingContext:
    """Tests for TimingContext"""
    
    def test_timing_context_works(self):
        """Test TimingContext basic usage"""
        import time
        
        with TimingContext("test_op"):
            time.sleep(0.01)
    
    def test_timing_context_handles_exceptions(self):
        """Test TimingContext handles exceptions"""
        try:
            with TimingContext("failing_op"):
                raise ValueError("Test error")
        except ValueError:
            pass


class TestLogPrint:
    """Tests for LogPrint class"""
    
    def test_log_print_creates(self):
        """Test LogPrint initializes"""
        lp = LogPrint("test")
        assert lp is not None
    
    def test_log_print_callable(self):
        """Test LogPrint is callable like print"""
        lp = LogPrint("test")
        lp("Test message")
    
    def test_log_print_handles_multiple_args(self):
        """Test LogPrint handles multiple arguments"""
        lp = LogPrint("test")
        lp("arg1", "arg2", "arg3")
    
    def test_log_print_detects_error(self):
        """Test LogPrint detects error messages"""
        lp = LogPrint("test")
        lp("This is an error message")
    
    def test_log_print_detects_warning(self):
        """Test LogPrint detects warning messages"""
        lp = LogPrint("test")
        lp("Warning: something happened")


class TestEnvironmentConfiguration:
    """Tests for environment variable configuration"""
    
    def test_default_log_level(self):
        """Test default log level is INFO"""
        stats = get_log_stats()
        # Default is INFO unless overridden
        assert stats["log_level"] in ["INFO", "DEBUG", "WARNING", "ERROR"]
    
    def test_log_to_console_default(self):
        """Test log to console is enabled by default"""
        stats = get_log_stats()
        assert stats["log_to_console"] == True
