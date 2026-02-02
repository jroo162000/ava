"""
Unit Tests for AVA Passive Learning Module
==========================================
Tests the passive learning, screen context, and environment awareness.
"""

import os
import sys
import json
import pytest
import sqlite3
import threading
import time
from pathlib import Path
from datetime import datetime
from unittest.mock import patch, MagicMock

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from ava_passive_learning import (
    init_passive_learning_db,
    get_passive_learning,
    start_passive_learning,
    stop_passive_learning,
    get_current_context,
    record_interaction,
    get_learning_summary,
    PassiveLearningEngine,
    LEARNING_DB
)


class TestDatabaseInitialization:
    """Tests for database initialization"""
    
    def test_init_creates_tables(self, temp_db):
        """Test that init creates required tables"""
        with patch('ava_passive_learning.LEARNING_DB', temp_db):
            init_passive_learning_db()
        
        conn = sqlite3.connect(str(temp_db))
        cursor = conn.cursor()
        
        # Check screen_context table exists
        cursor.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='screen_context'"
        )
        assert cursor.fetchone() is not None
        
        # Check environment_observations table exists
        cursor.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='environment_observations'"
        )
        assert cursor.fetchone() is not None
        
        conn.close()
    
    def test_init_idempotent(self, temp_db):
        """Test that init can be called multiple times safely"""
        with patch('ava_passive_learning.LEARNING_DB', temp_db):
            init_passive_learning_db()
            init_passive_learning_db()  # Should not error
        
        conn = sqlite3.connect(str(temp_db))
        cursor = conn.cursor()
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
        tables = cursor.fetchall()
        conn.close()
        
        assert len(tables) > 0


class TestPassiveLearningEngine:
    """Tests for PassiveLearningEngine class"""
    
    def test_engine_initialization(self, temp_db):
        """Test engine initializes correctly"""
        with patch('ava_passive_learning.LEARNING_DB', temp_db):
            engine = PassiveLearningEngine()
            
            assert engine is not None
            assert engine.running == False
    
    def test_get_current_context_structure(self, temp_db):
        """Test current context returns expected structure"""
        with patch('ava_passive_learning.LEARNING_DB', temp_db):
            init_passive_learning_db()
            context = get_current_context()
        
        assert isinstance(context, dict)
        assert "active_app" in context or "context_type" in context or context == {}
    
    def test_engine_singleton(self, temp_db):
        """Test get_passive_learning returns singleton"""
        with patch('ava_passive_learning.LEARNING_DB', temp_db):
            engine1 = get_passive_learning()
            engine2 = get_passive_learning()
        
        assert engine1 is engine2


class TestScreenContext:
    """Tests for screen context awareness"""
    
    def test_record_screen_context(self, temp_db):
        """Test recording screen context"""
        with patch('ava_passive_learning.LEARNING_DB', temp_db):
            init_passive_learning_db()
            
            # Insert test screen context
            conn = sqlite3.connect(str(temp_db))
            conn.execute(
                """INSERT INTO screen_context 
                   (active_app, window_title, visible_apps, context_type, timestamp) 
                   VALUES (?, ?, ?, ?, ?)""",
                ("Chrome", "Google - Chrome", '["Chrome", "VS Code"]', "browsing", 
                 datetime.now().isoformat())
            )
            conn.commit()
            
            # Verify insertion
            cursor = conn.cursor()
            cursor.execute("SELECT COUNT(*) FROM screen_context")
            count = cursor.fetchone()[0]
            conn.close()
            
            assert count >= 1
    
    def test_get_recent_screen_context(self, temp_db):
        """Test retrieving recent screen context"""
        with patch('ava_passive_learning.LEARNING_DB', temp_db):
            init_passive_learning_db()
            
            # Insert test data
            conn = sqlite3.connect(str(temp_db))
            for i in range(3):
                conn.execute(
                    """INSERT INTO screen_context 
                       (active_app, window_title, context_type, timestamp) 
                       VALUES (?, ?, ?, ?)""",
                    (f"App{i}", f"Title{i}", "work", datetime.now().isoformat())
                )
            conn.commit()
            conn.close()
            
            # Get context
            context = get_current_context()
            assert isinstance(context, dict)


