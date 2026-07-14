---
title: Navigate to a specific 'tail' after screenshot and analysis
slug: navigate-to-a-specific-tail-after-screenshot-and-analysis
uses: 1
proven: false
tags: navigation, screenshot, vision analysis, screen_ops, tail, UI navigation
created: 2026-07-05
updated: 2026-07-05
---
WHEN: When a user asks you to scan the screen and then navigate to a specific area or UI element (called a 'tail' in the transcript) after taking a screenshot and analyzing it
STEPS:
1. Take a screenshot using screen_ops with operation 'screenshot'
2. Analyze the screenshot using vision_ops with action 'analyze_screen' to identify the UI elements, layout, and usable locations
3. Based on the analysis, identify the 'tail' or target area the user is requesting to navigate to (clarify if the term 'tail' is ambiguous, e.g., ask if it means the bottom of a list, a specific section, or a navigation endpoint)
4. Use the appropriate navigation action (e.g., scroll, click, or type a command) to move to the targeted area
5. Confirm successful navigation by optionally taking another screenshot and analyzing that it matches the requested location
