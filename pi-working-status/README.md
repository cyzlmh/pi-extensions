# pi-working-status

Replace pi's generic `Working` row with a **live phase line**. Everything shown is
measured from the actual event stream — never estimated:

```
waiting 4.2s                 request sent → first token (TTFT)
thinking 3.1s · 820 ch       reasoning content streaming
writing 5.4s · 2.1k ch       assistant text streaming
calling write 1.2s           tool-call arguments being generated
bash 12.3s · 1.2k out        tool executing (out = text-block chars emitted)
write 1.4s · 300 out
· quiet 6.1s                 nothing for >3s — stalls become visible
```

## Install

```bash
pi install npm:pi-working-status
```

Then `/reload` or restart pi.

## What the numbers mean

All counts are exact per-delta sums, not estimates:

| Field | Meaning |
|---|---|
| `waiting` | time since the provider request went out, until the first delta |
| `thinking` / `ch` | reasoning characters produced by this LLM call |
| `writing` / `ch` | assistant text characters produced by this LLM call |
| `calling` | tool-call arguments being streamed (shows the tool name) |
| `out` | characters the running tool has emitted (text blocks only) |
| `quiet` | seconds since the last event of any kind (shown past 3s) |

`out` counts text only. A tool that returns just images (e.g. `read` on a
screenshot) legitimately stays at `0` — that is a real value, not a hang. Use the
trailing `quiet` timer to tell the difference.

## Notes

- No commands, no config: installing the extension turns it on. To disable it,
  remove the extension (or delete the file before `/reload`).
- The timer runs at 200 ms; the row only repaints when its text actually changes.
- On `agent_settled` the row is cleared and the timer stops, so it never leaks
  into the next turn.

## Requirements

- [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) on your
  PATH (Node ≥ 22).

## License

MIT
