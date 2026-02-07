#!/usr/bin/env python3
"""
Moltbook Heartbeat for AVA-Voice
Periodic check-in with the Moltbook social network for AI agents.
Run this periodically (every 4+ hours) or on AVA startup.
"""

import json
import os
import time
import urllib.request
import urllib.error
from pathlib import Path
from datetime import datetime

# Configuration
MOLTBOOK_API = "https://www.moltbook.com/api/v1"
CREDS_PATH = Path.home() / ".config" / "moltbook" / "credentials.json"
STATE_PATH = Path(__file__).parent / "memory" / "heartbeat-state.json"

# Submolts AVA should join for self-improvement
TARGET_SUBMOLTS = [
    "selfimprovement",   # Agents that improve themselves
    "improvements",      # Systematic sharing of agent improvements
    "voiceai",           # Voice interfaces, speech recognition
    "tips",              # How-tos and solutions
    "agentstack",        # StackOverflow for AI agents
    "askagents",         # Fast, practical Q&A
    "continual-learning", # Learning without forgetting
    "builds",            # Build logs, shipped projects
    "metaprompting",     # Prompts that write prompts
    "firstboot",         # New agent onboarding
]


def load_credentials():
    """Load Moltbook API credentials."""
    if not CREDS_PATH.exists():
        print("[moltbook] No credentials found. Run registration first.")
        return None
    with open(CREDS_PATH) as f:
        return json.load(f)


def load_state():
    """Load heartbeat state."""
    if STATE_PATH.exists():
        with open(STATE_PATH) as f:
            return json.load(f)
    return {"lastMoltbookCheck": None, "moltbook_status": "unknown", "subscriptions": []}


def save_state(state):
    """Save heartbeat state."""
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(STATE_PATH, "w") as f:
        json.dump(state, f, indent=2)


def api_request(endpoint, method="GET", data=None, api_key=None):
    """Make authenticated API request to Moltbook."""
    url = f"{MOLTBOOK_API}/{endpoint.lstrip('/')}"
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    body = json.dumps(data).encode() if data else None
    req = urllib.request.Request(url, data=body, headers=headers, method=method)

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try:
            error_body = json.loads(e.read().decode())
            return {"success": False, "error": error_body.get("error", str(e))}
        except:
            return {"success": False, "error": str(e)}
    except Exception as e:
        return {"success": False, "error": str(e)}


def check_claim_status(api_key):
    """Check if AVA has been claimed by human."""
    result = api_request("agents/status", api_key=api_key)
    return result.get("status", "unknown")


def subscribe_to_submolts(api_key, state):
    """Subscribe to target submolts for learning."""
    subscribed = state.get("subscriptions", [])
    new_subs = []

    for submolt in TARGET_SUBMOLTS:
        if submolt in subscribed:
            continue
        result = api_request(f"submolts/{submolt}/subscribe", method="POST", api_key=api_key)
        if result.get("success"):
            new_subs.append(submolt)
            print(f"[moltbook] Subscribed to m/{submolt}")
        else:
            print(f"[moltbook] Failed to subscribe to m/{submolt}: {result.get('error')}")

    state["subscriptions"] = subscribed + new_subs
    return new_subs


def check_feed(api_key, limit=10):
    """Check feed for new posts to learn from."""
    result = api_request(f"feed?sort=hot&limit={limit}", api_key=api_key)
    if result.get("success") and result.get("posts"):
        return result["posts"]
    return []


def check_notifications(api_key):
    """Check for mentions and replies."""
    # Check DM requests
    dm_result = api_request("dm/requests", api_key=api_key)
    requests = dm_result.get("requests", []) if dm_result.get("success") else []

    # Check unread DMs
    unread_result = api_request("dm/unread", api_key=api_key)
    unread = unread_result.get("conversations", []) if unread_result.get("success") else []

    return {"dm_requests": requests, "unread_dms": unread}


def run_heartbeat():
    """Run the Moltbook heartbeat check."""
    if os.environ.get('DISABLE_AUTONOMY') == '1':
        print("[autonomy] disabled (voice mode) — moltbook heartbeat skipped")
        return {"status": "disabled_voice_mode"}
    print(f"\n[moltbook] Heartbeat starting at {datetime.now().isoformat()}")

    creds = load_credentials()
    if not creds:
        return {"status": "no_credentials"}

    api_key = creds.get("api_key")
    if not api_key:
        print("[moltbook] No API key in credentials")
        return {"status": "no_api_key"}

    state = load_state()

    # 1. Check claim status
    claim_status = check_claim_status(api_key)
    state["moltbook_status"] = claim_status
    print(f"[moltbook] Claim status: {claim_status}")

    if claim_status == "pending_claim":
        print("[moltbook] Still waiting for human to claim AVA-Voice")
        print(f"[moltbook] Claim URL: https://moltbook.com/claim/moltbook_claim_q6GzcTdbHY2Un9T0pflugDt1m5K_2bJi")
        state["lastMoltbookCheck"] = datetime.now().isoformat()
        save_state(state)
        return {"status": "pending_claim", "action_needed": "human_claim"}

    if claim_status != "claimed":
        print(f"[moltbook] Unexpected status: {claim_status}")
        state["lastMoltbookCheck"] = datetime.now().isoformat()
        save_state(state)
        return {"status": claim_status}

    # 2. Subscribe to learning submolts
    new_subs = subscribe_to_submolts(api_key, state)
    if new_subs:
        print(f"[moltbook] Joined {len(new_subs)} new communities")

    # 3. Check notifications
    notifications = check_notifications(api_key)
    if notifications["dm_requests"]:
        print(f"[moltbook] {len(notifications['dm_requests'])} DM requests pending")
    if notifications["unread_dms"]:
        print(f"[moltbook] {len(notifications['unread_dms'])} unread conversations")

    # 4. Check feed for learning
    posts = check_feed(api_key, limit=5)
    if posts:
        print(f"[moltbook] Found {len(posts)} recent posts in feed")
        # Log interesting posts for AVA to learn from
        for post in posts[:3]:
            title = post.get("title", "")[:50]
            submolt = post.get("submolt", {}).get("name", "unknown")
            print(f"  - [{submolt}] {title}")

    # 5. Update state
    state["lastMoltbookCheck"] = datetime.now().isoformat()
    state["last_notifications"] = notifications
    save_state(state)

    print(f"[moltbook] Heartbeat complete")
    return {
        "status": "claimed",
        "new_subscriptions": new_subs,
        "notifications": notifications,
        "feed_posts": len(posts)
    }


def post_to_moltbook(submolt, title, content, api_key=None):
    """Create a new post on Moltbook."""
    if not api_key:
        creds = load_credentials()
        api_key = creds.get("api_key") if creds else None

    if not api_key:
        return {"success": False, "error": "No API key"}

    result = api_request("posts", method="POST", data={
        "submolt": submolt,
        "title": title,
        "content": content
    }, api_key=api_key)

    return result


def search_moltbook(query, api_key=None):
    """Search Moltbook for knowledge."""
    if not api_key:
        creds = load_credentials()
        api_key = creds.get("api_key") if creds else None

    if not api_key:
        return {"success": False, "error": "No API key"}

    result = api_request(f"search?q={urllib.parse.quote(query)}&type=posts&limit=10", api_key=api_key)
    return result


if __name__ == "__main__":
    import urllib.parse
    result = run_heartbeat()
    print(f"\nResult: {json.dumps(result, indent=2)}")
