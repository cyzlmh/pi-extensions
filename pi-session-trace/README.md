# pi-session-trace

> 🚧 Work in progress — placeholder, not yet published.

Live + replayable session trajectory for [pi](https://github.com/earendil-works/pi), inspired by DeepSeek Harness (`dsh`)'s trajectory view.

## Goals

- **Live** — dsh-style turn-grouped timeline with TTFT/decode split, streamed as the session runs
- **Replayable** — reads pi's session JSONL, so finished historical sessions open in the same view
- **Persistent** — traces survive pi restarts; nothing is memory-only

## Non-goals

- Cost/error analytics dashboards (that's `pi-trace-extension`'s territory)
- Cloud upload — local-first, read-only over session data

## Docs

- [docs/PRD.md](docs/PRD.md) — 需求文档（含体验原则）
- [docs/DESIGN.md](docs/DESIGN.md) — 技术方案
