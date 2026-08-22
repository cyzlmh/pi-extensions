# pi-fork-pane

Split a tmux pane and fork the current [pi](https://pi.dev/) session into it — a side-by-side copy of your conversation, ready to continue from the same context.

## Install

```bash
pi install npm:pi-fork-pane
```

Then `/reload` or restart pi.

## Usage

Inside a pi session running in tmux:

- `/fork-pane` — split vertically (default), start a forked copy of the current session in the new pane
- `/fork-pane h` — split horizontally instead

The fork is a full copy of the session file (same as `pi --fork <file>` / `/clone`): the new pane's pi starts with the complete conversation, and the two sessions diverge independently from there. Use `/tree` in the forked session to jump back to any earlier point.

The new pane inherits the current working directory, so the fork lands in the same project.

## Requirements

- pi running inside **tmux** (outside tmux the command reports an error and does nothing)
- A persisted session (an ephemeral session with no file yet cannot be forked)

## Why not pi-tmux / pi-side-agents / pi-agents-tmux?

Those packages are about *agents dispatching work* — running commands or spawning fresh child agents in tmux windows/panes. pi-fork-pane is the opposite direction: *you*, mid-conversation, splitting off a parallel copy of your own session to explore a tangent without losing your place. It composes fine with all of them.

## Notes

- When the forked pi exits, its pane closes. To keep a shell around afterwards, edit `extensions/fork-pane.ts` and append `; exec $SHELL` to the pane command.

## License

MIT
