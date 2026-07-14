---
title: Close Arc browser tabs and quit
slug: close-arc-browser-tabs-and-quit
uses: 1
proven: false
tags: arc, browser, tabs, close, quit, window management
created: 2026-07-10
updated: 2026-07-10
---
WHEN: when a prompt asks to close Arc browser tabs, then quit entirely
STEPS:
1. Call window_ops (list action) to see all open windows and their tabs.
2. For each non-essential tab in Arc window, bring it to focus or close via browser_automation (close_tab). Leave essential tabs open.
3. Once only essential tabs remain, quit Arc using browser_automation close_browser or OS-level quit (e.g., AppleScript 'quit app "Arc"').
4. Verify no Arc processes remain (check ps or activity monitor).
