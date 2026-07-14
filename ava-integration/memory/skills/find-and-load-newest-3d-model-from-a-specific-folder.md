---
title: Find and load newest 3D model from a specific folder
slug: find-and-load-newest-3d-model-from-a-specific-folder
uses: 1
proven: false
tags: 3d-model, hologram, file-management, scene3d, glb
created: 2026-07-03
updated: 2026-07-03
---
WHEN: Given a folder path and a request to open the newest 3D hologram/holographic model
STEPS:
1. Search the target folder for 3D model files using fs_find with pattern '*.glb'
2. From the results, identify the newest file by sorting the file list by creation or modification date
3. Use scene3d tool with args: name set to a descriptive identifier, models array with path to the newest .glb file
4. Verify the model loaded correctly on the 3D panel
