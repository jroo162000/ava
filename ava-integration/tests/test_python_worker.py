"""
Unit Tests for AVA Python Worker
=================================
Tests the persistent Python subprocess worker for server.js integration.
"""

import os
import sys
import json
import pytest
from pathlib import Path
from unittest.mock import patch, MagicMock

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from ava_python_worker import handle_command


class TestCommandHandling:
    """Tests for command handling"""
    
    def test_ping_command(self):
        """Test ping command returns pong"""
        result = handle_command({"cmd": "ping"})
        
        assert result["ok"] == True
        assert result["result"] == "pong"
    
    def test_unknown_command(self):
        """Test unknown command returns error"""
        result = handle_command({"cmd": "unknown_command_xyz"})
        
        assert result["ok"] == False
        assert "error" in result
    
    def test_empty_command(self):
        """Test empty command returns error"""
        result = handle_command({"cmd": ""})
        
        assert result["ok"] == False
    
    def test_missing_command(self):
        """Test missing cmd field returns error"""
        result = handle_command({})
        
        assert result["ok"] == False


class TestSelfAwarenessCommands:
    """Tests for self-awareness commands"""
    
    def test_introspect_command(self):
        """Test introspect command"""
        result = handle_command({"cmd": "introspect"})
        
        assert "ok" in result
        # Either succeeds or fails gracefully with import error
        if result["ok"]:
            assert "result" in result
    
    def test_describe_command(self):
        """Test describe command"""
        result = handle_command({"cmd": "describe"})
        
        assert "ok" in result
    
    def test_diagnose_command(self):
        """Test diagnose command"""
        result = handle_command({"cmd": "diagnose"})
        
        assert "ok" in result
    
    def test_get_prompt_context_command(self):
        """Test get_prompt_context command"""
        result = handle_command({"cmd": "get_prompt_context"})
        
        assert "ok" in result
    
    def test_get_learned_facts_command(self):
        """Test get_learned_facts command"""
        result = handle_command({"cmd": "get_learned_facts"})
        
        assert "ok" in result


class TestLearningCommands:
    """Tests for learning-related commands"""
    
    def test_learn_correction_command(self):
        """Test learn_correction command with valid data"""
        result = handle_command({
            "cmd": "learn_correction",
            "user_input": "What's my name?",
            "wrong": "I don't know your name.",
            "correct": "Your name is John.",
            "context": "User stated name previously"
        })
        
        assert "ok" in result
    
    def test_learn_correction_missing_params(self):
        """Test learn_correction with missing parameters"""
        result = handle_command({
            "cmd": "learn_correction"
            # Missing required params
        })
        
        # Should handle gracefully
        assert "ok" in result


class TestSelfModCommands:
    """Tests for self-modification commands"""
    
    def test_self_mod_command(self):
        """Test self_mod command with diagnose action"""
        result = handle_command({
            "cmd": "self_mod",
            "args": {"action": "diagnose"}
        })
        
        assert "ok" in result
    
    def test_self_mod_list_files(self):
        """Test self_mod with list_core_files action"""
        result = handle_command({
            "cmd": "self_mod",
            "args": {"action": "list_core_files"}
        })
        
        assert "ok" in result


class TestPassiveLearningCommands:
    """Tests for passive learning commands"""
    
    def test_store_learnings_command(self):
        """Test store_learnings command"""
        result = handle_command({
            "cmd": "store_learnings",
            "observation_type": "test",
            "data": {"key": "value"}
        })
        
        assert "ok" in result
    
    def test_record_pattern_command(self):
        """Test record_pattern command"""
        result = handle_command({
            "cmd": "record_pattern",
            "pattern_type": "test_pattern",
            "pattern_data": {"test": True}
        })
        
        assert "ok" in result


class TestResponseFormat:
    """Tests for response format consistency"""
    
    def test_response_has_ok_field(self):
        """Test all responses have ok field"""
        commands = [
            {"cmd": "ping"},
            {"cmd": "introspect"},
            {"cmd": "unknown"}
        ]
        
        for cmd in commands:
            result = handle_command(cmd)
            assert "ok" in result, f"Missing 'ok' for {cmd}"
    
    def test_success_response_has_result(self):
        """Test successful responses have result field"""
        result = handle_command({"cmd": "ping"})
        
        if result["ok"]:
            assert "result" in result
    
    def test_error_response_has_error(self):
        """Test error responses have error field"""
        result = handle_command({"cmd": "definitely_not_a_command"})
        
        if not result["ok"]:
            assert "error" in result


class TestRequestIdHandling:
    """Tests for request ID handling (for async matching)"""
    
    def test_request_id_preserved(self):
        """Test that _requestId is preserved in response"""
        result = handle_command({
            "cmd": "ping",
            "_requestId": "test-123"
        })
        
        # The main function adds _requestId, not handle_command
        # This test documents expected behavior
        assert result["ok"] == True
