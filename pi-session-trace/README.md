# pi-session-trace

A pure-TUI session trajectory viewer for [pi](https://github.com/earendil-works/pi), inspired by DeepSeek Harness (`dsh`)'s trajectory view. One `/trace` command — live tail of the current session, or replay of any historical session — with no server, no browser, and no extra storage (pi's own session JSONL is the persistence layer).

## Install

```sh
pi install npm:pi-session-trace
```

Then `/reload` or restart pi.

## Usage

| Command | What it does |
|---|---|
| `/trace` | Live view of the **current** session (collects from extension load; resume/fork/reload backfill full history) |
| `/trace pick` | Session picker — fuzzy-filter all historical sessions, enter to open |
| `/trace <id-prefix>` | Replay one historical session directly |

## Keys

| Key | Action |
|---|---|
| `j`/`k` / `↑`/`↓` | Move selection |
| `enter` | Inspect record (summary → full I/O) / fold on turn headers |
| `space` | Fold / unfold a turn |
| `/` | Search record contents, `n`/`N` jump between matches |
| `+` / `-` / `0` | Zoom timeline in (around selection) / out / reset |
| `x` | Toggle timeline axis: idle-compressed (dsh-style, default) ⇄ wall-clock |
| `g` / `G` | Top / bottom (G also re-enables tail-follow) |
| `q` / `Esc` | Close (or back out of inspector) |

## What you see

- **Turn-grouped records** — user / assistant / tool / compaction, one dense line each
- **TTFT vs decode timing** on assistant rows (live mode), plus token usage
- **Timeline strip** — three lanes (user/assistant/tool), dsh-style idle-compressed axis (busy time tiles edge-to-edge; press `x` for wall-clock), TTFT/decode color split in live mode
- **Live indicators** — spinner on streaming assistant messages and running tools; tail-follow with a `↓ N new` hint when you scroll up
- **Inspector** — full message text + thinking, tool args/output, usage & cost, timing

## Design notes

- **Local-first & read-only**: never writes to or controls the session; replays read `~/.pi/agent/sessions/` directly
- **Live + replay share one record model** (`TrajectoryRecord`); live events stream in at a ~16 ms coalesced render tick so heavy token streams don't flicker the UI
- **Colors come 100% from pi's theme tokens** — it adapts to your theme automatically

## License

MIT