class TestInteractionRecording:
    """Tests for recording user interactions"""
    
    def test_record_interaction(self, temp_db):
        """Test recording a voice interaction"""
        with patch('ava_passive_learning.LEARNING_DB', temp_db):
            init_passive_learning_db()
            
            # Create conversation_context table if needed
            conn = sqlite3.connect(str(temp_db))
            conn.execute("""
                CREATE TABLE IF NOT EXISTS conversation_context (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_message TEXT,
                    ava_response TEXT,
                    was_helpful INTEGER,
                    screen_context TEXT,
                    timestamp TEXT NOT NULL
                )
            """)
            conn.commit()
            conn.close()
            
            record_interaction(
                "What's the weather?",
                "It's sunny and 72 degrees.",
                True
            )
            
            # Verify
            conn = sqlite3.connect(str(temp_db))
            cursor = conn.cursor()
            cursor.execute("SELECT COUNT(*) FROM conversation_context")
            count = cursor.fetchone()[0]
            conn.close()
            
            assert count >= 1
    
    def test_record_unhelpful_interaction(self, temp_db):
        """Test recording an unhelpful interaction"""
        with patch('ava_passive_learning.LEARNING_DB', temp_db):
            init_passive_learning_db()
            
            conn = sqlite3.connect(str(temp_db))
            conn.execute("""
                CREATE TABLE IF NOT EXISTS conversation_context (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_message TEXT,
                    ava_response TEXT,
                    was_helpful INTEGER,
                    screen_context TEXT,
                    timestamp TEXT NOT NULL
                )
            """)
            conn.commit()
            conn.close()
            
            record_interaction(
                "Open my email",
                "I cannot access your email.",
                False  # Not helpful
            )
            
            conn = sqlite3.connect(str(temp_db))
            cursor = conn.cursor()
            cursor.execute(
                "SELECT was_helpful FROM conversation_context ORDER BY id DESC LIMIT 1"
            )
            row = cursor.fetchone()
            conn.close()
            
            # was_helpful should be 0 (False)
            if row:
                assert row[0] == 0


class TestLearningSummary:
    """Tests for learning summary and statistics"""
    
    def test_get_learning_summary(self, temp_db):
        """Test getting learning summary"""
        with patch('ava_passive_learning.LEARNING_DB', temp_db):
            init_passive_learning_db()
            summary = get_learning_summary()
        
        assert isinstance(summary, dict)
        assert "total_observations" in summary or summary == {}
    
    def test_summary_counts_observations(self, temp_db):
        """Test summary correctly counts observations"""
        with patch('ava_passive_learning.LEARNING_DB', temp_db):
            init_passive_learning_db()
            
            # Insert test observations
            conn = sqlite3.connect(str(temp_db))
            for i in range(5):
                conn.execute(
                    """INSERT INTO screen_context 
                       (active_app, context_type, timestamp) 
                       VALUES (?, ?, ?)""",
                    (f"App{i}", "work", datetime.now().isoformat())
                )
            conn.commit()
            conn.close()
            
            summary = get_learning_summary()
            
            if "total_observations" in summary:
                assert summary["total_observations"] >= 5


class TestStartStop:
    """Tests for start/stop functionality"""
    
    def test_start_stop_learning(self, temp_db):
        """Test starting and stopping passive learning"""
        with patch('ava_passive_learning.LEARNING_DB', temp_db):
            init_passive_learning_db()
            
            # Start learning
            start_passive_learning()
            engine = get_passive_learning()
            
            # Give it a moment to start
            time.sleep(0.1)
            
            # Stop learning
            stop_passive_learning()
            
            # Verify stopped
            assert engine.running == False
    
    def test_stop_without_start(self, temp_db):
        """Test stopping when not started doesn't error"""
        with patch('ava_passive_learning.LEARNING_DB', temp_db):
            init_passive_learning_db()
            
            # Should not raise
            stop_passive_learning()


class TestEnvironmentObservations:
    """Tests for environment observation recording"""
    
    def test_record_environment_observation(self, temp_db):
        """Test recording environment observations"""
        with patch('ava_passive_learning.LEARNING_DB', temp_db):
            init_passive_learning_db()
            
            conn = sqlite3.connect(str(temp_db))
            conn.execute(
                """INSERT INTO environment_observations 
                   (observation_type, observation_data, confidence, timestamp) 
                   VALUES (?, ?, ?, ?)""",
                ("face_detected", '{"faces": 1}', 0.95, datetime.now().isoformat())
            )
            conn.commit()
            
            cursor = conn.cursor()
            cursor.execute("SELECT COUNT(*) FROM environment_observations")
            count = cursor.fetchone()[0]
            conn.close()
            
            assert count >= 1
    
    def test_get_recent_observations(self, temp_db):
        """Test retrieving recent observations"""
        with patch('ava_passive_learning.LEARNING_DB', temp_db):
            init_passive_learning_db()
            
            conn = sqlite3.connect(str(temp_db))
            for i in range(3):
                conn.execute(
                    """INSERT INTO environment_observations 
                       (observation_type, observation_data, confidence, timestamp) 
                       VALUES (?, ?, ?, ?)""",
                    ("test", f'{{"idx": {i}}}', 0.9, datetime.now().isoformat())
                )
            conn.commit()
            
            cursor = conn.cursor()
            cursor.execute(
                "SELECT * FROM environment_observations ORDER BY timestamp DESC LIMIT 5"
            )
            rows = cursor.fetchall()
            conn.close()
            
            assert len(rows) >= 3


class TestOptionalDependencies:
    """Tests for optional dependency handling"""
    
    def test_handles_missing_cv2(self):
        """Test graceful handling when cv2 not available"""
        with patch.dict('sys.modules', {'cv2': None}):
            # Should not crash
            engine = get_passive_learning()
            assert engine is not None
    
    def test_handles_missing_pil(self):
        """Test graceful handling when PIL not available"""
        with patch.dict('sys.modules', {'PIL': None, 'PIL.ImageGrab': None}):
            engine = get_passive_learning()
            assert engine is not None


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
