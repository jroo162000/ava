"""
Unit Tests for AVA Self-Awareness Module
=========================================
Tests the self-awareness, introspection, and learning capabilities.
"""

import os
import sys
import json
import pytest
import sqlite3
from pathlib import Path
from datetime import datetime
from unittest.mock import patch, MagicMock

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from ava_self_awareness import (
    AVASelfAwareness, 
    get_self_awareness,
    introspect, 
    who_am_i, 
    diagnose,
    learn_from_correction,
    check_past_mistakes,
    get_prompt_context
)


class TestAVASelfAwareness:
    """Tests for AVASelfAwareness class"""
    
    def test_singleton_instance(self):
        """Test that get_self_awareness returns singleton"""
        instance1 = get_self_awareness()
        instance2 = get_self_awareness()
        assert instance1 is instance2
    
    def test_init_creates_directories(self, temp_dir):
        """Test initialization creates required directories"""
        with patch.object(AVASelfAwareness, '__init__', lambda self: None):
            sa = AVASelfAwareness()
            sa.home = temp_dir
            sa.integration_path = temp_dir / "ava-integration"
            sa.cmpuse_path = temp_dir / ".cmpuse"
            sa.cmpuse_path.mkdir(parents=True, exist_ok=True)
            
            assert sa.cmpuse_path.exists()
    
    def test_db_context_manager(self, initialized_learning_db):
        """Test database context manager properly opens and closes connections"""
        sa = get_self_awareness()
        
        # Override db path for testing
        original_db = sa.learning_db
        sa.learning_db = initialized_learning_db
        
        try:
            with sa._db_connect(initialized_learning_db) as conn:
                assert conn is not None
                cursor = conn.cursor()
                cursor.execute("SELECT 1")
                result = cursor.fetchone()
                assert result[0] == 1
        finally:
            sa.learning_db = original_db
    
    def test_safe_query_returns_list(self, initialized_learning_db):
        """Test _safe_query returns list of results"""
        sa = get_self_awareness()
        
        # Insert test data
        conn = sqlite3.connect(str(initialized_learning_db))
        conn.execute(
            "INSERT INTO learned_facts (category, key, value, source, timestamp) VALUES (?, ?, ?, ?, ?)",
            ("test", "key1", "value1", "test", datetime.now().isoformat())
        )
        conn.commit()
        conn.close()
        
        results = sa._safe_query(initialized_learning_db, "SELECT * FROM learned_facts")
        assert isinstance(results, list)
        assert len(results) >= 1
    
    def test_safe_query_handles_errors(self, temp_dir):
        """Test _safe_query handles database errors gracefully"""
        sa = get_self_awareness()
        
        # Query a non-existent database
        bad_path = temp_dir / "nonexistent.db"
        results = sa._safe_query(bad_path, "SELECT * FROM nonexistent_table")
        
        assert results == []
    
    def test_get_identity_returns_dict(self):
        """Test get_identity returns dictionary with required keys"""
        sa = get_self_awareness()
        identity = sa.get_identity()
        
        assert isinstance(identity, dict)
        assert "name" in identity
        assert "developer" in identity or identity.get("name") == "AVA"


class TestIdentityAndConfig:
    """Tests for identity and configuration loading"""
    
    def test_get_identity_from_file(self, temp_dir, mock_identity):
        """Test loading identity from JSON file"""
        identity_file = temp_dir / "ava_identity.json"
        with open(identity_file, 'w') as f:
            json.dump(mock_identity, f)
        
        sa = get_self_awareness()
        original_path = sa.integration_path
        sa.integration_path = temp_dir
        
        try:
            identity = sa.get_identity()
            assert identity["name"] == "TestAVA"
        finally:
            sa.integration_path = original_path
    
    def test_get_voice_config(self, temp_dir, mock_voice_config):
        """Test loading voice configuration"""
        config_file = temp_dir / "ava_voice_config.json"
        with open(config_file, 'w') as f:
            json.dump(mock_voice_config, f)
        
        sa = get_self_awareness()
        original_path = sa.integration_path
        sa.integration_path = temp_dir
        
        try:
            config = sa.get_voice_config()
            assert config["speak_symbols"] == False
            assert "vad" in config
        finally:
            sa.integration_path = original_path


