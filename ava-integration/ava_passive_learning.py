"""
AVA Passive Learning System
============================

Provides background learning capabilities:
1. Screen context awareness - learns from visible applications and content
2. Camera/vision learning - periodic environment and face awareness
3. Voice/text pattern learning - integrated with self-awareness

This runs passively in the background, gathering context without interrupting.
"""

import os
import json
import time
import threading
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, List, Any, Optional, Callable
import asyncio

# Optional imports for vision capabilities
try:
    import cv2
    CV2_AVAILABLE = True
except ImportError:
    CV2_AVAILABLE = False

try:
    from PIL import ImageGrab
    SCREEN_CAPTURE_AVAILABLE = True
except ImportError:
    SCREEN_CAPTURE_AVAILABLE = False

try:
    import pyautogui
    PYAUTOGUI_AVAILABLE = True
except ImportError:
    PYAUTOGUI_AVAILABLE = False

# =============================================================================
# CONFIGURATION
# =============================================================================

LEARNING_DB = Path(os.path.expanduser("~/.cmpuse/learning.db"))
PASSIVE_LEARNING_INTERVAL = 300  # 5 minutes between passive observations
SCREEN_CONTEXT_INTERVAL = 60     # 1 minute for screen context
CAMERA_INTERVAL = 600            # 10 minutes for camera checks

# =============================================================================
# DATABASE SETUP
# =============================================================================

def init_passive_learning_db():
    """Initialize passive learning tables"""
    LEARNING_DB.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(LEARNING_DB))
    c = conn.cursor()
    
    # Screen context observations
    c.execute('''CREATE TABLE IF NOT EXISTS screen_context (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        active_app TEXT,
        window_title TEXT,
        visible_apps TEXT,
        context_type TEXT,
        timestamp TEXT NOT NULL
    )''')
    
    # Camera/environment observations
    c.execute('''CREATE TABLE IF NOT EXISTS environment_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        observation_type TEXT,
        observation_data TEXT,
        confidence REAL,
        timestamp TEXT NOT NULL
    )''')
    
    # Conversation context (what was happening when user spoke)
    c.execute('''CREATE TABLE IF NOT EXISTS conversation_context (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        transcript TEXT,
        active_app TEXT,
        time_of_day TEXT,
        day_of_week TEXT,
        response_given TEXT,
        was_helpful INTEGER,
        timestamp TEXT NOT NULL
    )''')
    
    # Learned workflows (sequences of actions)
    c.execute('''CREATE TABLE IF NOT EXISTS learned_workflows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_name TEXT,
        trigger_context TEXT,
        action_sequence TEXT,
        frequency INTEGER DEFAULT 1,
        last_used TEXT,
        created_at TEXT NOT NULL
    )''')
    
    conn.commit()
    conn.close()

# =============================================================================
# SCREEN CONTEXT AWARENESS
# =============================================================================

