# pi-extensions

My collection of extensions for [pi](https://github.com/earendil-works/pi), the coding agent CLI. Each top-level directory is an independently published npm package.

| Package | npm | Description |
|---|---|---|
| [`pi-bg-tasks`](pi-bg-tasks/) | [![npm](https://img.shields.io/npm/v/pi-bg-tasks)](https://www.npmjs.com/package/pi-bg-tasks) | Lightweight background bash tasks — `run_in_background`, auto-background at timeout, Ctrl+Shift+B, completion notifications |
| [`pi-boundary-boost`](pi-boundary-boost/) | [![npm](https://img.shields.io/npm/v/pi-boundary-boost)](https://www.npmjs.com/package/pi-boundary-boost) | Rank direct directory children first in `@` file completion, so deep fuzzy matches never crowd out the obvious hit |
| [`pi-dev-inspector`](pi-dev-inspector/) | [![npm](https://img.shields.io/npm/v/pi-dev-inspector)](https://www.npmjs.com/package/pi-dev-inspector) | Developer inspection tools — view the full system prompt and inspect API request/response round-trips |
| [`pi-fork-pane`](pi-fork-pane/) | [![npm](https://img.shields.io/npm/v/pi-fork-pane)](https://www.npmjs.com/package/pi-fork-pane) | Split a tmux pane and fork the current pi session into it |
| [`pi-kimi-code-headers`](pi-kimi-code-headers/) | [![npm](https://img.shields.io/npm/v/pi-kimi-code-headers)](https://www.npmjs.com/package/pi-kimi-code-headers) | Injects device-identity headers so the Kimi backend treats pi traffic as Kimi Code traffic |
| [`pi-provider-status`](pi-provider-status/) | [![npm](https://img.shields.io/npm/v/pi-provider-status)](https://www.npmjs.com/package/pi-provider-status) | `/status` panel showing remaining quota / balance for your configured providers — Kimi Coding, Zhipu ZAI, MiniMax, DeepSeek, OpenRouter, Claude & Codex subscription windows |
| [`pi-session-trace`](pi-session-trace/) | [![npm](https://img.shields.io/npm/v/pi-session-trace)](https://www.npmjs.com/package/pi-session-trace) | Pure-TUI session trajectory viewer — full-screen dsh-style live trace of the current session (TTFT/decode timeline, idle-compressed lanes); no server or browser |

## Install

```sh
pi install npm:<package-name>
```

## Releasing

Push to `main` publishes automatically ([workflow](.github/workflows/publish.yml)):
bump `version` in the package's `package.json`, merge to `main` — any package
whose version isn't on npm yet gets published. No tags, no manual steps.

One-time setup: configure npm **Trusted Publishing** for each package, bound
to GitHub Actions workflow `publish.yml` in `cyzlmh/pi-extensions`. It uses
OIDC short-lived credentials — no `NPM_TOKEN` secret or OTP in CI.

## Feedback

Open an issue with the package name in the title (e.g. `[pi-bg-tasks] …`).

## License

MIT — see each package's directory. `pi-bg-tasks` is a fork of [pi-patty-bg-tasks](https://github.com/patty-io/pi-patty-bg-tasks) (© patty.io) and carries its copyright alongside mine.
