---
title: Edit a 3D image using vision tools
slug: edit-a-3d-image-using-vision-tools
uses: 1
proven: false
tags: vision_ops, image editing, 3D image, edit workflow
created: 2026-07-05
updated: 2026-07-05
---
WHEN: User asks to make changes to a 3D image (or any image) by uploading an original and requesting edits
STEPS:
1. Use vision_ops with action='describe_image' to get a description of the uploaded image
2. Based on the description, ask user for specific edits or clarify what changes they want
3. If user provides edit instructions, use vision_ops with action='edit_image' and provide the edit prompt and image reference
4. Confirm the result with the user and iterate if needed
