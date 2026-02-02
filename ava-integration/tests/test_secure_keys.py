"""
Unit Tests for AVA Secure Keys Module
=====================================
Tests the secure key management functionality.
"""

import os
import sys
import pytest
import tempfile
from pathlib import Path
from unittest.mock import patch, MagicMock

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from ava_secure_keys import KeyManager, get_api_key, KEY_CONFIG


class TestKeyManager:
    """Tests for KeyManager class"""
    
    def test_init_creates_manager(self, temp_dir):
        """Test KeyManager initializes correctly"""
        km = KeyManager(integration_dir=temp_dir)
        assert km is not None
        assert km.integration_dir == temp_dir
    
    def test_get_key_from_env(self, temp_dir):
        """Test loading key from environment variable"""
        km = KeyManager(integration_dir=temp_dir)
        
        with patch.dict(os.environ, {'DEEPGRAM_API_KEY': 'test_key_123'}):
            key = km.get_key('DEEPGRAM_API_KEY')
            assert key == 'test_key_123'
    
    def test_get_key_from_env_alias(self, temp_dir):
        """Test loading key from environment variable alias"""
        km = KeyManager(integration_dir=temp_dir)
        
        # GOOGLE_API_KEY has alias GEMINI_API_KEY
        with patch.dict(os.environ, {'GEMINI_API_KEY': 'gemini_test_key'}, clear=False):
            # Clear the primary key to test alias
            env = os.environ.copy()
            if 'GOOGLE_API_KEY' in env:
                del env['GOOGLE_API_KEY']
            env['GEMINI_API_KEY'] = 'gemini_test_key'
            
            with patch.dict(os.environ, env, clear=True):
                key = km.get_key('GOOGLE_API_KEY')
                assert key == 'gemini_test_key'
    
    def test_get_key_from_file(self, temp_dir):
        """Test loading key from plain text file"""
        # Create test key file
        key_file = temp_dir / "deepgram key.txt"
        key_file.write_text("file_test_key_456")
        
        km = KeyManager(integration_dir=temp_dir)
        
        # Clear env var to force file fallback
        with patch.dict(os.environ, {}, clear=True):
            with pytest.warns(DeprecationWarning):
                key = km.get_key('DEEPGRAM_API_KEY')
                assert key == 'file_test_key_456'
    
    def test_get_key_not_found(self, temp_dir):
        """Test returns None when key not found"""
        km = KeyManager(integration_dir=temp_dir)
        
        with patch.dict(os.environ, {}, clear=True):
            key = km.get_key('NONEXISTENT_KEY', silent=True)
            assert key is None
    
    def test_get_key_caches_result(self, temp_dir):
        """Test that keys are cached"""
        km = KeyManager(integration_dir=temp_dir)
        
        with patch.dict(os.environ, {'TEST_KEY': 'cached_value'}):
            # First call
            key1 = km.get_key('TEST_KEY')
            # Change env (but should use cache)
            os.environ['TEST_KEY'] = 'new_value'
            key2 = km.get_key('TEST_KEY')
            
            assert key1 == key2 == 'cached_value'
    
    def test_get_all_keys(self, temp_dir):
        """Test getting all configured keys"""
        km = KeyManager(integration_dir=temp_dir)
        
        with patch.dict(os.environ, {'DEEPGRAM_API_KEY': 'dg_key', 'GOOGLE_API_KEY': 'goog_key'}):
            keys = km.get_all_keys(silent=True)
            
            assert isinstance(keys, dict)
            assert 'DEEPGRAM_API_KEY' in keys
            assert 'GOOGLE_API_KEY' in keys
    
    def test_get_available_keys(self, temp_dir):
        """Test getting only available keys"""
        km = KeyManager(integration_dir=temp_dir)
        
        with patch.dict(os.environ, {'DEEPGRAM_API_KEY': 'dg_key'}, clear=True):
            keys = km.get_available_keys()
            
            assert 'DEEPGRAM_API_KEY' in keys
            # Keys not set should not appear
            for key_name, value in keys.items():
                assert value is not None


class TestSecurityStatus:
    """Tests for security status checking"""
    
    def test_check_security_status_env(self, temp_dir):
        """Test security status for env-loaded key"""
        km = KeyManager(integration_dir=temp_dir)
        
        with patch.dict(os.environ, {'DEEPGRAM_API_KEY': 'env_key'}):
            status = km.check_security_status()
            
            assert status['DEEPGRAM_API_KEY']['available'] == True
            assert status['DEEPGRAM_API_KEY']['secure'] == True
            assert 'environment' in status['DEEPGRAM_API_KEY']['source']
    
    def test_check_security_status_file(self, temp_dir):
        """Test security status for file-loaded key (insecure)"""
        # Create test key file
        key_file = temp_dir / "deepgram key.txt"
        key_file.write_text("file_key")
        
        km = KeyManager(integration_dir=temp_dir)
        
        with patch.dict(os.environ, {}, clear=True):
            status = km.check_security_status()
            
            assert status['DEEPGRAM_API_KEY']['available'] == True
            assert status['DEEPGRAM_API_KEY']['secure'] == False
            assert 'file' in status['DEEPGRAM_API_KEY']['source']
    
    def test_check_security_status_missing(self, temp_dir):
        """Test security status for missing key"""
        km = KeyManager(integration_dir=temp_dir)
        
        with patch.dict(os.environ, {}, clear=True):
            status = km.check_security_status()
            
            # At least one key should be unavailable in empty env
            unavailable = [k for k, v in status.items() if not v['available']]
            assert len(unavailable) > 0


class TestEnvTemplate:
    """Tests for environment template generation"""
    
    def test_generate_env_template(self, temp_dir):
        """Test generating .env template"""
        km = KeyManager(integration_dir=temp_dir)
        
        template = km.generate_env_template()
        
        assert isinstance(template, str)
        assert 'DEEPGRAM_API_KEY' in template
        assert 'GOOGLE_API_KEY' in template
        assert 'your_key_here' in template
        assert '# ' in template  # Should have comments


class TestConvenienceFunction:
    """Tests for module-level convenience function"""
    
    def test_get_api_key_function(self):
        """Test get_api_key convenience function"""
        with patch.dict(os.environ, {'DEEPGRAM_API_KEY': 'convenience_key'}):
            key = get_api_key('DEEPGRAM_API_KEY')
            assert key == 'convenience_key'


class TestKeyConfig:
    """Tests for key configuration"""
    
    def test_key_config_has_required_keys(self):
        """Test KEY_CONFIG has all expected API keys"""
        required = [
            'DEEPGRAM_API_KEY',
            'GOOGLE_API_KEY',
            'ANTHROPIC_API_KEY',
            'OPENAI_API_KEY',
            'GROQ_API_KEY'
        ]
        
        for key in required:
            assert key in KEY_CONFIG, f"Missing {key} in KEY_CONFIG"
    
    def test_key_config_has_files(self):
        """Test each key config has file fallbacks"""
        for key_name, config in KEY_CONFIG.items():
            assert 'files' in config, f"{key_name} missing 'files' config"
            assert len(config['files']) > 0, f"{key_name} has empty 'files' list"
    
    def test_key_config_has_keyring_name(self):
        """Test each key config has keyring name"""
        for key_name, config in KEY_CONFIG.items():
            assert 'keyring_name' in config, f"{key_name} missing 'keyring_name'"
