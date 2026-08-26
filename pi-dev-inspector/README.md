# pi-dev-inspector

Developer inspection tools for [pi](https://pi.dev/): peek under the hood at what pi sends to the model and how the API responds.

![/system-prompt demo](https://raw.githubusercontent.com/cyzlmh/pi-extensions/main/pi-dev-inspector/demo.gif)

## Install

```bash
pi install npm:pi-dev-inspector
```

Then `/reload` or restart pi.

## Tools

### `/system-prompt`

Print the current session's full system prompt — exactly what pi sends to the LLM. Styled for scanning: section headers are bold+highlighted, bullet markers are dimmed, XML wrappers are muted.

Press `Esc` or `q` to close.

### Model API Inspector

Every provider round-trip is rendered as an inline panel in the chat:

- **Collapsed:** one dense line — `API provider/model status latency ↑tokens ↓tokens ⚡cache% $cost time`
- **Expanded** (Ctrl+O on the panel): HTTP method + URL, status, latency, request ID, stop reason, notable headers (rate limits, retry hints), then raw request/response JSON

The inspector resets each turn so you only see calls for the current prompt. Steering/follow-up messages during streaming also reset the panel.

## Configuration

Edit `CONFIG` at the top of `model-api-inspector.ts`:

| Option | Default | Description |
|--------|---------|-------------|
| `maxCalls` | `5` | Most recent calls to show (`Infinity` = all) |
| `maxStringLen` | `50` | Truncate strings in raw JSON |
| `showRaw` | `true` | Show request/response JSON in expanded view |
| `hidePaths` | `["tools"]` | JSON paths to collapse to a placeholder |
| `headerFilter` | `/ratelimit\|rate-limit\|retry-after\|request-id/i` | Response headers to surface |

## License

MIT
