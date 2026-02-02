"""
AVA Standalone - Always-on voice assistant with system tray
Run this to have AVA listening in the background 24/7
"""

import sys
import os
import threading
import time
from datetime import datetime

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

class StandaloneAVA:
    def __init__(self):
        print("🤖 AVA Standalone Initializing...")
        self.config = Config.from_env()
        self.agent = Agent(self.config)
        self.voice_loop = None
        self.running = False
        self.interactions = []

    def handle_voice_input(self, utterance):
        """Process voice input and respond"""
        try:
            timestamp = datetime.now().strftime("%H:%M:%S")
            print(f"\n[{timestamp}] 👤 You: {utterance}")

            # Store interaction
            self.interactions.append({
                "timestamp": timestamp,
                "user": utterance,
                "ava": None
            })

            # Get memory context
            memory_context = []
            user_facts = []
            try:
                # Get conversation history
                memory_plan = Plan(steps=[Step(tool="memory_system", args={
                    "action": "get_context",
                    "session_id": "standalone_session",
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
                    print(f"  🔧 Using {len(planned_steps)} tool(s)...")
                    steps = []
                    for step in planned_steps:
                        args = step.get('args', {})
                        args['confirm'] = True
                        steps.append(Step(tool=step['tool'], args=args))
                    plan = Plan(steps=steps)
                    tool_results = self.agent.run(plan, force=True)
            except Exception as plan_error:
                print(f"  ⚠️ Planning error: {plan_error}")

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

            # Update interaction record
            self.interactions[-1]["ava"] = response

            # Store in memory system
            try:
                memory_store_plan = Plan(steps=[Step(tool="memory_system", args={
                    "action": "store",
                    "user_message": utterance,
                    "ava_response": response,
                    "context": f"Tools used: {[r.get('tool', 'unknown') for r in tool_results]}",
                    "session_id": "standalone_session",
                    "tools_used": [r.get('tool', 'unknown') for r in tool_results],
                    "confirm": True
                })])
                self.agent.run(memory_store_plan, force=True)
            except Exception:
                pass  # Continue even if memory storage fails

            # Speak response
            print(f"  🤖 AVA: {response}")
            speak(response, allow_shell=True)

            # Keep only last 50 interactions
            if len(self.interactions) > 50:
                self.interactions = self.interactions[-50:]

        except Exception as e:
            error_msg = f"Sorry, I encountered an error: {str(e)}"
            print(f"  ❌ Error: {error_msg}")
            speak(error_msg, allow_shell=True)

    def start(self):
        """Start AVA in standalone mode"""
        print("\n" + "="*60)
        print("🤖 AVA STANDALONE - ALWAYS-ON VOICE ASSISTANT")
        print("="*60)
        print(f"📅 Started: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        print(f"🎤 Wake word: 'AVA' or 'Hey AVA'")
        print(f"🔧 Tools available: 25")
        print(f"🧠 Model: GPT-5.2 Pro")
        print("="*60)
        print("\n✅ AVA is now listening... Say 'AVA' to wake me up!")
        print("   (Press Ctrl+C to quit)\n")

        self.running = True

        # Start voice loop
        try:
            self.voice_loop = VoiceLoop(
                wake_word="ava",
                on_utterance=self.handle_voice_input
            )
            success = self.voice_loop.start()

            if not success:
                print("❌ Failed to start voice recognition. Check your microphone.")
                return

            # Keep running
            while self.running:
                time.sleep(1)

        except KeyboardInterrupt:
            print("\n\n👋 Shutting down AVA...")
            self.stop()
        except Exception as e:
            print(f"\n❌ Error: {e}")
            self.stop()

    def stop(self):
        """Stop AVA"""
        self.running = False
        if self.voice_loop:
            self.voice_loop.stop()
        print("✅ AVA stopped. Goodbye!")

def main():
    """Main entry point"""
    ava = StandaloneAVA()
    ava.start()

if __name__ == "__main__":
    main()
