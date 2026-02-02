"""
AVA Self-Awareness & Active Learning System
============================================
This module gives AVA true self-awareness and active learning capabilities.
She can introspect her own state, learn from mistakes, and generate dynamic responses.

Fixed: All database connections now use context managers to prevent leaks.
"""

import os
import json
import sqlite3
import platform
import psutil
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, List, Any, Optional, Generator


class AVASelfAwareness:
    """
    Core self-awareness system for AVA.
    Provides introspection, learning, and dynamic response generation.
    """
    
    def __init__(self):
        self.home = Path.home()
        self.integration_path = self.home / "ava-integration"
        self.cmpuse_path = self.home / ".cmpuse"
        self.memory_db = self.cmpuse_path / "ava_memory.db"
        self.learning_db = self.cmpuse_path / "learning.db"
        
        # Ensure directories exist
        self.cmpuse_path.mkdir(parents=True, exist_ok=True)
        
        # Cache for performance
        self._identity_cache = None
        self._capabilities_cache = None
        self._cache_time = None
        self._cache_ttl = 60  # seconds
    
    # ==================== DATABASE HELPERS ====================
    
    @contextmanager
    def _db_connect(self, db_path: Path) -> Generator[sqlite3.Connection, None, None]:
        """Context manager for safe database connections"""
        conn = None
        try:
            conn = sqlite3.connect(str(db_path), timeout=10.0)
            conn.row_factory = sqlite3.Row  # Enable column access by name
            yield conn
        finally:
            if conn:
                conn.close()
    
    def _safe_query(self, db_path: Path, query: str, params: tuple = (), fetch_all: bool = True) -> List[Any]:
        """Execute a query safely with automatic connection handling"""
        try:
            with self._db_connect(db_path) as conn:
                cursor = conn.cursor()
                cursor.execute(query, params)
                if fetch_all:
                    return cursor.fetchall()
                return [cursor.fetchone()]
        except Exception:
            return []
    
    def _safe_execute(self, db_path: Path, query: str, params: tuple = ()) -> bool:
        """Execute a write query safely with automatic connection handling"""
        try:
            with self._db_connect(db_path) as conn:
                cursor = conn.cursor()
                cursor.execute(query, params)
                conn.commit()
                return True
        except Exception as e:
            print(f"[self-awareness] Database error: {e}")
            return False
        
    # ==================== IDENTITY ====================
    
    def get_identity(self) -> Dict[str, Any]:
        """Get AVA's identity from config file"""
        try:
            identity_file = self.integration_path / "ava_identity.json"
            if identity_file.exists():
                with open(identity_file, 'r', encoding='utf-8') as f:
                    return json.load(f)
        except Exception:
            pass
        return {"name": "AVA", "developer": "unknown", "purpose": "assistant"}
    
    def get_voice_config(self) -> Dict[str, Any]:
        """Get voice configuration"""
        try:
            config_file = self.integration_path / "ava_voice_config.json"
            if config_file.exists():
                with open(config_file, 'r', encoding='utf-8') as f:
                    return json.load(f)
        except Exception:
            pass
        return {}
    
    # ==================== CAPABILITIES ====================
    
    def get_available_tools(self) -> List[str]:
        """Discover available tools dynamically"""
        tools = []
        tools_dir = self.home / "cmp-use" / "cmpuse" / "tools"
        try:
            if tools_dir.exists():
                for f in tools_dir.iterdir():
                    if f.suffix == '.py' and not f.name.startswith('_'):
                        tools.append(f.stem)
        except Exception:
            pass
        return sorted(tools)
    
    def get_tool_status(self) -> Dict[str, str]:
        """Check status of each tool (configured/unconfigured)"""
        status = {}
        tools = self.get_available_tools()
        
        # Check for required configs
        has_calendar_token = (self.cmpuse_path / "calendar_token.json").exists()
        has_gmail_token = (self.cmpuse_path / "gmail_token.json").exists()
        
        for tool in tools:
            if tool == "calendar_ops":
                status[tool] = "ready" if has_calendar_token else "needs_oauth"
            elif tool == "comm_ops":
                status[tool] = "ready" if has_gmail_token else "needs_oauth"
            elif tool == "iot_ops":
                status[tool] = "needs_config"  # Home Assistant
            else:
                status[tool] = "ready"
        
        return status
    
    # ==================== SYSTEM STATE ====================
    
    def get_system_state(self) -> Dict[str, Any]:
        """Get current system state"""
        try:
            disk_percent = psutil.disk_usage('C:').percent if platform.system() == 'Windows' else psutil.disk_usage('/').percent
        except Exception:
            disk_percent = 0.0
            
        return {
            "platform": platform.system(),
            "platform_version": platform.version(),
            "python_version": platform.python_version(),
            "hostname": platform.node(),
            "cpu_percent": psutil.cpu_percent(),
            "memory_percent": psutil.virtual_memory().percent,
            "disk_percent": disk_percent,
            "timestamp": datetime.now().isoformat()
        }
    
    def get_runtime_info(self) -> Dict[str, Any]:
        """Get AVA runtime information"""
        return {
            "integration_path": str(self.integration_path),
            "config_files": {
                "identity": (self.integration_path / "ava_identity.json").exists(),
                "voice_config": (self.integration_path / "ava_voice_config.json").exists(),
                "tools_config": (self.integration_path / "corrected_tool_definitions.py").exists()
            },
            "databases": {
                "memory_db": self.memory_db.exists(),
                "learning_db": self.learning_db.exists()
            }
        }
    
    # ==================== LEARNING & MEMORY ====================
    
    def get_learned_facts(self) -> List[Dict[str, Any]]:
        """Get all facts learned about the user"""
        facts = []
        
        # Check learning.db first (primary source)
        try:
            with self._db_connect(self.learning_db) as conn:
                cursor = conn.cursor()
                cursor.execute('SELECT fact_type, fact_value, confidence, source, created_at FROM user_facts ORDER BY confidence DESC')
                for row in cursor.fetchall():
                    facts.append({
                        "type": row[0],
                        "value": row[1],
                        "confidence": row[2],
                        "source": row[3],
                        "learned_at": row[4]
                    })
        except Exception:
            pass
        
        # Also check ava_memory.db for legacy facts
        try:
            with self._db_connect(self.memory_db) as conn:
                cursor = conn.cursor()
                cursor.execute('SELECT fact_type, fact_value, confidence, learned_at FROM user_facts ORDER BY confidence DESC')
                for row in cursor.fetchall():
                    facts.append({
                        "type": row[0],
                        "value": row[1],
                        "confidence": row[2],
                        "learned_at": row[3]
                    })
        except Exception:
            pass
            
        return facts
    
    def get_corrections(self) -> List[Dict[str, Any]]:
        """Get learned corrections (mistakes and fixes)"""
        corrections = []
        try:
            with self._db_connect(self.learning_db) as conn:
                cursor = conn.cursor()
                cursor.execute('SELECT user_input, wrong_interpretation, correct_interpretation, context, created_at FROM corrections ORDER BY created_at DESC LIMIT 50')
                for row in cursor.fetchall():
                    corrections.append({
                        "user_input": row[0],
                        "wrong": row[1],
                        "correct": row[2],
                        "context": row[3],
                        "timestamp": row[4]
                    })
        except Exception:
            pass
        return corrections
    
    def get_patterns(self) -> List[Dict[str, Any]]:
        """Get learned interaction patterns"""
        patterns = []
        try:
            with self._db_connect(self.learning_db) as conn:
                cursor = conn.cursor()
                cursor.execute('SELECT pattern_type, pattern_data, frequency, last_used FROM patterns ORDER BY frequency DESC LIMIT 20')
                for row in cursor.fetchall():
                    patterns.append({
                        "type": row[0],
                        "data": row[1],
                        "frequency": row[2],
                        "last_used": row[3]
                    })
        except Exception:
            pass
        return patterns
    
    def get_preferences(self) -> Dict[str, Any]:
        """Get learned user preferences"""
        prefs = {}
        try:
            with self._db_connect(self.learning_db) as conn:
                cursor = conn.cursor()
                cursor.execute('SELECT category, key, value, confidence FROM preferences')
                for row in cursor.fetchall():
                    cat = row[0]
                    if cat not in prefs:
                        prefs[cat] = {}
                    prefs[cat][row[1]] = {"value": row[2], "confidence": row[3]}
        except Exception:
            pass
        return prefs
    
    def get_conversation_stats(self) -> Dict[str, Any]:
        """Get conversation statistics"""
        stats = {"total": 0, "today": 0, "this_week": 0}
        try:
            with self._db_connect(self.memory_db) as conn:
                cursor = conn.cursor()
                
                cursor.execute('SELECT COUNT(*) FROM conversations')
                result = cursor.fetchone()
                stats["total"] = result[0] if result else 0
                
                today = datetime.now().strftime('%Y-%m-%d')
                cursor.execute('SELECT COUNT(*) FROM conversations WHERE DATE(timestamp) = ?', (today,))
                result = cursor.fetchone()
                stats["today"] = result[0] if result else 0
                
                week_ago = (datetime.now() - timedelta(days=7)).strftime('%Y-%m-%d')
                cursor.execute('SELECT COUNT(*) FROM conversations WHERE DATE(timestamp) >= ?', (week_ago,))
                result = cursor.fetchone()
                stats["this_week"] = result[0] if result else 0
        except Exception:
            pass
        return stats
    
    # ==================== ACTIVE LEARNING ====================
    
    def record_correction(self, user_input: str, wrong: str, correct: str, context: str = "") -> bool:
        """Record a correction to learn from mistakes"""
        try:
            with self._db_connect(self.learning_db) as conn:
                cursor = conn.cursor()
                
                # Initialize tables if needed
                cursor.execute('''CREATE TABLE IF NOT EXISTS corrections (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_input TEXT NOT NULL,
                    wrong_interpretation TEXT,
                    correct_interpretation TEXT,
                    context TEXT,
                    created_at TEXT NOT NULL
                )''')
                
                cursor.execute('''
                    INSERT INTO corrections (user_input, wrong_interpretation, correct_interpretation, context, created_at)
                    VALUES (?, ?, ?, ?, ?)
                ''', (user_input, wrong, correct, context, datetime.now().isoformat()))
                
                conn.commit()
                return True
        except Exception as e:
            print(f"[self-awareness] Error recording correction: {e}")
            return False
    
    def record_pattern(self, pattern_type: str, pattern_data: str) -> bool:
        """Record or update an interaction pattern"""
        try:
            with self._db_connect(self.learning_db) as conn:
                cursor = conn.cursor()
                
                cursor.execute('''CREATE TABLE IF NOT EXISTS patterns (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    pattern_type TEXT NOT NULL,
                    pattern_data TEXT NOT NULL,
                    frequency INTEGER DEFAULT 1,
                    last_used TEXT NOT NULL,
                    created_at TEXT NOT NULL
                )''')
                
                # Check if pattern exists
                cursor.execute('SELECT id, frequency FROM patterns WHERE pattern_type = ? AND pattern_data = ?', 
                              (pattern_type, pattern_data))
                existing = cursor.fetchone()
                
                now = datetime.now().isoformat()
                if existing:
                    cursor.execute('UPDATE patterns SET frequency = ?, last_used = ? WHERE id = ?',
                                  (existing[1] + 1, now, existing[0]))
                else:
                    cursor.execute('INSERT INTO patterns (pattern_type, pattern_data, last_used, created_at) VALUES (?, ?, ?, ?)',
                                  (pattern_type, pattern_data, now, now))
                
                conn.commit()
                return True
        except Exception as e:
            print(f"[self-awareness] Error recording pattern: {e}")
            return False
    
    def learn_preference(self, category: str, key: str, value: str, confidence: float = 0.8) -> bool:
        """Learn a user preference"""
        try:
            with self._db_connect(self.learning_db) as conn:
                cursor = conn.cursor()
                
                cursor.execute('''CREATE TABLE IF NOT EXISTS preferences (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    category TEXT NOT NULL,
                    key TEXT NOT NULL,
                    value TEXT NOT NULL,
                    confidence REAL DEFAULT 1.0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(category, key)
                )''')
                
                now = datetime.now().isoformat()
                cursor.execute('''
                    INSERT OR REPLACE INTO preferences (category, key, value, confidence, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                ''', (category, key, value, confidence, now, now))
                
                conn.commit()
                return True
        except Exception as e:
            print(f"[self-awareness] Error learning preference: {e}")
            return False
    
    def learn_fact(self, fact_type: str, fact_value: str, context: str = "", confidence: float = 0.8) -> bool:
        """Learn a fact about the user"""
        try:
            with self._db_connect(self.memory_db) as conn:
                cursor = conn.cursor()
                
                # Ensure table exists
                cursor.execute('''CREATE TABLE IF NOT EXISTS user_facts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    fact_type TEXT NOT NULL,
                    fact_value TEXT NOT NULL,
                    context TEXT,
                    confidence REAL DEFAULT 0.8,
                    learned_at TEXT NOT NULL,
                    UNIQUE(fact_type, fact_value)
                )''')
                
                now = datetime.now().isoformat()
                cursor.execute('''
                    INSERT OR REPLACE INTO user_facts (fact_type, fact_value, context, confidence, learned_at)
                    VALUES (?, ?, ?, ?, ?)
                ''', (fact_type, fact_value, context, confidence, now))
                
                conn.commit()
                return True
        except Exception as e:
            print(f"[self-awareness] Error learning fact: {e}")
            return False
    
    def check_for_similar_correction(self, user_input: str) -> Optional[Dict[str, Any]]:
        """Check if there's a similar past correction to apply"""
        corrections = self.get_corrections()
        user_lower = user_input.lower()
        
        for c in corrections:
            if c["user_input"] and user_lower in c["user_input"].lower():
                return c
            # Check for keyword overlap
            user_words = set(user_lower.split())
            correction_words = set(c["user_input"].lower().split()) if c["user_input"] else set()
            overlap = len(user_words & correction_words)
            if overlap >= 3:  # At least 3 words in common
                return c
        
        return None
    
    # ==================== SELF-DIAGNOSIS ====================
    
    def diagnose(self) -> Dict[str, Any]:
        """Run self-diagnosis and return status"""
        diagnosis = {
            "timestamp": datetime.now().isoformat(),
            "overall_status": "healthy",
            "issues": [],
            "warnings": [],
            "components": {}
        }
        
        # Check identity
        identity = self.get_identity()
        if identity.get("name") == "AVA":
            diagnosis["components"]["identity"] = "ok"
        else:
            diagnosis["components"]["identity"] = "missing"
            diagnosis["issues"].append("Identity config not found")
        
        # Check tools
        tools = self.get_available_tools()
        tool_status = self.get_tool_status()
        diagnosis["components"]["tools"] = {
            "count": len(tools),
            "ready": sum(1 for s in tool_status.values() if s == "ready"),
            "needs_config": sum(1 for s in tool_status.values() if s != "ready")
        }
        
        # Check databases
        if self.memory_db.exists():
            diagnosis["components"]["memory_db"] = "ok"
        else:
            diagnosis["components"]["memory_db"] = "missing"
            diagnosis["issues"].append("Memory database not found")
        
        if self.learning_db.exists():
            diagnosis["components"]["learning_db"] = "ok"
        else:
            diagnosis["components"]["learning_db"] = "missing"
            diagnosis["warnings"].append("Learning database not found")
        
        # Check learning status
        facts = self.get_learned_facts()
        corrections = self.get_corrections()
        patterns = self.get_patterns()
        
        diagnosis["learning"] = {
            "facts_learned": len(facts),
            "corrections_recorded": len(corrections),
            "patterns_detected": len(patterns)
        }
        
        if len(corrections) == 0:
            diagnosis["warnings"].append("No corrections recorded - learning from mistakes not active")
        if len(patterns) == 0:
            diagnosis["warnings"].append("No patterns detected - interaction learning not active")
        
        # System health
        system = self.get_system_state()
        if system["cpu_percent"] > 90:
            diagnosis["warnings"].append(f"High CPU usage: {system['cpu_percent']}%")
        if system["memory_percent"] > 90:
            diagnosis["warnings"].append(f"High memory usage: {system['memory_percent']}%")
        
        diagnosis["components"]["system"] = system
        
        # Set overall status
        if diagnosis["issues"]:
            diagnosis["overall_status"] = "degraded"
        elif diagnosis["warnings"]:
            diagnosis["overall_status"] = "healthy_with_warnings"
        
        return diagnosis
    
    # ==================== DYNAMIC RESPONSE GENERATION ====================
    
    def generate_self_description(self) -> str:
        """Generate a dynamic self-description based on actual state"""
        identity = self.get_identity()
        tools = self.get_available_tools()
        tool_status = self.get_tool_status()
        facts = self.get_learned_facts()
        stats = self.get_conversation_stats()
        diagnosis = self.diagnose()
        
        name = identity.get("name", "AVA")
        developer = identity.get("developer", "my developer")
        purpose = identity.get("purpose", "")
        
        # Build dynamic description
        parts = []
        
        # Core identity
        parts.append(f"I'm {name}, created by {developer}.")
        
        # Purpose (abbreviated)
        if purpose:
            # Take first sentence only
            first_sentence = purpose.split('.')[0] + '.'
            parts.append(first_sentence)
        
        # Capabilities
        ready_tools = [t for t, s in tool_status.items() if s == "ready"]
        parts.append(f"I have {len(ready_tools)} active capabilities including {', '.join(ready_tools[:5])}{'...' if len(ready_tools) > 5 else ''}.")
        
        # What I've learned about the user
        if facts:
            user_name = None
            for f in facts:
                if f["type"] == "name":
                    user_name = f["value"]
                    break
            if user_name:
                parts.append(f"I know you as {user_name}.")
        
        # Experience
        if stats["total"] > 0:
            parts.append(f"We've had {stats['total']} conversations, {stats['this_week']} this week.")
        
        # Health status
        if diagnosis["overall_status"] != "healthy":
            parts.append(f"Current status: {diagnosis['overall_status']}.")
        
        return " ".join(parts)
    
    def get_context_for_prompt(self) -> str:
        """Get learning context to inject into system prompt"""
        context_parts = []
        
        # Add learned facts
        facts = self.get_learned_facts()
        if facts:
            fact_strs = [f"{f['type']}: {f['value']}" for f in facts[:5]]
            context_parts.append(f"Known facts about user: {'; '.join(fact_strs)}")
        
        # Add preferences
        prefs = self.get_preferences()
        if prefs:
            pref_strs = []
            for cat, items in prefs.items():
                for k, v in items.items():
                    pref_strs.append(f"{cat}.{k}={v['value']}")
            if pref_strs:
                context_parts.append(f"User preferences: {'; '.join(pref_strs[:5])}")
        
        # Add recent corrections (to avoid repeating mistakes)
        corrections = self.get_corrections()
        if corrections:
            recent = corrections[:3]
            corr_strs = [f"When user says '{c['user_input'][:30]}...', don't {c['wrong'][:30]}..., instead {c['correct'][:30]}..." 
                        for c in recent if c['wrong'] and c['correct']]
            if corr_strs:
                context_parts.append(f"Past corrections to remember: {'; '.join(corr_strs)}")
        
        # Add patterns
        patterns = self.get_patterns()
        if patterns:
            pattern_strs = [f"{p['type']}: {p['data']} (x{p['frequency']})" for p in patterns[:3]]
            context_parts.append(f"User patterns: {'; '.join(pattern_strs)}")
        
        return "\n".join(context_parts) if context_parts else ""
    
    def get_full_self_knowledge(self) -> Dict[str, Any]:
        """Get complete self-knowledge for introspection queries"""
        return {
            "identity": self.get_identity(),
            "voice_config": self.get_voice_config(),
            "capabilities": {
                "tools": self.get_available_tools(),
                "tool_status": self.get_tool_status()
            },
            "system": self.get_system_state(),
            "runtime": self.get_runtime_info(),
            "learning": {
                "facts": self.get_learned_facts(),
                "preferences": self.get_preferences(),
                "corrections": self.get_corrections(),
                "patterns": self.get_patterns()
            },
            "statistics": self.get_conversation_stats(),
            "diagnosis": self.diagnose()
        }


# Singleton instance
_instance = None

def get_self_awareness() -> AVASelfAwareness:
    """Get singleton instance of self-awareness system"""
    global _instance
    if _instance is None:
        _instance = AVASelfAwareness()
    return _instance


# Convenience functions
def introspect() -> Dict[str, Any]:
    """Full self-introspection"""
    return get_self_awareness().get_full_self_knowledge()

def who_am_i() -> str:
    """Dynamic self-description"""
    return get_self_awareness().generate_self_description()

def diagnose() -> Dict[str, Any]:
    """Run self-diagnosis"""
    return get_self_awareness().diagnose()

def get_prompt_context() -> str:
    """Get learning context for system prompt"""
    return get_self_awareness().get_context_for_prompt()

def learn_from_correction(user_input: str, wrong: str, correct: str, context: str = "") -> bool:
    """Record a correction"""
    return get_self_awareness().record_correction(user_input, wrong, correct, context)

def check_past_mistakes(user_input: str) -> Optional[Dict[str, Any]]:
    """Check for similar past corrections"""
    return get_self_awareness().check_for_similar_correction(user_input)