class ScreenContextObserver:
    """Observes and learns from screen context"""
    
    def __init__(self):
        self.last_observation = None
        self.app_usage_patterns = {}
        
    def get_active_window(self) -> Dict[str, str]:
        """Get information about the active window"""
        result = {"app": "unknown", "title": "unknown"}
        
        try:
            import platform
            if platform.system() == "Windows":
                import ctypes
                from ctypes import wintypes
                
                user32 = ctypes.windll.user32
                hwnd = user32.GetForegroundWindow()
                
                # Get window title
                length = user32.GetWindowTextLengthW(hwnd)
                buff = ctypes.create_unicode_buffer(length + 1)
                user32.GetWindowTextW(hwnd, buff, length + 1)
                result["title"] = buff.value
                
                # Get process name
                pid = wintypes.DWORD()
                user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
                
                import psutil
                try:
                    process = psutil.Process(pid.value)
                    result["app"] = process.name()
                except:
                    pass
                    
        except Exception as e:
            pass
            
        return result
    
    def get_visible_apps(self) -> List[str]:
        """Get list of visible/running applications"""
        apps = []
        try:
            import psutil
            for proc in psutil.process_iter(['name', 'status']):
                try:
                    if proc.info['status'] == psutil.STATUS_RUNNING:
                        name = proc.info['name']
                        if name and name not in apps:
                            apps.append(name)
                except:
                    pass
        except:
            pass
        return apps[:20]  # Limit to 20 apps
    
    def classify_context(self, active_app: str, title: str) -> str:
        """Classify the current context type"""
        app_lower = active_app.lower()
        title_lower = title.lower()
        
        # Coding context
        if any(x in app_lower for x in ['code', 'visual studio', 'pycharm', 'sublime', 'atom', 'notepad++']):
            return "coding"
        if any(x in app_lower for x in ['cmd', 'powershell', 'terminal', 'bash']):
            return "terminal"
            
        # Communication
        if any(x in app_lower for x in ['outlook', 'gmail', 'mail', 'thunderbird']):
            return "email"
        if any(x in app_lower for x in ['slack', 'teams', 'discord', 'zoom', 'meet']):
            return "communication"
            
        # Browsing
        if any(x in app_lower for x in ['chrome', 'firefox', 'edge', 'safari', 'brave']):
            if any(x in title_lower for x in ['youtube', 'netflix', 'video']):
                return "entertainment"
            if any(x in title_lower for x in ['github', 'stackoverflow', 'docs']):
                return "research"
            return "browsing"
            
        # Productivity
        if any(x in app_lower for x in ['word', 'excel', 'powerpoint', 'docs', 'sheets']):
            return "documents"
        if any(x in app_lower for x in ['notion', 'obsidian', 'onenote', 'evernote']):
            return "notes"
            
        # Media
        if any(x in app_lower for x in ['spotify', 'music', 'vlc', 'media']):
            return "media"
            
        return "general"
    
    def observe(self) -> Dict[str, Any]:
        """Take a screen context observation"""
        window = self.get_active_window()
        apps = self.get_visible_apps()
        context_type = self.classify_context(window["app"], window["title"])
        
        observation = {
            "active_app": window["app"],
            "window_title": window["title"][:200],  # Limit title length
            "visible_apps": apps,
            "context_type": context_type,
            "timestamp": datetime.now().isoformat()
        }
        
        self.last_observation = observation
        return observation
    
    def save_observation(self, observation: Dict[str, Any]):
        """Save observation to database"""
        try:
            conn = sqlite3.connect(str(LEARNING_DB))
            c = conn.cursor()
            c.execute('''INSERT INTO screen_context 
                        (active_app, window_title, visible_apps, context_type, timestamp)
                        VALUES (?, ?, ?, ?, ?)''',
                     (observation["active_app"],
                      observation["window_title"],
                      json.dumps(observation["visible_apps"]),
                      observation["context_type"],
                      observation["timestamp"]))
            conn.commit()
            conn.close()
        except Exception as e:
            print(f"[passive-learning] Error saving screen context: {e}")
    
    def get_context_patterns(self) -> Dict[str, Any]:
        """Analyze screen context patterns"""
        patterns = {"by_hour": {}, "by_day": {}, "common_apps": {}}
        
        try:
            conn = sqlite3.connect(str(LEARNING_DB))
            c = conn.cursor()
            
            # Get context by hour
            c.execute('''SELECT strftime('%H', timestamp) as hour, context_type, COUNT(*) 
                        FROM screen_context 
                        GROUP BY hour, context_type 
                        ORDER BY COUNT(*) DESC''')
            for row in c.fetchall():
                hour = row[0]
                if hour not in patterns["by_hour"]:
                    patterns["by_hour"][hour] = {}
                patterns["by_hour"][hour][row[1]] = row[2]
            
            # Get most common apps
            c.execute('''SELECT active_app, COUNT(*) as cnt 
                        FROM screen_context 
                        GROUP BY active_app 
                        ORDER BY cnt DESC 
                        LIMIT 10''')
            for row in c.fetchall():
                patterns["common_apps"][row[0]] = row[1]
            
            conn.close()
        except:
            pass
            
        return patterns

# =============================================================================
# CAMERA/VISION OBSERVER
# =============================================================================