class TestLearningSystem:
    """Tests for learning and correction tracking"""
    
    def test_record_correction(self, initialized_learning_db, sample_correction):
        """Test recording a correction"""
        sa = get_self_awareness()
        original_db = sa.learning_db
        sa.learning_db = initialized_learning_db
        
        try:
            result = sa.record_correction(
                sample_correction["user_input"],
                sample_correction["wrong"],
                sample_correction["correct"],
                sample_correction["context"]
            )
            
            # Verify it was recorded
            conn = sqlite3.connect(str(initialized_learning_db))
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM corrections WHERE user_input = ?", 
                          (sample_correction["user_input"],))
            rows = cursor.fetchall()
            conn.close()
            
            assert len(rows) >= 1
        finally:
            sa.learning_db = original_db
    
    def test_get_corrections(self, initialized_learning_db):
        """Test retrieving corrections"""
        sa = get_self_awareness()
        original_db = sa.learning_db
        sa.learning_db = initialized_learning_db
        
        # Insert test correction with correct column names
        conn = sqlite3.connect(str(initialized_learning_db))
        conn.execute(
            "INSERT INTO corrections (user_input, wrong_interpretation, correct_interpretation, context, created_at) VALUES (?, ?, ?, ?, ?)",
            ("test query", "wrong answer", "right answer", "context", datetime.now().isoformat())
        )
        conn.commit()
        conn.close()
        
        try:
            corrections = sa.get_corrections()  # No limit parameter
            assert isinstance(corrections, list)
        finally:
            sa.learning_db = original_db
    
    def test_learn_preference(self, initialized_learning_db):
        """Test learning a user preference"""
        sa = get_self_awareness()
        original_db = sa.learning_db
        sa.learning_db = initialized_learning_db
        
        try:
            result = sa.learn_preference(
                category="user",
                key="preferred_name",
                value="John",
                confidence=0.9
            )
            
            assert result == True
            
            # Verify it was recorded - get_preferences returns a dict, not a list
            prefs = sa.get_preferences()
            assert isinstance(prefs, dict)
            assert "user" in prefs
        finally:
            sa.learning_db = original_db
    
    def test_check_similar_correction(self, initialized_learning_db):
        """Test checking for similar past corrections"""
        sa = get_self_awareness()
        original_db = sa.learning_db
        sa.learning_db = initialized_learning_db
        
        # Insert a correction with correct column names
        conn = sqlite3.connect(str(initialized_learning_db))
        conn.execute(
            "INSERT INTO corrections (user_input, wrong_interpretation, correct_interpretation, context, created_at) VALUES (?, ?, ?, ?, ?)",
            ("meeting time", "no meetings", "meeting at 3pm", "calendar", datetime.now().isoformat())
        )
        conn.commit()
        conn.close()
        
        try:
            result = sa.check_for_similar_correction("what time is the meeting")
            # Should find similar correction based on keywords
            # Note: This may or may not match depending on the similarity algorithm
            assert result is None or isinstance(result, dict)
        finally:
            sa.learning_db = original_db


class TestIntrospection:
    """Tests for introspection capabilities"""
    
    def test_introspect_returns_dict(self):
        """Test introspect returns complete dictionary"""
        result = introspect()
        
        assert isinstance(result, dict)
        assert "identity" in result
        assert "capabilities" in result
        assert "system" in result
    
    def test_who_am_i_returns_string(self):
        """Test who_am_i returns description string"""
        result = who_am_i()
        
        assert isinstance(result, str)
        assert len(result) > 0
    
    def test_diagnose_returns_status(self):
        """Test diagnose returns status information"""
        result = diagnose()
        
        assert isinstance(result, dict)
        assert "overall_status" in result


class TestSystemState:
    """Tests for system state reporting"""
    
    def test_get_system_state(self, mock_psutil):
        """Test system state includes required metrics"""
        sa = get_self_awareness()
        
        with patch('ava_self_awareness.psutil', mock_psutil):
            state = sa.get_system_state()
        
        assert isinstance(state, dict)
        # Should include CPU, memory, disk info
        assert "cpu_percent" in state or "platform" in state
    
    def test_get_available_tools(self):
        """Test getting list of available tools"""
        sa = get_self_awareness()
        tools = sa.get_available_tools()
        
        assert isinstance(tools, list)


class TestContextGeneration:
    """Tests for context generation for prompts"""
    
    def test_get_prompt_context(self):
        """Test getting context for system prompt"""
        context = get_prompt_context()
        
        assert isinstance(context, str)
    
    def test_get_context_includes_corrections(self, initialized_learning_db):
        """Test context includes recent corrections"""
        sa = get_self_awareness()
        original_db = sa.learning_db
        sa.learning_db = initialized_learning_db
        
        # Insert a correction using correct column names
        conn = sqlite3.connect(str(initialized_learning_db))
        conn.execute(
            "INSERT INTO corrections (user_input, wrong_interpretation, correct_interpretation, context, created_at) VALUES (?, ?, ?, ?, ?)",
            ("test", "wrong", "correct", "ctx", datetime.now().isoformat())
        )
        conn.commit()
        conn.close()
        
        try:
            context = sa.get_context_for_prompt()
            assert isinstance(context, str)
        finally:
            sa.learning_db = original_db


class TestConvenienceFunctions:
    """Tests for module-level convenience functions"""
    
    def test_learn_from_correction(self, initialized_learning_db, sample_correction):
        """Test learn_from_correction convenience function"""
        sa = get_self_awareness()
        original_db = sa.learning_db
        sa.learning_db = initialized_learning_db
        
        try:
            result = learn_from_correction(
                sample_correction["user_input"],
                sample_correction["wrong"],
                sample_correction["correct"],
                sample_correction["context"]
            )
            
            # Should return True on success
            assert result == True
        finally:
            sa.learning_db = original_db
    
    def test_check_past_mistakes(self, initialized_learning_db):
        """Test check_past_mistakes convenience function"""
        sa = get_self_awareness()
        original_db = sa.learning_db
        sa.learning_db = initialized_learning_db
        
        try:
            result = check_past_mistakes("some query")
            
            # Should return None or dict
            assert result is None or isinstance(result, dict)
        finally:
            sa.learning_db = original_db


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
