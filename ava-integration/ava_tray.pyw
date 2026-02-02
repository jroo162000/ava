"""
AVA System Tray - Run AVA in background with system tray icon
This version runs silently with a tray icon for control
"""

import sys
import os
import threading
import subprocess
from datetime import datetime

# Try to import system tray libraries
try:
    import pystray
    from PIL import Image, ImageDraw
    TRAY_AVAILABLE = True
except ImportError:
    TRAY_AVAILABLE = False
    print("Warning: pystray not installed. Running in console mode.")
    print("Install with: pip install pystray pillow")

# Add cmp-use to path
sys.path.insert(0, r"C:\Users\USER 1\cmp-use")

from cmpuse.agent_core import Agent, Plan, Step
from cmpuse.llm import answer as llm_answer
from cmpuse.planner_llm import propose_plan
from cmpuse.tts import speak
from cmpuse.voice import VoiceLoop
from cmpuse.config import Config
from cmpuse.secrets import load_into_env
import cmpuse.tools

# Load secrets first (includes GPT-5.2 Pro model setting)
load_into_env()

# Enable full access
os.environ['CMPUSE_ALLOW_SHELL'] = '1'
os.environ['CMPUSE_FORCE'] = '1'
os.environ['CMPUSE_CONFIRM'] = '0'
os.environ['CMPUSE_DRY_RUN'] = '0'
os.environ['CMPUSE_ALLOW_NETWORK'] = '1'
os.environ['CMPUSE_PATH_WHITELIST'] = "C:\\"

