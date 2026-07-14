---
title: Classify top memory processes as user vs system-critical
slug: classify-top-memory-processes-as-user-vs-system-critical
uses: 1
proven: false
tags: memory, process classification, performance tuning, system administration
created: 2026-07-05
updated: 2026-07-05
---
WHEN: analyzing memory pressure after listing top processes by RAM
STEPS:
1. For each process in the top memory list, identify if it is an ordinary user app (e.g., firefox, chromium, chrome, vlc, spotify, slack) or system-critical (e.g., systemd, kernel_task, launchd, pid, swapper, WindowServer, coreaudiod, mds, mds_stores, syslogd, sshd, cron, kworker, jbd2, rcu_sched, ntpd, cupsd, accountsd, cfprefsd, securityd, notifyd, configd, powerd, bluetoothd, wifid, thermald, logd, com.apple.*, dyld, opendirectoryd, fseventsd, mdsync, syspolicyd, amfid, sandboxd, xpcproxy, watchdogd, kernel_task).
2. If unsure, inspect /proc/[pid]/exe or read /proc/[pid]/cmdline using 'cat /proc/[pid]/cmdline' or 'readlink /proc/[pid]/exe' for Linux, or 'lsof -p [pid]' for macOS to see the executable path.
3. Classify processes with paths under /usr/share, /System/Library, /usr/libexec, or /usr/sbin as system-critical unless they are known user apps (e.g., /Applications).
4. If a process name is ambiguous but uses little memory (e.g., < 50 MB), assume it is system-critical to be safe.
5. Document each process's name, memory size (from previous step), a classification (User / System), and a recommendation (Keep or Close if User app).
