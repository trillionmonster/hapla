---
name: media-play
description: Inspect, validate, and display local or remote images, video, and audio in Hapla. Use when a user asks to show, preview, play, open, verify, or diagnose a media URL or filesystem path, including relative paths and files under the current workspace.
---

# Media Play

Resolve local relative paths against the current working directory. Do not copy media merely to preview it.

1. Verify that the reference exists or that the remote URL is reachable. Never expose credentials while checking URLs.
2. Identify the media kind from both content type and extension. Report a likely codec mismatch when the container is recognized but playback fails.
3. Newly created or modified media is detected and displayed automatically at the end of the turn. Do not print a path or manufacture Markdown solely to make generated media appear. Save the result inside the active workspace or the current Codex generated-media directory and describe the result normally.
4. When the user asks to preview an existing media file that was not created in this turn, display one media reference on its own Markdown line. Hapla recognizes standalone media URLs and workspace paths:

   ```text
   ./artifacts/demo.mp4
   ```

   Standard Markdown image syntax is also valid for images:

   ```markdown
   ![Descriptive alternative text](./artifacts/image.png)
   ```

5. Prefer HTTPS for remote media. Explain that HTTP media may be blocked as mixed content.
6. Keep local references inside the active workspace. If a path is outside it, provide the path without claiming Hapla can load it.
7. For multiple existing items, put each reference on a separate line with a short label. Do not emit base64 data unless explicitly requested.
8. When playback fails, report the exact file, MIME/container, codec information when available, and a practical transcoding target such as H.264/AAC MP4 or Opus WebM.
