"""
AVA Secure Key Management
=========================
Handles API key loading with multiple secure sources:
1. Environment variables (preferred, most secure)
2. System keyring (encrypted OS credential storage)
3. Plain text files (deprecated, with warning)

Usage:
    from ava_secure_keys import get_api_key, KeyManager
    
    # Simple usage
    deepgram_key = get_api_key("DEEPGRAM_API_KEY")
    
    # Or use the manager for bulk operations
    km = KeyManager()
    all_keys = km.get_all_keys()
"""

import os
import sys
import warnings
from pathlib import Path
from typing import Optional, Dict, Any
from functools import lru_cache

# Try to import keyring for secure storage
try:
    import keyring
    KEYRING_AVAILABLE = True
except ImportError:
    KEYRING_AVAILABLE = False

# Service name for keyring storage
KEYRING_SERVICE = "ava-assistant"

# Integration directory for fallback files
INTEGRATION_DIR = Path(__file__).parent

# Key configuration: maps env var names to file fallbacks
KEY_CONFIG = {
    "DEEPGRAM_API_KEY": {
        "files": ["deepgram key.txt"],
        "keyring_name": "deepgram",
        "description": "Deepgram ASR/TTS API key"
    },
    "GOOGLE_API_KEY": {
        "files": ["gemini api key.txt"],
        "keyring_name": "gemini",
        "env_aliases": ["GEMINI_API_KEY"],
        "description": "Google/Gemini API key"
    },
    "ANTHROPIC_API_KEY": {
        "files": ["claude api key.txt"],
        "keyring_name": "claude",
        "env_aliases": ["CLAUDE_API_KEY"],
        "description": "Anthropic/Claude API key"
    },
    "OPENAI_API_KEY": {
        "files": ["openai api key.txt"],
        "keyring_name": "openai",
        "description": "OpenAI API key"
    },
    "GROQ_API_KEY": {
        "files": ["groq api key.txt", "grok api.txt"],
        "keyring_name": "groq",
        "description": "Groq API key"
    },
    "DEEPSEEK_API_KEY": {
        "files": ["deepseek api key.txt"],
        "keyring_name": "deepseek",
        "description": "DeepSeek API key"
    }
}


