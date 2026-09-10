# pi-session-bookmark

Browser-style bookmarks for [pi](https://pi.dev/) sessions: keep a short list of
the sessions you actually want again, and jump back into one from any project.

## Install

```bash
pi install npm:pi-session-bookmark
```

Then `/reload` or restart pi.

## Usage

- `/bookmark-add [name]` — bookmark the current session under a name. The name
  is optional: without one it falls back to the session's display name, then to
  a preview of the first user message. Re-adding updates the name in place.
- `/bookmarks [query]` — open the bookmark picker. Enter resumes the selected
  session and switches to its working directory. An optional query filters by
  name, preview, or path.
- `/bookmark-remove` — remove the current session's bookmark. Silent no-op if
  the session isn't bookmarked (idempotent, like `rm`).

## How it works

- Bookmarks are **global** — one list across all projects and working
  directories.
- Stored in `~/.pi/agent/session-bookmarks.json` (honors
  `PI_CODING_AGENT_DIR`). Session files themselves are never modified.
- Rows show `name · directory · date`; entries whose session file no longer
  exists are marked `[missing]` and can be removed from the picker.
- Selecting the session you're already in reports "Already in this session"
  instead of switching.

## Requirements

- [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) on your
  PATH (Node ≥ 22).

## License

MIT
