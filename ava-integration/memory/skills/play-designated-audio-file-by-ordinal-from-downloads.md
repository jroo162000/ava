---
title: Play designated audio file by ordinal from downloads
slug: play-designated-audio-file-by-ordinal-from-downloads
uses: 1
proven: false
tags: audio, file playback, ordinal selection, media
created: 2026-07-05
updated: 2026-07-05
---
WHEN: User asks to play a specific audio file by ordinal (e.g., 'first', 'sixth') from a directory containing multiple audio files
STEPS:
1. Search the specified directory with patterns like *audio*, *<ordinal>*, *.wav, *.mp3 to locate all audio files
2. Sort the found file paths lexicographically or by filename to establish ordinal position
3. Identify the file whose position matches the requested ordinal
4. Use the play media tool to play that file
5. Report the name and position of the file being played
