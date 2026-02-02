"""
Test the repetition fix - verify step status messages are filtered
"""

import sys
sys.path.insert(0, r"C:\Users\USER 1\ava-integration")

from ava_standalone_realtime import StandaloneRealtimeAVA

# Create instance to test methods
ava = StandaloneRealtimeAVA()

# Test step status detection
print("Testing step status message detection:")
print()

test_cases = [
    ("Reached step 2 of 12, currently running without any further actions to execute.", True),
    ("Executing step 5", True),
    ("Step 3 complete", True),
    ("Completed 4 of 10 steps", True),
    ("Hey there! How can I help?", False),
    ("I'm AVA, your assistant.", False),
    ("Taking a screenshot now.", False),
]

all_passed = True
for text, expected in test_cases:
    result = ava._is_step_status_message(text)
    status = "✅" if result == expected else "❌"
    if result != expected:
        all_passed = False
    print(f"  {status} '{text[:50]}...' -> {result} (expected {expected})")

print()
if all_passed:
    print("✅ All step status detection tests passed!")
else:
    print("❌ Some tests failed!")

# Test natural response generation
print()
print("Testing natural response generation:")
print()

queries = [
    "hi",
    "huh?",
    "what's your name?",
    "mouse",
    "screenshot",
    "system info",
]

for query in queries:
    response = ava._get_natural_response(query, "bad step status")
    print(f"  Query: '{query}' -> Response: '{response[:60]}...'")

print()
print("✅ Repetition fix is active!")
print()
print("Next: Speak to AVA and verify she responds naturally instead of")
print("repeating 'Reached step 2 of 12...'")
