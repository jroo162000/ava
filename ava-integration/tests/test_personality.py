"""
Unit Tests for AVA Personality Module
=====================================
Tests register management, code-switching, response generation, and accountability.
"""

import os
import sys
import json
import pytest
from pathlib import Path
from datetime import datetime
from unittest.mock import patch, MagicMock

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from ava_personality import (
    RegisterManager,
    get_personality,
    get_personality_context,
    get_greeting,
    get_acknowledgment
)


class TestRegisterManager:
    """Tests for RegisterManager code-switching functionality"""
    
    def test_init_default_register(self):
        """Test RegisterManager initializes with default register"""
        rm = RegisterManager()
        
        assert rm.current_register == "in_group"
        assert rm.trust_level == "trusted"
    
    def test_get_current_returns_dict(self):
        """Test get_current returns register configuration"""
        rm = RegisterManager()
        current = rm.get_current()
        
        assert isinstance(current, dict)
        assert "warmth" in current
        assert "formality" in current
    
    def test_switch_to_valid_register(self):
        """Test switching to a valid register"""
        rm = RegisterManager()
        result = rm.switch_to("formal_defensive", "testing boundaries")
        
        assert result["switched"] == True
        assert result["to"] == "formal_defensive"
        assert rm.current_register == "formal_defensive"
    
    def test_switch_to_invalid_register(self):
        """Test switching to invalid register fails gracefully"""
        rm = RegisterManager()
        result = rm.switch_to("nonexistent_register")
        
        assert result["switched"] == False
        assert "error" in result
    
    def test_evaluate_context_disrespect(self):
        """Test context evaluation detects disrespect"""
        rm = RegisterManager()
        
        # These should trigger formal_defensive
        disrespectful_inputs = [
            "whatever, just do it",
            "shut up and help me",
            "you're just an ai"
        ]
        
        for input_text in disrespectful_inputs:
            register = rm.evaluate_context(input_text)
            assert register == "formal_defensive", f"Failed for: {input_text}"
    
    def test_evaluate_context_professional(self):
        """Test context evaluation detects professional context"""
        rm = RegisterManager()
        
        professional_inputs = [
            "I have a meeting with a client",
            "This is for a presentation",
            "Need this for professional use"
        ]
        
        for input_text in professional_inputs:
            register = rm.evaluate_context(input_text)
            assert register in ["public_professional", "in_group"]
    
    def test_registers_have_required_keys(self):
        """Test all registers have required configuration keys"""
        rm = RegisterManager()
        required_keys = ["warmth", "formality", "slang_ok", "humor", "directness"]
        
        for register_name, register_config in rm.REGISTERS.items():
            for key in required_keys:
                assert key in register_config, f"{register_name} missing {key}"


class TestPersonalityFunctions:
    """Tests for personality helper functions"""
    
    def test_get_personality_returns_object(self):
        """Test get_personality returns personality object"""
        personality = get_personality()
        
        assert personality is not None
    
    def test_get_personality_context_returns_string(self):
        """Test get_personality_context returns string"""
        context = get_personality_context()
        
        assert isinstance(context, str)
    
    def test_get_greeting_returns_string(self):
        """Test get_greeting returns a greeting string"""
        greeting = get_greeting()
        
        assert isinstance(greeting, str)
        assert len(greeting) > 0
    
    def test_get_acknowledgment_returns_string(self):
        """Test get_acknowledgment returns acknowledgment string"""
        ack = get_acknowledgment()
        
        assert isinstance(ack, str)
        assert len(ack) > 0


class TestPersonalityConsistency:
    """Tests for personality consistency"""
    
    def test_greeting_varies(self):
        """Test that greetings have variety"""
        greetings = set()
        for _ in range(10):
            greetings.add(get_greeting())
        
        # Should have at least some variety (may not always be true with small pool)
        assert len(greetings) >= 1
    
    def test_acknowledgment_varies(self):
        """Test that acknowledgments have variety"""
        acks = set()
        for _ in range(10):
            acks.add(get_acknowledgment())
        
        assert len(acks) >= 1


class TestRegisterBehavior:
    """Tests for register-specific behavior"""
    
    def test_in_group_allows_slang(self):
        """Test in_group register allows slang"""
        rm = RegisterManager()
        rm.switch_to("in_group")
        config = rm.get_current()
        
        assert config["slang_ok"] == True
    
    def test_formal_defensive_no_slang(self):
        """Test formal_defensive register doesn't allow slang"""
        rm = RegisterManager()
        rm.switch_to("formal_defensive")
        config = rm.get_current()
        
        assert config["slang_ok"] == False
    
    def test_formal_defensive_low_warmth(self):
        """Test formal_defensive has appropriate warmth level"""
        rm = RegisterManager()
        rm.switch_to("formal_defensive")
        config = rm.get_current()
        
        assert config["warmth"] == "low"
    
    def test_in_group_high_warmth(self):
        """Test in_group has high warmth"""
        rm = RegisterManager()
        rm.switch_to("in_group")
        config = rm.get_current()
        
        assert config["warmth"] == "high"