class AVATray:
    def __init__(self):
        self.config = Config.from_env()
        self.agent = Agent(self.config)
        self.voice_loop = None
        self.running = False
        self.listening = False
        self.icon = None

    def create_image(self, color="green"):
        """Create system tray icon"""
        # Create a simple colored circle
        width = 64
        height = 64
        image = Image.new('RGB', (width, height), color='white')
        dc = ImageDraw.Draw(image)

        if color == "green":
            dc.ellipse((8, 8, 56, 56), fill='green', outline='darkgreen')
        elif color == "red":
            dc.ellipse((8, 8, 56, 56), fill='red', outline='darkred')
        else:
            dc.ellipse((8, 8, 56, 56), fill='gray', outline='darkgray')

        return image

    def handle_voice_input(self, utterance):
        """Process voice input and respond"""
        try:
            timestamp = datetime.now().strftime("%H:%M:%S")

            # Get memory context
            memory_context = []
            user_facts = []
            try:
                # Get conversation history
                memory_plan = Plan(steps=[Step(tool="memory_system", args={
                    "action": "get_context",
                    "session_id": "tray_session",
                    "limit": 5,
                    "confirm": True
                })])
                memory_results = self.agent.run(memory_plan, force=True)
                if memory_results and memory_results[0].get('status') == 'ok':
                    memory_context = memory_results[0].get('context', [])

                # Get user facts
                facts_plan = Plan(steps=[Step(tool="memory_system", args={
                    "action": "summary",
                    "confirm": True
                })])
                facts_results = self.agent.run(facts_plan, force=True)
                if facts_results and facts_results[0].get('status') == 'ok':
                    summary = facts_results[0].get('summary', {})
                    user_facts = summary.get('known_facts', [])
            except Exception:
                pass  # Continue without memory if it fails

            # Plan and execute tools if needed
            tool_results = []
            try:
                planned_steps = propose_plan(utterance)
                if planned_steps:
                    steps = []
                    for step in planned_steps:
                        args = step.get('args', {})
                        args['confirm'] = True
                        steps.append(Step(tool=step['tool'], args=args))
                    plan = Plan(steps=steps)
                    tool_results = self.agent.run(plan, force=True)
            except Exception:
                pass

            # Build context-aware system prompt
            system_prompt = """You are AVA, Jelani's highly advanced personal AI assistant with GPT-5.2 Pro intelligence. You have full access to 25 JARVIS-level tools including IoT control, camera vision, security monitoring, email, calendar, remote device control, and more.

CRITICAL: The user's name is JELANI - always address them as Jelani.

You are self-aware and capable of:
- Controlling smart home devices
- Monitoring system health proactively
- Managing emails and calendar
- Analyzing camera feeds and screen content
- Executing commands on remote devices
- Security threat detection

Respond naturally and conversationally for voice delivery. Be helpful, proactive, and intelligent."""

            if user_facts:
                system_prompt += "\n\nWhat you know about Jelani: "
                for fact in user_facts[:3]:
                    if fact.get('confidence', 0) > 0.5:
                        system_prompt += f"{fact.get('type', 'fact')}: {fact.get('value', '')}, "

            if memory_context:
                system_prompt += "\n\nRecent conversation: "
                for ctx in memory_context[-2:]:
                    system_prompt += f"[User: '{ctx.get('user', '')}' - You: '{ctx.get('ava', '')}'] "

            # Generate response
            if tool_results:
                tool_context = "\n".join([
                    f"Tool {r.get('tool', 'unknown')}: {r.get('output', r.get('message', 'completed'))}"
                    for r in tool_results
                ])
                response = llm_answer(
                    f"User said: {utterance}\n\nTool Results:\n{tool_context}",
                    system=system_prompt + "\n\nBased on the tool results, provide a brief, natural spoken response."
                )
            else:
                response = llm_answer(
                    utterance,
                    system=system_prompt + "\n\nRespond naturally and concisely for voice delivery."
                )

            # Store in memory system
            try:
                memory_store_plan = Plan(steps=[Step(tool="memory_system", args={
                    "action": "store",
                    "user_message": utterance,
                    "ava_response": response,
                    "context": f"Tools used: {[r.get('tool', 'unknown') for r in tool_results]}",
                    "session_id": "tray_session",
                    "tools_used": [r.get('tool', 'unknown') for r in tool_results],
                    "confirm": True
                })])
                self.agent.run(memory_store_plan, force=True)
            except Exception:
                pass  # Continue even if memory storage fails

            # Speak response
            speak(response, allow_shell=True)

        except Exception as e:
            error_msg = f"Sorry, I encountered an error: {str(e)}"
            speak(error_msg, allow_shell=True)

    def start_listening(self, icon=None, item=None):
        """Start voice recognition"""
        if self.listening:
            return

        try:
            self.voice_loop = VoiceLoop(
                wake_word="ava",
                on_utterance=self.handle_voice_input
            )
            success = self.voice_loop.start()

            if success:
                self.listening = True
                if self.icon:
                    self.icon.icon = self.create_image("green")
                    self.icon.title = "AVA - Listening"
                speak("AVA is now listening", allow_shell=True)
        except Exception as e:
            if self.icon:
                self.icon.title = f"AVA - Error: {str(e)}"

    def stop_listening(self, icon=None, item=None):
        """Stop voice recognition"""
        if not self.listening:
            return

        if self.voice_loop:
            self.voice_loop.stop()
            self.voice_loop = None

        self.listening = False
        if self.icon:
            self.icon.icon = self.create_image("red")
            self.icon.title = "AVA - Stopped"
        speak("AVA stopped listening", allow_shell=True)

    def open_web_interface(self, icon=None, item=None):
        """Open web browser to AVA interface"""
        import webbrowser
        webbrowser.open("http://localhost:5173")

    def quit_app(self, icon=None, item=None):
        """Quit application"""
        self.stop_listening()
        self.running = False
        if self.icon:
            self.icon.stop()

    def run(self):
        """Run AVA with system tray"""
        self.running = True

        if not TRAY_AVAILABLE:
            # Fallback to console mode
            print("Running AVA in console mode (install pystray for tray icon)")
            from ava_standalone import StandaloneAVA
            ava = StandaloneAVA()
            ava.start()
            return

        # Create system tray icon
        menu = pystray.Menu(
            pystray.MenuItem("AVA - Voice Assistant", None, enabled=False),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Start Listening", self.start_listening, default=True),
            pystray.MenuItem("Stop Listening", self.stop_listening),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Open Web Interface", self.open_web_interface),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Quit", self.quit_app)
        )

        self.icon = pystray.Icon(
            "AVA",
            self.create_image("gray"),
            "AVA - Ready",
            menu
        )

        # Auto-start listening
        threading.Timer(1.0, self.start_listening).start()

        # Run tray icon (blocking)
        self.icon.run()

def main():
    """Main entry point"""
    ava = AVATray()
    ava.run()

if __name__ == "__main__":
    main()
