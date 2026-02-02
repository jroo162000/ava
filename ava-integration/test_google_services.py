"""
Google Services Testing - Calendar and Gmail
Tests calendar_ops and comm_ops (Gmail)
"""

import sys
import os
from datetime import datetime, timedelta

# Set UTF-8 encoding for Windows console
if sys.platform == 'win32':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except:
        pass

# Add cmp-use to path
sys.path.insert(0, r"C:\Users\USER 1\cmp-use")

from cmpuse.agent_core import Agent, Plan, Step
from cmpuse.config import Config
from cmpuse.secrets import load_into_env
import cmpuse.tools  # IMPORTANT: Import tools to register them

print("=" * 100)
print("GOOGLE SERVICES TESTING - Calendar & Gmail")
print("=" * 100)
print(f"Started: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")

# Load configuration
load_into_env()
config = Config.from_env()
agent = Agent(config)

# ============================================================================
# GOOGLE CALENDAR TESTS
# ============================================================================
print("\n" + "=" * 100)
print("GOOGLE CALENDAR TESTS (calendar_ops)")
print("=" * 100)

# Test 1: List events
print("\n1. Testing: List Calendar Events")
print("-" * 100)
try:
    plan = Plan(steps=[Step(tool="calendar_ops", args={
        "action": "list_events",
        "max_results": 10,
        "confirm": True
    })])
    results = agent.run(plan, force=True)

    if results:
        status = results[0].get('status')
        print(f"Status: {status}")

        if status == 'ok':
            events = results[0].get('events', [])
            count = results[0].get('count', 0)
            print(f"✅ SUCCESS - Found {count} upcoming events")

            if count > 0:
                print("\nUpcoming Events:")
                for i, event in enumerate(events[:5], 1):
                    print(f"  {i}. {event.get('summary', 'No title')}")
                    print(f"     Start: {event.get('start', 'Unknown')}")
                    print(f"     Location: {event.get('location', 'None')}")
        elif status == 'error':
            message = results[0].get('message', '')
            note = results[0].get('note', '')
            if 'not configured' in message.lower():
                print(f"⚠️  OAuth Not Configured")
                print(f"Message: {message}")
                print(f"\n{note}")
            else:
                print(f"❌ ERROR: {message}")
    else:
        print("❌ No results returned")

except Exception as e:
    print(f"❌ Exception: {str(e)}")

# Test 2: Get today's events
print("\n2. Testing: Get Today's Events")
print("-" * 100)
try:
    plan = Plan(steps=[Step(tool="calendar_ops", args={
        "action": "get_today",
        "confirm": True
    })])
    results = agent.run(plan, force=True)

    if results:
        status = results[0].get('status')
        print(f"Status: {status}")

        if status == 'ok':
            events = results[0].get('events', [])
            count = results[0].get('count', 0)
            message = results[0].get('message', '')
            print(f"✅ SUCCESS - {message}")

            if count > 0:
                print("\nToday's Events:")
                for i, event in enumerate(events, 1):
                    print(f"  {i}. {event.get('summary', 'No title')} at {event.get('start', 'Unknown')}")
        elif status == 'error':
            message = results[0].get('message', '')
            if 'not configured' in message.lower():
                print(f"⚠️  OAuth Not Configured: {message}")
            else:
                print(f"❌ ERROR: {message}")

except Exception as e:
    print(f"❌ Exception: {str(e)}")

# Test 3: Find free time
print("\n3. Testing: Find Free Time")
print("-" * 100)
try:
    plan = Plan(steps=[Step(tool="calendar_ops", args={
        "action": "find_free_time",
        "confirm": True
    })])
    results = agent.run(plan, force=True)

    if results:
        status = results[0].get('status')
        print(f"Status: {status}")

        if status == 'ok':
            busy_times = results[0].get('busy_times', [])
            message = results[0].get('message', '')
            print(f"✅ SUCCESS - {message}")

            if busy_times:
                print("\nBusy Time Slots (9 AM - 5 PM):")
                for i, (start, end) in enumerate(busy_times, 1):
                    print(f"  {i}. {start} to {end}")
        elif status == 'error':
            message = results[0].get('message', '')
            if 'not configured' in message.lower():
                print(f"⚠️  OAuth Not Configured: {message}")
            else:
                print(f"❌ ERROR: {message}")

except Exception as e:
    print(f"❌ Exception: {str(e)}")

