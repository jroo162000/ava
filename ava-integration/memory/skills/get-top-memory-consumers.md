---
title: Get top memory consumers
slug: get-top-memory-consumers
uses: 1
proven: false
tags: memory, processes, sys_ops
created: 2026-07-06
updated: 2026-07-06
---
WHEN: Need to list heavy processes by RSS quickly
STEPS:
1. Call sys_ops with operation='processes', sort_by='rss', limit=10
2. Extract PID, name, and convert KB/MB to MB for readability
