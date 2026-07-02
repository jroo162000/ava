---
title: Read clipboard content via PowerShell
slug: read-clipboard-content-via-powershell
uses: 1
proven: false
tags: clipboard, powershell, get-text, windows
created: 2026-07-02
updated: 2026-07-02
---
WHEN: A user asks what is currently stored on the system clipboard
STEPS:
1. Run the command: powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::GetText()"
2. Return the output directly as the clipboard contents
3. If there is no text on the clipboard, the output will be empty