class KeyManager:
    """Manages secure loading and storage of API keys"""
    
    def __init__(self, integration_dir: Optional[Path] = None):
        self.integration_dir = Path(integration_dir) if integration_dir else INTEGRATION_DIR
        self._warned_files = set()  # Track which file warnings we've shown
        self._cache = {}  # Cache loaded keys
    
    def get_key(self, key_name: str, silent: bool = False) -> Optional[str]:
        """Get an API key from the most secure available source.
        
        Order of precedence:
        1. Environment variable
        2. Environment variable aliases
        3. System keyring (if available)
        4. Plain text file (with deprecation warning)
        
        Args:
            key_name: The environment variable name (e.g., "DEEPGRAM_API_KEY")
            silent: If True, suppress warnings about insecure storage
            
        Returns:
            The API key value, or None if not found
        """
        # Check cache first
        if key_name in self._cache:
            return self._cache[key_name]
        
        config = KEY_CONFIG.get(key_name, {})
        key_value = None
        source = None
        
        # 1. Try primary environment variable
        key_value = os.environ.get(key_name)
        if key_value:
            source = "environment"
        
        # 2. Try environment variable aliases
        if not key_value:
            for alias in config.get("env_aliases", []):
                key_value = os.environ.get(alias)
                if key_value:
                    source = f"environment ({alias})"
                    break
        
        # 3. Try system keyring
        if not key_value and KEYRING_AVAILABLE:
            keyring_name = config.get("keyring_name", key_name.lower())
            try:
                key_value = keyring.get_password(KEYRING_SERVICE, keyring_name)
                if key_value:
                    source = "keyring"
            except Exception:
                pass
        
        # 4. Fallback to plain text files (deprecated)
        if not key_value:
            for filename in config.get("files", []):
                filepath = self.integration_dir / filename
                if filepath.exists():
                    try:
                        key_value = filepath.read_text(encoding='utf-8').strip()
                        if key_value:
                            source = f"file ({filename})"
                            # Warn about insecure storage
                            if not silent and filename not in self._warned_files:
                                self._warned_files.add(filename)
                                self._warn_insecure_file(key_name, filename)
                            break
                    except Exception:
                        continue
        
        # Cache the result
        if key_value:
            self._cache[key_name] = key_value
        
        return key_value
    
    def _warn_insecure_file(self, key_name: str, filename: str):
        """Warn about insecure plain text key storage"""
        warnings.warn(
            f"⚠️  {key_name} loaded from plain text file '{filename}'. "
            f"This is insecure. Consider:\n"
            f"   1. Set environment variable: export {key_name}=your_key\n"
            f"   2. Or use keyring: python -c \"import keyring; keyring.set_password('ava-assistant', '{KEY_CONFIG.get(key_name, {}).get('keyring_name', 'key')}', 'your_key')\"\n"
            f"   3. Or create a .env file (more secure than .txt files)",
            DeprecationWarning,
            stacklevel=4
        )
    
    def get_all_keys(self, silent: bool = False) -> Dict[str, Optional[str]]:
        """Get all configured API keys.
        
        Returns:
            Dictionary mapping key names to values (None if not found)
        """
        return {
            key_name: self.get_key(key_name, silent=silent)
            for key_name in KEY_CONFIG
        }
    
    def get_available_keys(self, silent: bool = True) -> Dict[str, str]:
        """Get only the API keys that are available (non-None).
        
        Returns:
            Dictionary mapping key names to values (only includes found keys)
        """
        return {
            key_name: value
            for key_name, value in self.get_all_keys(silent=silent).items()
            if value
        }
    
    def store_key_in_keyring(self, key_name: str, key_value: str) -> bool:
        """Store an API key in the system keyring.
        
        Args:
            key_name: The environment variable name
            key_value: The API key value
            
        Returns:
            True if stored successfully, False otherwise
        """
        if not KEYRING_AVAILABLE:
            print("[!!] keyring module not installed. Run: pip install keyring")
            return False
        
        config = KEY_CONFIG.get(key_name, {})
        keyring_name = config.get("keyring_name", key_name.lower())
        
        try:
            keyring.set_password(KEYRING_SERVICE, keyring_name, key_value)
            # Clear cache
            if key_name in self._cache:
                del self._cache[key_name]
            print(f"[OK] Stored {key_name} in system keyring")
            return True
        except Exception as e:
            print(f"[!!] Failed to store {key_name} in keyring: {e}")
            return False
    
    def migrate_files_to_keyring(self) -> Dict[str, bool]:
        """Migrate all plain text key files to system keyring.
        
        Returns:
            Dictionary mapping key names to migration success status
        """
        if not KEYRING_AVAILABLE:
            print("[!!] keyring module not installed. Run: pip install keyring")
            return {}
        
        results = {}
        
        for key_name, config in KEY_CONFIG.items():
            # Check if key is in a plain text file
            key_value = None
            source_file = None
            
            for filename in config.get("files", []):
                filepath = self.integration_dir / filename
                if filepath.exists():
                    try:
                        key_value = filepath.read_text(encoding='utf-8').strip()
                        if key_value:
                            source_file = filepath
                            break
                    except Exception:
                        continue
            
            if key_value and source_file:
                # Store in keyring
                success = self.store_key_in_keyring(key_name, key_value)
                results[key_name] = success
                
                if success:
                    # Optionally delete the plain text file
                    print(f"   [*] Source file: {source_file}")
                    print(f"   [!] Consider deleting the plain text file for security")
        
        return results
    
    def generate_env_template(self) -> str:
        """Generate a .env template with all required keys.
        
        Returns:
            String content for a .env.template file
        """
        lines = [
            "# AVA API Keys Configuration",
            "# ===========================",
            "# Copy this file to .env and fill in your API keys.",
            "# NEVER commit .env to version control!",
            "",
        ]
        
        for key_name, config in KEY_CONFIG.items():
            desc = config.get("description", "API key")
            lines.append(f"# {desc}")
            lines.append(f"{key_name}=your_key_here")
            lines.append("")
        
        return "\n".join(lines)
    
    def check_security_status(self) -> Dict[str, Any]:
        """Check the security status of all configured keys.
        
        Returns:
            Dictionary with security status for each key
        """
        status = {}
        
        for key_name, config in KEY_CONFIG.items():
            key_status = {
                "available": False,
                "source": None,
                "secure": False
            }
            
            # Check environment variable
            if os.environ.get(key_name):
                key_status["available"] = True
                key_status["source"] = "environment"
                key_status["secure"] = True
            
            # Check aliases
            if not key_status["available"]:
                for alias in config.get("env_aliases", []):
                    if os.environ.get(alias):
                        key_status["available"] = True
                        key_status["source"] = f"environment ({alias})"
                        key_status["secure"] = True
                        break
            
            # Check keyring
            if not key_status["available"] and KEYRING_AVAILABLE:
                keyring_name = config.get("keyring_name", key_name.lower())
                try:
                    if keyring.get_password(KEYRING_SERVICE, keyring_name):
                        key_status["available"] = True
                        key_status["source"] = "keyring"
                        key_status["secure"] = True
                except Exception:
                    pass
            
            # Check files (insecure)
            if not key_status["available"]:
                for filename in config.get("files", []):
                    filepath = self.integration_dir / filename
                    if filepath.exists():
                        try:
                            if filepath.read_text(encoding='utf-8').strip():
                                key_status["available"] = True
                                key_status["source"] = f"file ({filename})"
                                key_status["secure"] = False
                                break
                        except Exception:
                            continue
            
            status[key_name] = key_status
        
        return status


