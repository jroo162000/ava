"""
AVA Test Suite - Shared Fixtures and Configuration
===================================================
"""

import os
import sys
import pytest
import tempfile
import sqlite3
from pathlib import Path
from unittest.mock import MagicMock, patch

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))


@pytest.fixture
def temp_db():
    """Create a temporary SQLite database for testing"""
    with tempfile.NamedTemporaryFile(suffix='.db', delete=False) as f:
        db_path = Path(f.name)
    
    yield db_path
    
    # Cleanup
    try:
        os.unlink(db_path)
    except:
        pass


@pytest.fixture
def temp_dir():
    """Create a temporary directory for testing"""
    with tempfile.TemporaryDirectory() as td:
        yield Path(td)


@pytest.fixture
def mock_identity():
    """Mock AVA identity configuration"""
    return {
        "name": "TestAVA",
        "developer": "TestUser",
        "purpose": "Testing assistant",
        "home": str(Path.home()),
        "location": "/test/path"
    }


@pytest.fixture
def mock_voice_config():
    """Mock voice configuration"""
    return {
        "speak_symbols": False,
        "server_url": "http://127.0.0.1:5051/respond",
        "vad": {"start_rms": 1600, "stop_rms": 900, "hold_sec": 0.6},
        "debug_asr": False,
        "debug_agent": False
    }


@pytest.fixture
def sample_correction():
    """Sample correction data for testing"""
    return {
        "user_input": "What time is my meeting?",
        "wrong": "You have no meetings scheduled.",
        "correct": "You have a meeting at 3pm.",
        "context": "Calendar access was working"
    }


@pytest.fixture
def sample_fact():
    """Sample learned fact for testing"""
    return {
        "category": "preference",
        "key": "preferred_name",
        "value": "John",
        "source": "explicit_statement",
        "confidence": 1.0
    }


@pytest.fixture
def learning_db_schema():
    """SQL schema for learning database - matches actual implementation"""
    return """
    CREATE TABLE IF NOT EXISTS learned_facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT,
        source TEXT,
        confidence REAL DEFAULT 1.0,
        timestamp TEXT NOT NULL,
        UNIQUE(category, key)
    );
    
    CREATE TABLE IF NOT EXISTS corrections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_input TEXT NOT NULL,
        wrong_interpretation TEXT,
        correct_interpretation TEXT,
        context TEXT,
        created_at TEXT NOT NULL
    );
    
    CREATE TABLE IF NOT EXISTS patterns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pattern_type TEXT NOT NULL,
        pattern_data TEXT NOT NULL,
        frequency INTEGER DEFAULT 1,
        last_used TEXT NOT NULL,
        created_at TEXT NOT NULL
    );
    
    CREATE TABLE IF NOT EXISTS preferences (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        confidence REAL DEFAULT 1.0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(category, key)
    );
    """


@pytest.fixture
def initialized_learning_db(temp_db, learning_db_schema):
    """Initialize a learning database with schema"""
    conn = sqlite3.connect(str(temp_db))
    conn.executescript(learning_db_schema)
    conn.commit()
    conn.close()
    return temp_db


class MockPsutil:
    """Mock psutil for system state testing"""
    @staticmethod
    def cpu_percent():
        return 25.5
    
    @staticmethod
    def virtual_memory():
        return MagicMock(percent=45.0, total=16000000000)
    
    @staticmethod
    def disk_usage(path):
        return MagicMock(percent=60.0, free=100000000000)
    
    @staticmethod
    def boot_time():
        import time
        return time.time() - 3600  # 1 hour ago


@pytest.fixture
def mock_psutil():
    """Provide mock psutil for testing"""
    return MockPsutil()
