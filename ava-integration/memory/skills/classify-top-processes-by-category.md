---
title: Classify top processes by category
slug: classify-top-processes-by-category
uses: 1
proven: false
tags: memory-pressure, process-classification, user-vs-system, troubleshooting
created: 2026-07-02
updated: 2026-07-02
---
WHEN: When investigating memory pressure and needing to distinguish user apps from system services among top RAM consumers
STEPS:
1. For each PID in the top 5 list, run: ps -p PID -o comm,pid,user (or Get-Process -Id PID | Format-List Name,Id,ProcessName on Windows)
2. Check /proc/PID/cmdline (Linux) or the command line in task manager (Windows) to see the full executable path
3. Run ls -l /proc/PID/exe (Linux) to see the binary path, which helps confirm if it's in a user directory like /usr/bin or /opt
4. Categorize: user apps include browsers (chrome, firefox), IDEs (code, idea), media players (vlc, spotify); system services include kernel threads (kworker), systemd, dbus, Xorg, sshd, or services running as root/system
5. If user info is ambiguous (e.g., running as 'user' but path under /usr/lib), check the binary name against known system packages vs user-installed snaps/flatpaks
6. Output for each PID: PID, name, RSS in MB, and category (user-app / system-service)