# Global instance for convenience
_key_manager = None

def get_key_manager() -> KeyManager:
    """Get the global KeyManager instance."""
    global _key_manager
    if _key_manager is None:
        _key_manager = KeyManager()
    return _key_manager


def get_api_key(key_name: str, silent: bool = False) -> Optional[str]:
    """Convenience function to get an API key.
    
    Args:
        key_name: The environment variable name (e.g., "DEEPGRAM_API_KEY")
        silent: If True, suppress warnings about insecure storage
        
    Returns:
        The API key value, or None if not found
    """
    return get_key_manager().get_key(key_name, silent=silent)


# =============================================================================
# CLI Interface
# =============================================================================

def main():
    """Command-line interface for key management"""
    import argparse
    
    parser = argparse.ArgumentParser(
        description="AVA Secure Key Management",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python ava_secure_keys.py status      # Check security status of all keys
  python ava_secure_keys.py migrate     # Migrate plain text files to keyring
  python ava_secure_keys.py template    # Generate .env template
  python ava_secure_keys.py store DEEPGRAM_API_KEY your_key_here
        """
    )
    
    subparsers = parser.add_subparsers(dest="command", help="Command to run")
    
    # Status command
    subparsers.add_parser("status", help="Check security status of all keys")
    
    # Migrate command
    subparsers.add_parser("migrate", help="Migrate plain text files to keyring")
    
    # Template command
    subparsers.add_parser("template", help="Generate .env template file")
    
    # Store command
    store_parser = subparsers.add_parser("store", help="Store a key in keyring")
    store_parser.add_argument("key_name", help="Key name (e.g., DEEPGRAM_API_KEY)")
    store_parser.add_argument("key_value", help="The API key value")
    
    args = parser.parse_args()
    
    km = KeyManager()
    
    if args.command == "status":
        print("\n[KEY] AVA API Key Security Status")
        print("=" * 50)
        
        status = km.check_security_status()
        
        for key_name, info in status.items():
            available = "[OK]" if info["available"] else "[--]"
            secure = "[SECURE]" if info["secure"] else "[WARN]"
            source = info["source"] or "not found"
            
            if info["available"]:
                print(f"{available} {secure} {key_name}")
                print(f"      Source: {source}")
            else:
                print(f"{available}         {key_name} - NOT CONFIGURED")
            print()
        
        print("Legend: [OK]=available [--]=missing [SECURE]=secure [WARN]=insecure")
        if not KEYRING_AVAILABLE:
            print("\n[!] keyring module not installed. Run: pip install keyring")
    
    elif args.command == "migrate":
        print("\n[*] Migrating plain text keys to system keyring...")
        print("=" * 50)
        
        results = km.migrate_files_to_keyring()
        
        if results:
            print("\n[*] Migration Results:")
            for key_name, success in results.items():
                status = "[OK] Success" if success else "[!!] Failed"
                print(f"   {key_name}: {status}")
        else:
            print("No keys found in plain text files to migrate.")
    
    elif args.command == "template":
        template = km.generate_env_template()
        
        # Write to file
        template_path = km.integration_dir / ".env.template"
        template_path.write_text(template)
        
        print(f"[OK] Generated {template_path}")
        print("\nTo use:")
        print(f"  1. Copy to .env: cp {template_path} .env")
        print("  2. Edit .env and add your API keys")
        print("  3. Add .env to .gitignore!")
    
    elif args.command == "store":
        success = km.store_key_in_keyring(args.key_name, args.key_value)
        sys.exit(0 if success else 1)
    
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
