# pi-msb-sandbox

Run agent **bash commands inside a libkrun microVM** — a sandbox extension for
[pi](https://github.com/earendil-works/pi) built on
[microsandbox](https://github.com/microsandbox/microsandbox) (libkrun/libkrunfw:
KVM on Linux, Apple Hypervisor.framework on Apple Silicon).

Every `bash` tool call is routed into a persistent, per-project Linux microVM.
The working directory is delta-synced both ways around each command, so the
`read`/`write`/`edit` tools (which stay on the host) and the sandboxed shell
see a consistent view of the project. **Fail-closed**: when enabled, the
command never falls back to host execution.

```
                 ┌──────────────────────────── host ────────────────────────────┐
 pi agent ──bash──►  mutated line: MSB_CMD=<b64> … ~/.pi/…/wrapper.sh            │
                 │      │ 1. delta sync-in  (files changed on host since last)  │
                 │      │ 2. msb exec -w /workspace  (marker + cmd + delta tar) │
                 │      ▼ 3. delta sync-out (files changed inside the VM)       │
                 │   ┌────────────── libkrun microVM ──────────────┐            │
                 │   │  /workspace ⇄ host cwd · own kernel · bash  │            │
                 │   └──────────────────────────────────────────────┘            │
                 └───────────────────────────────────────────────────────────────┘
```

## Why

pi has no built-in sandbox by design — real isolation must come from an OS or
VM boundary. Existing options are syscall-level (bwrap/sandbox-exec, e.g.
pi-sandbox) or container-level (Docker). This extension adds the
**hardware-virtualization** tier: each project gets a true microVM with its own
kernel, so kernel exploits, namespace escapes and host-fs tampering are off the
table. It fills the libkrun slot in pi's isolation story
(`Gondolin` covers QEMU; this covers libkrun).

## Install

```sh
pi install npm:pi-msb-sandbox
```

For best latency install the CLI once so the extension skips the npx fallback
(~2 s per call without it, ~40 ms with it):

```sh
npm i -g microsandbox        # or: brew install superradcompany/tap/microsandbox
```

Requires: Linux with KVM, or Apple Silicon macOS (Hypervisor.framework),
or Windows with WHP. Verify with `msb doctor`.

## Usage

Nothing to learn — the agent uses `bash` as usual and everything executes in
the VM. `!` user commands and the file tools stay on the host.

| Command | Effect |
|---|---|
| `/msb` | status: VM name, image, reachability, sync settings, binary path |
| `/msb resync` | force a full host → VM sync |
| `/msb remove` | stop & remove the VM (next bash call re-bootstraps it) |

## Configuration

Merged from `~/.pi/agent/extensions/msb.json` (global) and `<project>/.pi/msb.json`
(project takes precedence):

```jsonc
{
  "enabled": true,          // master switch; false = bash runs on host, untouched
  "image": "debian",        // any msb image: alpine, ubuntu, python, …
  "cpus": 2,
  "memory": "2G",
  "shell": "",              // "" = auto-probe bash, fall back to /bin/sh
  "keepOnExit": false,      // true = keep the VM warm across sessions
  "warmup": true,           // bootstrap at session start instead of first bash call
  "syncIn": true,           // host→VM delta sync before each command
  "syncOut": true,          // VM→host delta sync after each command
  "syncExcludes": [".git", "node_modules", "dist", "build"]
}
```

`$MSB_BIN` overrides binary auto-detection. The VM is named `pi-<hash of cwd>`
and reused across calls; it is removed when the session that created it exits
(unless `keepOnExit`).

## Security model

**Isolated** (runs only inside the VM):
- arbitrary shell commands, including model-generated or injected ones
- package installs, builds, test suites, scratch files
- kernel-level attacks against the host (separate kernel via libkrun)

**Not isolated / by design**:
- `read`/`write`/`edit`/`grep`/`find` tools still operate on the host copy
- `!` user commands run on the host (you typed them, they're trusted)
- VM network egress is unrestricted by default (see `msb` docs for policies)
- files the VM deletes are **not** deleted on the host (and vice versa)

**Fail-closed**: with the extension enabled and `msb` resolvable, the mutated
command cannot execute the payload on the host — it only invokes the wrapper,
which `base64`-passes the payload into the VM via `msb exec -e`. If the VM is
down, the wrapper exits `125` with a diagnostic instead of running locally.

## How it composes

Interception uses `tool_call` input mutation (like pi-sandbox), not a bash tool
override — so it stacks cleanly on **pi-bg-tasks**: backgrounded commands run
the whole wrapper in the background and sync back when they finish.

## Limitations (v0.1)

- Deletions don't propagate in either direction.
- The first bootstrap in a project pays image download + full sync (up to a
  minute); subsequent calls pay two small `msb` round-trips (~0.5–1 s total).
- Concurrent bash calls in one project share one VM (per-call markers keep
  syncs from clobbering each other, but a huge `npm install` in one call may
  sync a lot back).
- `~` and other host paths outside the project cwd don't exist in the VM.

## Feedback

Open an issue with `[pi-msb-sandbox]` in the title at
[cyzlmh/pi-extensions](https://github.com/cyzlmh/pi-extensions).

## License

MIT
