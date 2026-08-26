# pi-bg-tasks

Lightweight background bash tasks for [pi](https://github.com/earendil-works/pi). One focused job: run shell commands in the background and tell the agent when they finish — no PTY sessions, no sub-agents, no watchers.

> Forked from [pi-patty-bg-tasks](https://github.com/patty-io/pi-patty-bg-tasks) (MIT), simplified to a zero-dependency core (~1.7k lines vs ~6.9k) with a rewritten UI and task-tool layer. If you want monitors, streaming jobs, or `agent_bg`, use the original — it's a superset of this package.

![demo](https://raw.githubusercontent.com/cyzlmh/pi-extensions/main/pi-bg-tasks/demo.gif)

## Install

```sh
pi install npm:pi-bg-tasks
```

## Features

- **`bash` override with `run_in_background`**: start a command in the background immediately, or let a long-running foreground command auto-background after the timeout (default 120s)
- **Completion notifications**: when a background task finishes, a `<task-notification>` is steered into the agent loop (exactly once) with status, exit code, and an output tail preview
- **Manual backgrounding**: `Ctrl+Shift+B` or `/bg` moves a running foreground command to the background
- **Steer to background**: sending a steering message (Enter) while a foreground command runs moves it to the background immediately — the command keeps running and the message is delivered at once, instead of being stuck behind the command
- **Graceful stop**: every stop path is SIGTERM → 5s grace → SIGKILL
- **Output cap**: a task whose log grows past 64 MiB is killed automatically
- **Live hint**: foreground commands running past 2s show `(ctrl+shift+b to run in background)` below the editor, plus a status-bar pill with separate running/completed/failed counts (`▶ 2 · ✓ 3 · ✗ 1`)

## Tools

- `bash` (override) — adds `run_in_background: true` to start detached immediately; foreground commands race a 2s quick-completion window, then auto-background at the timeout
- `bg_list` — list running tasks and recently finished ones
- `bg_output` (task_id) — task meta info + last 32 KiB of output + log path (use Read to page the full log)
- `bg_stop` (task_id, reason?) — SIGTERM → 5s grace → SIGKILL; returns the final status

## Commands & Shortcuts

- `Ctrl+Shift+B` — background the current foreground process (Ctrl+B is pi's built-in cursor-left and stays untouched)
- **Enter mid-stream** — a steering message auto-backgrounds any running foreground command so the message is delivered immediately (Alt+Enter follow-ups do not)
- `/bg` — same as Ctrl+Shift+B
- `/bg-tasks` — show the task list as a notification

## How It Works

- Spawns write stdout+stderr **directly to a file descriptor** (`/tmp/pi-bg-tasks/<taskId>.log`) — the kernel moves the bytes, zero JS in the data path; progress is read back by polling the file tail
- Children are **detached into their own process group**, so stops signal the whole tree (negative PID); the spawn listens to `exit` (not `close`) so daemonized grandchildren can't hang the handle, and every handle/timer is `unref`'d
- The turn's AbortSignal is **managed manually**: a genuine cancel (Esc) kills the process group, but backgrounding (Ctrl+Shift+B / steering / timeout) lets the process keep running while the tool returns — no `ctx.abort()`, so queued messages are never lost
- The prompt guidance teaches the model to **not** block the turn waiting on background tasks: after `run_in_background=true` it should continue working and rely on the automatic completion notification (every backgrounded result carries a `next_step` no-polling hint); long foreground polling loops are discouraged, with short bounded polls as the escape hatch
- The registry is **purely in-memory** (max 16 concurrent tasks; last 20 finished kept for `bg_list`). `session_start` sweeps logs older than 24h; `session_shutdown` silently kills everything still running
- Notifications are **exactly-once** via a `notified` latch: reading a finished task with `bg_output`/`bg_stop` or stopping it suppresses the notification

## Compatibility

Tested with pi `0.84.x`. The bash override builds on pi's exported `createBashToolDefinition`, so it inherits pi's native call/result rendering.

## Development

Tests (node:test, no framework), run from `extensions/bg-tasks/`:

```sh
node --experimental-strip-types --test 'test/*.test.ts'
```

The core modules (types/spawn/output/registry/lifecycle/notify) have zero external dependencies. The tool layer and `index.ts` import `typebox` / `@earendil-works/pi-coding-agent`, which pi resolves for extensions at runtime; to run the smoke test outside pi, symlink those packages from your global pi install into `node_modules/`.

## License

MIT — © patty.io (original), © cyzlmh (this fork). See [LICENSE](LICENSE).