# Test 4: Create event (will ask for OAuth if not configured)
print("\n4. Testing: Create Calendar Event")
print("-" * 100)
try:
    # Create event for tomorrow at 2 PM
    tomorrow = datetime.now() + timedelta(days=1)
    start_time = tomorrow.replace(hour=14, minute=0, second=0).isoformat()
    end_time = tomorrow.replace(hour=15, minute=0, second=0).isoformat()

    plan = Plan(steps=[Step(tool="calendar_ops", args={
        "action": "create_event",
        "summary": "AVA Test Event",
        "start_time": start_time,
        "end_time": end_time,
        "description": "This is a test event created by AVA",
        "location": "Virtual",
        "confirm": True
    })])
    results = agent.run(plan, force=True)

    if results:
        status = results[0].get('status')
        print(f"Status: {status}")

        if status == 'ok':
            event_id = results[0].get('event_id')
            event_link = results[0].get('event_link')
            print(f"✅ SUCCESS - Event created!")
            print(f"Event ID: {event_id}")
            print(f"Link: {event_link}")
        elif status == 'error':
            message = results[0].get('message', '')
            if 'not configured' in message.lower():
                print(f"⚠️  OAuth Not Configured: {message}")
            else:
                print(f"❌ ERROR: {message}")

except Exception as e:
    print(f"❌ Exception: {str(e)}")

# ============================================================================
# GMAIL TESTS
# ============================================================================
print("\n\n" + "=" * 100)
print("GMAIL TESTS (comm_ops)")
print("=" * 100)

# Test 1: Read unread emails
print("\n1. Testing: Read Unread Emails")
print("-" * 100)
try:
    plan = Plan(steps=[Step(tool="comm_ops", args={
        "action": "read_emails",
        "query": "is:unread",
        "max_results": 5,
        "provider": "gmail",
        "confirm": True
    })])
    results = agent.run(plan, force=True)

    if results:
        status = results[0].get('status')
        print(f"Status: {status}")

        if status == 'ok':
            emails = results[0].get('emails', [])
            count = results[0].get('count', 0)
            print(f"✅ SUCCESS - Found {count} unread emails")

            if count > 0:
                print("\nUnread Emails:")
                for i, email in enumerate(emails, 1):
                    print(f"\n  {i}. From: {email.get('from', 'Unknown')}")
                    print(f"     Subject: {email.get('subject', 'No subject')}")
                    print(f"     Date: {email.get('date', 'Unknown')}")
                    snippet = email.get('snippet', '')
                    if snippet:
                        print(f"     Preview: {snippet[:100]}...")
        elif status == 'error':
            message = results[0].get('message', '')
            if 'not configured' in message.lower() or 'oauth' in message.lower():
                print(f"⚠️  Gmail OAuth Not Configured")
                print(f"Message: {message}")
            else:
                print(f"❌ ERROR: {message}")
    else:
        print("❌ No results returned")

except Exception as e:
    print(f"❌ Exception: {str(e)}")

# Test 2: Read inbox (last 5 emails)
print("\n2. Testing: Read Inbox")
print("-" * 100)
try:
    plan = Plan(steps=[Step(tool="comm_ops", args={
        "action": "read_emails",
        "query": "in:inbox",
        "max_results": 5,
        "provider": "gmail",
        "confirm": True
    })])
    results = agent.run(plan, force=True)

    if results:
        status = results[0].get('status')
        print(f"Status: {status}")

        if status == 'ok':
            emails = results[0].get('emails', [])
            count = results[0].get('count', 0)
            print(f"✅ SUCCESS - Found {count} emails in inbox")

            if count > 0:
                print("\nRecent Inbox Emails:")
                for i, email in enumerate(emails, 1):
                    print(f"  {i}. {email.get('subject', 'No subject')} - {email.get('from', 'Unknown')}")
        elif status == 'error':
            message = results[0].get('message', '')
            if 'not configured' in message.lower() or 'oauth' in message.lower():
                print(f"⚠️  Gmail OAuth Not Configured: {message}")
            else:
                print(f"❌ ERROR: {message}")

except Exception as e:
    print(f"❌ Exception: {str(e)}")

# Test 3: Send email (test)
print("\n3. Testing: Send Email")
print("-" * 100)
print("⚠️  Skipping actual send test to avoid spam")
print("To test sending, provide your email:")
print("  - to: 'your_email@example.com'")
print("  - subject: 'AVA Test Email'")
print("  - body: 'This is a test email from AVA'")

# ============================================================================
# SUMMARY
# ============================================================================
print("\n\n" + "=" * 100)
print("GOOGLE SERVICES TEST SUMMARY")
print("=" * 100)

print("\n📊 Results:")
print("\nGoogle Calendar:")
print("  - list_events: Tested")
print("  - get_today: Tested")
print("  - find_free_time: Tested")
print("  - create_event: Tested")

print("\nGmail:")
print("  - read_emails (unread): Tested")
print("  - read_emails (inbox): Tested")
print("  - send_email: Skipped (to avoid spam)")

print("\n📝 Notes:")
print("  - If OAuth is not configured, you'll see setup instructions")
print("  - Calendar requires: ~/.cmpuse/calendar_credentials.json")
print("  - Gmail requires: ~/.cmpuse/gmail_credentials.json")
print("  - First run will open browser for authorization")

print("\n" + "=" * 100)
print("TESTING COMPLETE")
print("=" * 100)
print(f"Finished: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