class VisionObserver:
    """Observes environment via camera when available"""
    
    def __init__(self):
        self.camera_available = CV2_AVAILABLE
        self.last_face_detected = None
        self.environment_state = "unknown"
        
    def capture_frame(self) -> Optional[Any]:
        """Capture a frame from camera"""
        if not self.camera_available:
            return None
            
        try:
            cap = cv2.VideoCapture(0)
            ret, frame = cap.read()
            cap.release()
            
            if ret:
                return frame
        except:
            pass
        return None
    
    def detect_presence(self, frame) -> Dict[str, Any]:
        """Detect if someone is present (basic face detection)"""
        result = {"person_present": False, "confidence": 0.0}
        
        if frame is None or not self.camera_available:
            return result
            
        try:
            # Use OpenCV's built-in face detector
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            face_cascade = cv2.CascadeClassifier(
                cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'
            )
            faces = face_cascade.detectMultiScale(gray, 1.1, 4)
            
            if len(faces) > 0:
                result["person_present"] = True
                result["confidence"] = min(1.0, len(faces) * 0.5)
                result["face_count"] = len(faces)
                self.last_face_detected = datetime.now()
                
        except Exception as e:
            pass
            
        return result
    
    def detect_lighting(self, frame) -> str:
        """Detect ambient lighting conditions"""
        if frame is None:
            return "unknown"
            
        try:
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            avg_brightness = gray.mean()
            
            if avg_brightness < 50:
                return "dark"
            elif avg_brightness < 100:
                return "dim"
            elif avg_brightness < 180:
                return "normal"
            else:
                return "bright"
        except:
            return "unknown"
    
    def observe(self) -> Dict[str, Any]:
        """Take an environment observation"""
        frame = self.capture_frame()
        presence = self.detect_presence(frame)
        lighting = self.detect_lighting(frame)
        
        observation = {
            "observation_type": "environment",
            "person_present": presence["person_present"],
            "confidence": presence["confidence"],
            "lighting": lighting,
            "timestamp": datetime.now().isoformat()
        }
        
        self.environment_state = "occupied" if presence["person_present"] else "empty"
        
        return observation
    
    def save_observation(self, observation: Dict[str, Any]):
        """Save observation to database"""
        try:
            conn = sqlite3.connect(str(LEARNING_DB))
            c = conn.cursor()
            c.execute('''INSERT INTO environment_observations 
                        (observation_type, observation_data, confidence, timestamp)
                        VALUES (?, ?, ?, ?)''',
                     (observation["observation_type"],
                      json.dumps(observation),
                      observation.get("confidence", 0.0),
                      observation["timestamp"]))
            conn.commit()
            conn.close()
        except Exception as e:
            print(f"[passive-learning] Error saving environment observation: {e}")

# =============================================================================
# CONVERSATION CONTEXT LEARNING
# =============================================================================

