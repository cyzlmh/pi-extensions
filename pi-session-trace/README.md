# pi-session-trace

A pure-TUI session trajectory viewer for [pi](https://github.com/earendil-works/pi), inspired by DeepSeek Harness (`dsh`)'s trajectory view. One `/trace` command opens a full-screen trace of the **current** session — no server, no browser, no extra storage (pi's own session JSONL is the persistence layer).

## Install

```sh
pi install npm:pi-session-trace
```

Then `/reload` or restart pi.

## Usage

`/trace` — full-screen trajectory of the current session. Collection starts at extension load. On `session_start` (startup/resume/fork/reload), the extension backfills **only Pi's current root-to-leaf branch** via `sessionManager.getBranch()`; alternate branches are not mixed into the default trace.

**Historical sessions**: use Pi's native `/resume` (or `pi --resume`) to switch to an old session — `session_start` backfills that selected branch. Session selection and branch navigation remain Pi's job; this extension only renders the read-only trajectory (same layering as dsh).

## Keys

| Key | Action |
|---|---|
| `j`/`k` / `↑`/`↓` | Move the trace selection or scroll the inspector |
| `pgUp`/`pgDn` | Move / scroll by one page in either view |
| `Ctrl-u`/`Ctrl-d` | Move / scroll by a half page in either view |
| `g` / `G` | Top / bottom in either view (`G` also re-enables trace tail-follow) |
| `]` / `[` | Next / previous turn header (trace only) |
| `c` / `e` | Fold / expand **all** turns (trace only) |
| `enter` | Inspect a record; fold / unfold a turn header |
| `space` | Fold / unfold the selected record's turn; never opens an inspector |
| `x` (in inspector) | Expand / collapse truncated textual fields |
| `r` (in inspector) | Show / hide sanitized raw source JSON |
| `/` | Search trace record contents; `n`/`N` jump between matches |
| `q` / `Esc` | Close trace, or go back from inspector |

## Mouse (fullscreen mode)

Pi's fullscreen TUI mode routes normalized pointer events to the overlay; regular mode never sends mouse input (the terminal owns its scrollback), so these simply don't fire there.

| Input | Action |
|---|---|
| Wheel | Scroll the trace list or the inspector freely — the view drifts off the selection until the next keyboard/click navigation re-anchors it |
| Wheel back to the bottom | Re-arms tail-following (same contract as `G`) |
| Click | Select the clicked row |
| Double-click | Inspect the record / toggle the turn (same as `enter`) |

## What you see

- **Turn-grouped records** — user / assistant / tool / compaction, one dense line each
- **Provider/model/stop metadata and complete persisted usage/cost breakdowns** in the inspector
- **Live-only TTFT vs decode timing** on assistant rows when observed live; history never invents these metrics
- **Timeline strip** — four lanes (user/assistant/tool/event) on a dsh-style idle-compressed axis. The event lane shows compaction and session markers (model/thinking/branch/bash/custom/unknown); `+` means multiple events share one time bucket. Historical assistant spans are explicitly estimated persisted-entry windows, while the TTFT/decode color split is live-only
- **Live indicators** — spinner on streaming assistant messages and running tools; tail-follow with a `↓ N new` hint when you scroll up
- **Structured inspector** — an overview followed by clearly separated model/timing/usage/content/tool-result sections; `r` reveals sanitized raw source JSON when needed

## Data semantics and privacy

- **Local-first & read-only**: never writes to or controls the session, never touches the filesystem — all data comes from Pi's event bus and readonly `sessionManager`. It does not call `appendEntry`, `sendMessage`, or `sendUserMessage`.
- **What history can restore**: Pi session JSONL stores final provider-neutral semantic messages and entries. The trace preserves their content-block order, message/entry timestamps, assistant `api`/provider/model/response metadata, stop/error/diagnostics, full known usage and cost fields, tool calls, and tool results.
- **What history cannot restore**: raw HTTP request/response payloads, SSE chunks, retry attempts, transport timings, precise TTFT, and decode time are not persisted by Pi and are never fabricated. TTFT/decode labels are explicitly **live-only**. Historical views show message-start (`message.timestamp`) and entry-persistence time, plus (when useful) an **estimated persisted-entry window**, never a reconstructed timing metric.
- **Inspector exposure controls**: image base64 and thinking/text signatures are never rendered. Long text, thinking, tool output, details, and raw JSON are truncated by default; press `x` to expand textual content. Expansion still keeps image/base64 and signatures redacted.
- **One record model** (`TrajectoryRecord`); live events stream in at a ~16 ms coalesced render tick so heavy token streams don't flicker the UI.
- **Colors come 100% from Pi's theme tokens** — it adapts to your theme automatically.

## License

MIT
