# pi-kimi-code-headers

> 🎭 让 pi 伪装成 Kimi Code，享受和 Kimi Code 客户端一样的用量策略。
> Make pi pretend to be Kimi Code — get the same usage policy as the official Kimi Code client.

当 pi 使用 Kimi provider 时，自动注入 Kimi Code CLI 的设备身份 headers（`User-Agent: kimi-code-cli/...` + `X-Msh-*`），让 Kimi 后端将 pi 的流量识别为 Kimi Code 流量。

When pi uses a Kimi provider, this extension injects the same device-identity headers that the official kimi-code-cli sends, so the Kimi backend treats pi traffic as Kimi Code traffic.

## 安装 / Install

```bash
pi install npm:pi-kimi-code-headers
```

## 工作原理 / How It Works

每次 pi 发出 LLM 请求前，扩展检查当前 provider：

- **Kimi 官方端点** (`api.kimi.com`) → 注入完整 Kimi Code 身份 headers
- **其他 provider** (DeepSeek, OpenAI, etc.) → 不注入，零影响

Before each LLM request, the extension checks the active provider:

- **Kimi endpoints** (`api.kimi.com`) → injects full Kimi Code identity headers
- **Other providers** (DeepSeek, OpenAI, etc.) → no injection, zero impact

注入的 headers 与 Kimi Code CLI 完全一致 / Injected headers match kimi-code-cli exactly:

| Header | 说明 / Description |
|---|---|
| `User-Agent` | `kimi-code-cli/1.0.0` |
| `X-Msh-Platform` | `kimi_code_cli` |
| `X-Msh-Version` | `1.0.0` |
| `X-Msh-Device-Name` | 设备主机名 / Device hostname |
| `X-Msh-Device-Model` | 操作系统 + 架构 / OS + arch |
| `X-Msh-Os-Version` | 系统内核版本 / OS kernel version |
| `X-Msh-Device-Id` | 持久化 UUID，存于 / stored at `~/.pi/kimi-device-id` |

## License

MIT