class ConversationContextLearner:
    """Learns from conversation context"""
    
    def __init__(self, screen_observer: ScreenContextObserver):
        self.screen_observer = screen_observer
        
    def record_conversation(self, transcript: str, response: str, was_helpful: bool = True):
        """Record a conversation with its context"""
        now = datetime.now()
        screen_context = self.screen_observer.last_observation or {}
        
        try:
            conn = sqlite3.connect(str(LEARNING_DB))
            c = conn.cursor()
            c.execute('''INSERT INTO conversation_context 
                        (transcript, active_app, time_of_day, day_of_week, 
                         response_given, was_helpful, timestamp)
                        VALUES (?, ?, ?, ?, ?, ?, ?)''',
                     (transcript[:500],
                      screen_context.get("active_app", "unknown"),
                      now.strftime("%H:%M"),
                      now.strftime("%A"),
                      response[:500],
                      1 if was_helpful else 0,
                      now.isoformat()))
            conn.commit()
            conn.close()
        except Exception as e:
            print(f"[passive-learning] Error recording conversation: {e}")
    
    def learn_workflow(self, workflow_name: str, trigger: str, actions: List[str]):
        """Learn a workflow from observed actions"""
        try:
            conn = sqlite3.connect(str(LEARNING_DB))
            c = conn.cursor()
            
            # Check if workflow exists
            c.execute('SELECT id, frequency FROM learned_workflows WHERE workflow_name = ?', 
                     (workflow_name,))
            existing = c.fetchone()
            
            now = datetime.now().isoformat()
            if existing:
                c.execute('''UPDATE learned_workflows 
                           SET frequency = ?, last_used = ?
                           WHERE id = ?''',
                         (existing[1] + 1, now, existing[0]))
            else:
                c.execute('''INSERT INTO learned_workflows 
                           (workflow_name, trigger_context, action_sequence, last_used, created_at)
                           VALUES (?, ?, ?, ?, ?)''',
                         (workflow_name, trigger, json.dumps(actions), now, now))
            
            conn.commit()
            conn.close()
        except Exception as e:
            print(f"[passive-learning] Error learning workflow: {e}")
    
    def get_suggested_action(self, context: str) -> Optional[str]:
        """Suggest an action based on learned patterns"""
        try:
            conn = sqlite3.connect(str(LEARNING_DB))
            c = conn.cursor()
            
            # Find matching workflow
            c.execute('''SELECT action_sequence FROM learned_workflows 
                        WHERE trigger_context LIKE ? 
                        ORDER BY frequency DESC LIMIT 1''',
                     (f'%{context}%',))
            result = c.fetchone()
            conn.close()
            
            if result:
                actions = json.loads(result[0])
                return actions[0] if actions else None
        except:
            pass
        return None

# =============================================================================
# PASSIVE LEARNING ENGINE
# =============================================================================

class PassiveLearningEngine:
    """Main passive learning engine that coordinates all observers"""
    
    def __init__(self):
        init_passive_learning_db()
        
        self.screen_observer = ScreenContextObserver()
        self.vision_observer = VisionObserver()
        self.conversation_learner = ConversationContextLearner(self.screen_observer)
        
        self.running = False
        self.shutdown = threading.Event()
        self._threads = []
        
    def start(self):
        """Start passive learning threads"""
        if self.running:
            return
            
        self.running = True
        self.shutdown.clear()
        
        # Screen context thread
        screen_thread = threading.Thread(
            target=self._screen_observation_loop,
            name="passive_screen",
            daemon=True
        )
        screen_thread.start()
        self._threads.append(screen_thread)
        
        # Vision thread (if camera available)
        if self.vision_observer.camera_available:
            vision_thread = threading.Thread(
                target=self._vision_observation_loop,
                name="passive_vision",
                daemon=True
            )
            vision_thread.start()
            self._threads.append(vision_thread)
        
        print("[passive-learning] Passive learning engine started")
        
    def stop(self):
        """Stop passive learning"""
        self.shutdown.set()
        self.running = False
        print("[passive-learning] Passive learning engine stopped")
        
    def _screen_observation_loop(self):
        """Background loop for screen context observation"""
        while not self.shutdown.is_set():
            try:
                obs = self.screen_observer.observe()
                self.screen_observer.save_observation(obs)
            except Exception as e:
                pass
            
            # Wait for next interval
            self.shutdown.wait(SCREEN_CONTEXT_INTERVAL)
    
    def _vision_observation_loop(self):
        """Background loop for vision/camera observation"""
        while not self.shutdown.is_set():
            try:
                obs = self.vision_observer.observe()
                if obs["person_present"]:
                    self.vision_observer.save_observation(obs)
            except Exception as e:
                pass
            
            # Wait for next interval
            self.shutdown.wait(CAMERA_INTERVAL)
    
    def record_interaction(self, transcript: str, response: str, helpful: bool = True):
        """Record a voice/text interaction"""
        self.conversation_learner.record_conversation(transcript, response, helpful)
    
    def get_current_context(self) -> Dict[str, Any]:
        """Get current context for prompt enhancement"""
        screen = self.screen_observer.last_observation or {}
        
        return {
            "active_app": screen.get("active_app", "unknown"),
            "context_type": screen.get("context_type", "general"),
            "time_of_day": datetime.now().strftime("%H:%M"),
            "day_of_week": datetime.now().strftime("%A"),
            "person_present": self.vision_observer.environment_state == "occupied"
        }
    
    def get_learning_summary(self) -> Dict[str, Any]:
        """Get summary of what's been learned"""
        summary = {
            "screen_patterns": self.screen_observer.get_context_patterns(),
            "total_observations": 0,
            "total_conversations": 0,
            "learned_workflows": 0
        }
        
        try:
            conn = sqlite3.connect(str(LEARNING_DB))
            c = conn.cursor()
            
            c.execute('SELECT COUNT(*) FROM screen_context')
            summary["total_observations"] = c.fetchone()[0]
            
            c.execute('SELECT COUNT(*) FROM conversation_context')
            summary["total_conversations"] = c.fetchone()[0]
            
            c.execute('SELECT COUNT(*) FROM learned_workflows')
            summary["learned_workflows"] = c.fetchone()[0]
            
            conn.close()
        except:
            pass
            
        return summary

