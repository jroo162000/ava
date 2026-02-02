"""
AVA Session Manager - Persistent session state and conversation continuity
"""

import json
import time
import sqlite3
from typing import Dict, Any, List, Optional
from pathlib import Path
from dataclasses import dataclass, asdict
from datetime import datetime


@dataclass
class SessionContext:
    """Current session context"""
    active_app: str = ""
    active_window: str = ""
    context_type: str = "general"  # coding, browsing, document, media, etc.
    last_tool_used: str = ""
    pending_tasks: List[Dict] = None
    
    def __post_init__(self):
        if self.pending_tasks is None:
            self.pending_tasks = []


class VoiceSession:
    """Manages voice conversation session with continuity"""
    
    def __init__(self, max_history: int = 20):
        self.conversation_history: List[Dict[str, str]] = []
        self.max_history = max_history
        self.context = SessionContext()
        self.session_start = time.time()
        self.last_activity = time.time()
        self.corrections_learned: List[Dict] = []
        
    def add_exchange(self, user: str, ava: str, tools_used: List[str] = None):
        """Add conversation exchange to history"""
        self.conversation_history.append({
            "timestamp": time.time(),
            "user": user,
            "ava": ava,
            "tools_used": tools_used or []
        })
        self.last_activity = time.time()
        
        # Trim history if too long
        if len(self.conversation_history) > self.max_history:
            self.conversation_history.pop(0)
    
    def get_recent_context(self, n: int = 5) -> str:
        """Get recent conversation as context string"""
        recent = self.conversation_history[-n:]
        lines = []
        for ex in recent:
            lines.append(f"User: {ex['user']}")
            lines.append(f"AVA: {ex['ava']}")
        return "\n".join(lines)
    
    def update_context(self, app: str = None, window: str = None, context_type: str = None):
        """Update session context"""
        if app:
            self.context.active_app = app
        if window:
            self.context.active_window = window
        if context_type:
            self.context.context_type = context_type
        self.last_activity = time.time()
    
    def add_pending_task(self, description: str, tool: str, args: Dict):
        """Add a task AVA is tracking"""
        task = {
            "id": f"task_{int(time.time())}",
            "description": description,
            "tool": tool,
            "args": args,
            "created": time.time(),
            "status": "pending"
        }
        self.context.pending_tasks.append(task)
        return task["id"]
    
    def complete_task(self, task_id: str):
        """Mark a pending task as complete"""
        for task in self.context.pending_tasks:
            if task["id"] == task_id:
                task["status"] = "completed"
                task["completed"] = time.time()
                break
    
    def get_summary(self) -> Dict[str, Any]:
        """Get session summary"""
        return {
            "duration_seconds": time.time() - self.session_start,
            "exchanges": len(self.conversation_history),
            "active_context": asdict(self.context),
            "pending_tasks": len([t for t in self.context.pending_tasks if t["status"] == "pending"])
        }
    
    def to_dict(self) -> Dict:
        """Serialize session to dict"""
        return {
            "conversation_history": self.conversation_history,
            "context": asdict(self.context),
            "session_start": self.session_start,
            "last_activity": self.last_activity,
            "corrections_learned": self.corrections_learned
        }
    
    @classmethod
    def from_dict(cls, data: Dict) -> "VoiceSession":
        """Create session from dict"""
        session = cls()
        session.conversation_history = data.get("conversation_history", [])
        session.session_start = data.get("session_start", time.time())
        session.last_activity = data.get("last_activity", time.time())
        session.corrections_learned = data.get("corrections_learned", [])
        ctx = data.get("context", {})
        session.context = SessionContext(
            active_app=ctx.get("active_app", ""),
            active_window=ctx.get("active_window", ""),
            context_type=ctx.get("context_type", "general"),
            last_tool_used=ctx.get("last_tool_used", ""),
            pending_tasks=ctx.get("pending_tasks", [])
        )
        return session


