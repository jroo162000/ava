---
title: Check tool prerequisites from documentation
slug: check-tool-prerequisites-from-documentation
uses: 1
proven: false
tags: workflow, prerequisites, documentation, tool-diagnostics
created: 2026-07-10
updated: 2026-07-10
---
WHEN: Need to verify required imports, credentials, or dependencies for a tool before diagnosing failures
STEPS:
1. Use the available documentation or notes tool to search for the tool name
2. Search for keywords like 'prerequisites', 'imports', 'dependencies', 'credentials', 'config' combined with the tool name
3. If documentation exists, extract the listed prerequisites and note any missing/broken items
4. If no documentation found, confirm explicitly that no prerequisites documentation exists
5. Return the collected prerequisites information as the stage output