# =============================================================================
# SINGLETON AND CONVENIENCE FUNCTIONS
# =============================================================================

_engine = None

def get_passive_learning() -> PassiveLearningEngine:
    """Get singleton passive learning engine"""
    global _engine
    if _engine is None:
        _engine = PassiveLearningEngine()
    return _engine

def start_passive_learning():
    """Start passive learning"""
    get_passive_learning().start()

def stop_passive_learning():
    """Stop passive learning"""
    get_passive_learning().stop()

def get_current_context() -> Dict[str, Any]:
    """Get current context"""
    return get_passive_learning().get_current_context()

def record_interaction(transcript: str, response: str, helpful: bool = True):
    """Record an interaction"""
    get_passive_learning().record_interaction(transcript, response, helpful)

def get_learning_summary() -> Dict[str, Any]:
    """Get learning summary"""
    return get_passive_learning().get_learning_summary()


# =============================================================================
# PROACTIVE MANAGER
# =============================================================================

class ProactiveManager:
    """
    Manages proactive assistance - monitoring system state and offering help
    before being asked. Runs in background thread.
    """
    
    def __init__(self, check_interval: int = 30):
        self.check_interval = check_interval
        self.running = False
        self.thread: Optional[threading.Thread] = None
        self.last_check = 0
        self.suggestion_callbacks: List[Callable[[str], None]] = []
        
        # Track system state
        self.last_cpu_check = 0
        self.last_cpu_high = False
        self.last_disk_check = 0
        self.last_disk_low = False
        
        # Proactive suggestions enabled
        self.suggestions_enabled = {
            'high_cpu': True,
            'low_disk': True,
            'morning_routine': True,
            'evening_routine': True,
            'break_reminder': True,
        }
        
        # Time-based tracking
        self.last_morning_check = None
        self.last_evening_check = None
        self.day_start = datetime.now().replace(hour=8, minute=0, second=0)
        self.day_end = datetime.now().replace(hour=18, minute=0, second=0)
    
    def start(self):
        """Start proactive monitoring"""
        if self.running:
            return
        self.running = True
        self.thread = threading.Thread(target=self._monitor_loop, daemon=True)
        self.thread.start()
        print("[proactive] Manager started")
    
    def stop(self):
        """Stop proactive monitoring"""
        self.running = False
        if self.thread:
            self.thread.join(timeout=2.0)
        print("[proactive] Manager stopped")
    
    def on_suggestion(self, callback: Callable[[str], None]):
        """Register a callback for proactive suggestions"""
        self.suggestion_callbacks.append(callback)
    
    def _emit_suggestion(self, message: str):
        """Emit a suggestion to all registered callbacks"""
        for callback in self.suggestion_callbacks:
            try:
                callback(message)
            except Exception:
                pass
    
    def _monitor_loop(self):
        """Main monitoring loop"""
        while self.running:
            try:
                now = time.time()
                current_dt = datetime.now()
                
                # Check system health periodically
                if now - self.last_cpu_check > 60:
                    self._check_cpu_usage()
                    self.last_cpu_check = now
                
                if now - self.last_disk_check > 300:  # Every 5 minutes
                    self._check_disk_space()
                    self.last_disk_check = now
                
                # Time-based suggestions
                if self.suggestions_enabled['morning_routine']:
                    self._check_morning_routine(current_dt)
                
                if self.suggestions_enabled['evening_routine']:
                    self._check_evening_routine(current_dt)
                
                # Break reminder (every 2 hours of continuous use)
                if self.suggestions_enabled['break_reminder']:
                    self._check_break_reminder(current_dt)
                
                time.sleep(self.check_interval)
            except Exception as e:
                print(f"[proactive] Monitor error: {e}")
                time.sleep(self.check_interval)
    
    def _check_cpu_usage(self):
        """Check if CPU usage is high and suggest action"""
        try:
            import psutil
            cpu = psutil.cpu_percent(interval=1)
            
            if cpu > 90:
                if not self.last_cpu_high:
                    self._emit_suggestion(f"I notice your CPU is at {cpu}%. Want me to check what's using resources?")
                    self.last_cpu_high = True
            else:
                self.last_cpu_high = False
        except ImportError:
            pass
    
    def _check_disk_space(self):
        """Check if disk space is low"""
        try:
            import psutil
            disk = psutil.disk_usage('/')
            percent_free = (disk.free / disk.total) * 100
            
            if percent_free < 10:
                if not self.last_disk_low:
                    self._emit_suggestion(f"Your disk is {100-percent_free:.1f}% full. Should I help clean up temporary files?")
                    self.last_disk_low = True
            else:
                self.last_disk_low = False
        except ImportError:
            pass
    
    def _check_morning_routine(self, now: datetime):
        """Check if it's morning and user might want routine"""
        if now.hour >= 8 and now.hour < 10:
            today = now.date()
            if self.last_morning_check != today:
                self._emit_suggestion("Good morning! Want me to check your calendar and emails for today?")
                self.last_morning_check = today
    
    def _check_evening_routine(self, now: datetime):
        """Check if it's evening"""
        if now.hour >= 17 and now.hour < 19:
            today = now.date()
            if self.last_evening_check != today:
                self._emit_suggestion("Good evening! Shall I help wrap up your workday?")
                self.last_evening_check = today
    
    def _check_break_reminder(self, now: datetime):
        """Remind to take breaks during long sessions"""
        # This would need session duration tracking
        pass
    
    def get_suggestions(self) -> List[str]:
        """Get current proactive suggestions"""
        suggestions = []
        
        # These would be populated based on current state
        if self.last_cpu_high:
            suggestions.append("High CPU usage detected")
        if self.last_disk_low:
            suggestions.append("Low disk space")
        
        return suggestions


