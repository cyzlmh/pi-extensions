# pi-provider-status

`/status` — a live panel in [pi](https://github.com/earendil-works/pi) showing **remaining quota / balance** for every provider you have configured, with usage bars and reset timelines.

![/status demo](https://raw.githubusercontent.com/cyzlmh/pi-extensions/main/pi-provider-status/demo.gif)

```
● Kimi Coding (kimi-coding) (0.8s)
  Week       ██████░░░░░░░░░░  43% used   resets 8-25 00:00
             ─────────●─────  3d 4h to reset (8-25 00:00)
  5h window  ██░░░░░░░░░░░░░░  12% used

● Deepseek (0.3s)
  Balance CNY  128.40
```

The panel opens immediately; each section fills in as its request settles. Press `r` to refresh, `Esc`/`q` to close. In non-interactive mode the report is printed as a plain notification instead.

## Install

```sh
pi install npm:pi-provider-status
```

No configuration needed — a provider is reported **only when you already have an API key configured for it** in pi. Anything else never appears.

## Supported sources

**API-key providers** (key resolved from pi's model registry):

| Provider id | What's shown |
|---|---|
| `kimi-coding` | Membership, weekly quota, 5h window |
| `zai-coding-cn` (Zhipu ZAI Coding Plan) | Membership, weekly quota, 5h window, MCP monthly |
| `minimax-cn` | Per-model interval + weekly windows |
| `deepseek` | Balance per currency |
| `openrouter-free` | Credit balance + monthly usage |

**OAuth accounts** (discovered automatically):

- **Claude account** — reads Claude Code's own credentials (macOS Keychain, or `~/.claude/.credentials.json`). **Strictly read-only**: an expired token is reported as an error, never refreshed — re-login with the `claude` CLI to renew.
- **Codex account** — uses pi's own ChatGPT login (`/login` → ChatGPT Codex), so pi handles token refresh. Shows plan type, weekly/5h windows, credits, spend control.
- **Kimi cli account** — reads the official kimi-code CLI's OAuth credentials (`~/.kimi-code`). When the token is close to expiry it is refreshed through the CLI's own OAuth flow and the rotated pair is written back (exactly what the CLI itself does).

**Multiple API keys for one provider** (e.g. several Kimi accounts): point `KIMI_SWITCH_STORE` at a directory of `<name>.auth.json` files (`{"key": "sk-..."}`) and each becomes its own "Kimi slot" section; the slot matching the live registry key is marked `(active)`.

## Privacy & safety

- All requests go only to the respective provider's official status endpoint, authenticated with your own key/token.
- No telemetry, no third-party calls, no data leaves your machine except the status queries themselves.
- Writes happen in exactly one place: rotating the kimi-code CLI's OAuth token (as documented above). Claude tokens are never written.

## Compatibility

Tested with pi `0.84.x` on macOS and Linux. Provider status endpoints are undocumented and can change without notice — if a section starts erroring after a provider update, please open an issue.

## License

MIT — © cyzlmh. See [LICENSE](LICENSE).