class AccuracyMonitor:
    """Monitors and learns from ASR errors"""
    
    def __init__(self, db_path: Optional[Path] = None):
        self.db_path = db_path or Path.home() / ".cmpuse" / "accuracy_monitor.db"
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()
        self.recent_transcriptions: List[Dict] = []
        self.correction_patterns: List[Dict] = []
        
    def _init_db(self):
        """Initialize accuracy tracking database"""
        conn = sqlite3.connect(str(self.db_path))
        cursor = conn.cursor()
        
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS asr_corrections (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                heard TEXT NOT NULL,
                meant TEXT NOT NULL,
                timestamp REAL NOT NULL,
                confidence REAL,
                context TEXT
            )
        ''')
        
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS asr_accuracy (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date TEXT UNIQUE NOT NULL,
                total_transcriptions INTEGER DEFAULT 0,
                corrections_needed INTEGER DEFAULT 0,
                avg_confidence REAL
            )
        ''')
        
        cursor.execute('''
            CREATE INDEX IF NOT EXISTS idx_corrections_heard ON asr_corrections(heard)
        ''')
        
        conn.commit()
        conn.close()
    
    def record_transcription(self, transcript: str, confidence: float = 0.0, context: str = ""):
        """Record a transcription for monitoring"""
        self.recent_transcriptions.append({
            "transcript": transcript,
            "confidence": confidence,
            "timestamp": time.time(),
            "context": context
        })
        
        # Keep only last 100
        if len(self.recent_transcriptions) > 100:
            self.recent_transcriptions.pop(0)
    
    def record_correction(self, heard: str, meant: str, context: str = ""):
        """Record when user corrects ASR"""
        correction = {
            "heard": heard,
            "meant": meant,
            "timestamp": time.time(),
            "context": context
        }
        self.correction_patterns.append(correction)
        
        # Save to database
        conn = sqlite3.connect(str(self.db_path))
        cursor = conn.cursor()
        cursor.execute('''
            INSERT INTO asr_corrections (heard, meant, timestamp, context)
            VALUES (?, ?, ?, ?)
        ''', (heard, meant, time.time(), context))
        conn.commit()
        conn.close()
        
        # Check if we need to adjust VAD
        self._analyze_patterns()
    
    def _analyze_patterns(self):
        """Analyze correction patterns for systemic issues"""
        if len(self.correction_patterns) < 5:
            return
        
        # Check for common misheard words
        recent = self.correction_patterns[-10:]
        
        # If many corrections, suggest VAD adjustment
        if len(recent) >= 3:
            recent_times = [c["timestamp"] for c in recent]
            time_span = max(recent_times) - min(recent_times)
            
            # If 3+ corrections in 5 minutes, VAD might be too sensitive
            if time_span < 300:  # 5 minutes
                return {"action": "adjust_vad", "reason": "too_many_corrections", "suggested_start_rms": 400}
        
        return None
    
    def get_common_misheard(self, limit: int = 10) -> List[Dict]:
        """Get most common misheard phrases"""
        conn = sqlite3.connect(str(self.db_path))
        cursor = conn.cursor()
        
        cursor.execute('''
            SELECT heard, meant, COUNT(*) as count
            FROM asr_corrections
            GROUP BY heard, meant
            ORDER BY count DESC
            LIMIT ?
        ''', (limit,))
        
        results = [{"heard": r[0], "meant": r[1], "count": r[2]} for r in cursor.fetchall()]
        conn.close()
        return results
    
    def get_accuracy_stats(self, days: int = 7) -> Dict:
        """Get accuracy statistics"""
        conn = sqlite3.connect(str(self.db_path))
        cursor = conn.cursor()
        
        cursor.execute('''
            SELECT 
                COUNT(*) as total_corrections,
                AVG(timestamp) as avg_time
            FROM asr_corrections
            WHERE timestamp > ?
        ''', (time.time() - (days * 86400),))
        
        row = cursor.fetchone()
        conn.close()
        
        return {
            "total_corrections": row[0] if row else 0,
            "corrections_per_day": (row[0] / days) if row and row[0] else 0,
            "recent_transcriptions": len(self.recent_transcriptions)
        }


# Global instances
_session: Optional[VoiceSession] = None
_monitor: Optional[AccuracyMonitor] = None


def get_session() -> VoiceSession:
    """Get or create global voice session"""
    global _session
    if _session is None:
        _session = VoiceSession()
    return _session


def get_accuracy_monitor() -> AccuracyMonitor:
    """Get or create global accuracy monitor"""
    global _monitor
    if _monitor is None:
        _monitor = AccuracyMonitor()
    return _monitor


def reset_session():
    """Reset the global session (e.g., on new conversation)"""
    global _session
    _session = VoiceSession()
    return _session