# Global proactive manager instance
_proactive_manager: Optional[ProactiveManager] = None

def get_proactive_manager() -> ProactiveManager:
    """Get or create global proactive manager"""
    global _proactive_manager
    if _proactive_manager is None:
        _proactive_manager = ProactiveManager()
    return _proactive_manager


# =============================================================================
# CLI TEST
# =============================================================================

if __name__ == "__main__":
    print("AVA Passive Learning System")
    print("=" * 50)
    
    engine = get_passive_learning()
    
    print("\nTaking screen observation...")
    obs = engine.screen_observer.observe()
    print(f"  Active app: {obs['active_app']}")
    print(f"  Window title: {obs['window_title'][:50]}...")
    print(f"  Context type: {obs['context_type']}")
    
    if engine.vision_observer.camera_available:
        print("\nTaking vision observation...")
        vis = engine.vision_observer.observe()
        print(f"  Person present: {vis['person_present']}")
        print(f"  Lighting: {vis['lighting']}")
    else:
        print("\nVision: Camera not available (cv2 not installed)")
    
    print("\nGetting learning summary...")
    summary = engine.get_learning_summary()
    print(f"  Total screen observations: {summary['total_observations']}")
    print(f"  Total conversations: {summary['total_conversations']}")
    print(f"  Learned workflows: {summary['learned_workflows']}")
    
    print("\n✅ Passive learning system loaded successfully")
