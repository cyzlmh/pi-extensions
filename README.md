# pi-extensions

My collection of extensions for [pi](https://github.com/earendil-works/pi), the coding agent CLI. Each top-level directory is an independently published npm package.

| Package | npm | Description |
|---|---|---|
| [`pi-bg-tasks`](pi-bg-tasks/) | [![npm](https://img.shields.io/npm/v/pi-bg-tasks)](https://www.npmjs.com/package/pi-bg-tasks) | Lightweight background bash tasks — `run_in_background`, auto-background at timeout, Ctrl+Shift+B, completion notifications |
| [`pi-devtools`](pi-devtools/) | [![npm](https://img.shields.io/npm/v/pi-devtools)](https://www.npmjs.com/package/pi-devtools) | Developer tools for pi |
| [`pi-fork-pane`](pi-fork-pane/) | [![npm](https://img.shields.io/npm/v/pi-fork-pane)](https://www.npmjs.com/package/pi-fork-pane) | Split a tmux pane and fork the current pi session into it |
| [`pi-kimi-code-headers`](pi-kimi-code-headers/) | [![npm](https://img.shields.io/npm/v/pi-kimi-code-headers)](https://www.npmjs.com/package/pi-kimi-code-headers) | Injects device-identity headers so the Kimi backend treats pi traffic as Kimi Code traffic |

## Install

```sh
pi install npm:<package-name>
```

## Feedback

Open an issue with the package name in the title (e.g. `[pi-bg-tasks] …`).

## License

MIT — see each package's directory. `pi-bg-tasks` is a fork of [pi-patty-bg-tasks](https://github.com/patty-io/pi-patty-bg-tasks) (© patty.io) and carries its copyright alongside mine.
