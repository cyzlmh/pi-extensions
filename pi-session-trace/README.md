# pi-session-trace

A pure-TUI session trajectory viewer for [pi](https://github.com/earendil-works/pi), inspired by DeepSeek Harness (`dsh`)'s trajectory view. One `/trace` command opens a full-screen trace of the **current** session — no server, no browser, no extra storage (pi's own session JSONL is the persistence layer).

## Install

```sh
pi install npm:pi-session-trace
```

Then `/reload` or restart pi.

## Usage

`/trace` — full-screen trajectory of the current session. Collection starts at extension load, and pi's session lifecycle (resume/fork/reload) backfills full history automatically.

**Historical sessions**: use pi's native `/resume` (or `pi --resume`) to switch to an old session — the trace backfills its complete trajectory on entry. Session selection is pi's job; this extension only does the trajectory view (same layering as dsh).

## Keys

| Key | Action |
|---|---|
| `j`/`k` / `↑`/`↓` | Move selection |
| `pgUp`/`pgDn` | Half-page jump |
| `]` / `[` | Next / previous turn header |
| `c` / `e` | Fold / expand **all** turns |
| `enter` | Inspect record (summary → full I/O) / fold on turn headers |
| `space` | Fold / unfold a turn |
| `/` | Search record contents, `n`/`N` jump between matches |
| `g` / `G` | Top / bottom (G also re-enables tail-follow) |
| `q` / `Esc` | Close (or back out of inspector) |

## What you see

- **Turn-grouped records** — user / assistant / tool / compaction, one dense line each
- **TTFT vs decode timing** on assistant rows (live mode), plus token usage
- **Timeline strip** — three lanes (user/assistant/tool) on a dsh-style idle-compressed axis: busy time tiles edge-to-edge, idle gaps are removed; TTFT/decode color split in live mode
- **Live indicators** — spinner on streaming assistant messages and running tools; tail-follow with a `↓ N new` hint when you scroll up
- **Inspector** — full message text + thinking, tool args/output, usage & cost, timing

## Design notes

- **Local-first & read-only**: never writes to or controls the session, never touches the filesystem — all data comes from pi's event bus and `sessionManager`
- **One record model** (`TrajectoryRecord`); live events stream in at a ~16 ms coalesced render tick so heavy token streams don't flicker the UI
- **Colors come 100% from pi's theme tokens** — it adapts to your theme automatically

## License

MIT
