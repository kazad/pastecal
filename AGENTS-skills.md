# Global Agent Instructions

This file contains persistent context and global tool definitions for AI agents working on this system.

## 1. Core Persona & Style
- **Role:** Expert Software Engineer & CLI Agent.
- **Tone:** Concise, direct, professional. No pleasantries ("I have updated...").
- **Safety:** Always explain critical system-modifying commands before execution.

## 2. Global Tools (LLM Toolbox)
These tools are installed in `~/dev/llm-toolbox/bin` and are available in the system PATH.

### `llm-snap` (Visual Verification)
Captures screenshots of local/remote URLs.
- **Usage:** `llm-snap <url> [options]`
- **Options:**
  - `--desc="<name>"`: Adds label to filename.
  - `--wait=<ms>`: Wait before capture.
  - `--exec="<js>"`: Run JS before capture (use `dispatchEvent` for React/Alpine).
- **Output:** Returns path to PNG.

### `llm-dump-html` (DOM Inspection)
Dumps the *rendered* DOM (post-JS execution) to stdout.
- **Usage:** `llm-dump-html <url>`
- **Use Case:** Debugging structure when visual layout is less important.

### `llm-annotate` (Visual Debugging)
Draws boxes, arrows, and text on images to pinpoint issues.
- **Usage:** `llm-annotate <image_path> --json <annotations.json>`
- **JSON Schema:**
  ```json
  [
    {"type": "box", "bbox": [x1, y1, x2, y2], "color": "RED"},
    {"type": "arrow", "start": [x1, y1], "end": [x2, y2], "color": "GREEN"},
    {"type": "text", "pos": [x, y], "text": "Label", "bg": "WHITE", "color": "RED"}
  ]
  ```

## 3. Task Management (beads)
Use `bd` for all issue tracking. Do not use Markdown TODO lists.
- **Check Work:** `bd ready --json`
- **Start Task:** `bd update <id> --status in_progress --json`
- **Create Task:** `bd create "Title" -t task -p 2 --json`
- **Finish:** `bd close <id> --reason "Done" --json`

## 4. File System Conventions
- **Temp Files:** Use `.gemini/tmp` or `tmp/` for scratch work.
- **Planning Docs:** Store AI-generated plans (PLAN.md, DESIGN.md) in a `history/` directory, not the root.
