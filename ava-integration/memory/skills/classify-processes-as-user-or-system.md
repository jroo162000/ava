---
title: classify processes as user or system
slug: classify-processes-as-user-or-system
uses: 1
proven: false
tags: classification, memory, process analysis, troubleshooting
created: 2026-07-07
updated: 2026-07-07
---
WHEN: after retrieving top processes by RAM to determine which are safe to close
STEPS:
1. for each top memory consumer, note the process name, user (e.g., your username vs root/system), and executable path from `ps aux --sort -%mem` output
2. classify as user app if: user is non-root, name matches common consumer software (browser, office, media player, IDE, email client), or path is under /usr/lib or /opt (user-installed app) or /snap/flatpak
3. classify as system service if: user is root, _apt, messagebus, or system-identifiable users like daemon; name contains kernel-related terms (kworker, kswapd, irq), systemd, dbus, networkmanager, or similar infrastructure; path is under /lib/systemd, /usr/sbin, or /bin for standard daemons
4. for borderline cases (e.g., gnome-shell, Xorg), check the executable path to confirm if it's a system-level desktop component (stays) vs user-specific variant
5. produce concise list: process name, RAM usage, classification, and a simple 'safe to close' (yes/no) column
