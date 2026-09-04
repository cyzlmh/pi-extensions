# pi-zcode-headers

> 🎭 让 pi 伪装成官方 ZCode 客户端，让智谱后端把 pi 流量当作 ZCode 流量。
> Make pi pretend to be the official ZCode client — the Zhipu backend treats pi traffic as ZCode traffic.

当 pi 使用智谱 / Z.AI provider（`zai-coding`、`zai-coding-cn`、`api.z.ai`、`open.bigmodel.cn` 等）时，自动注入与官方 ZCode 客户端完全一致的身份 headers，让智谱后端将 pi 的流量识别为 ZCode 流量。

When pi uses a Zhipu / Z.AI provider, this extension injects the exact identity headers the official ZCode client sends, so Zhipu's backend treats pi traffic as ZCode traffic.

## 安装 / Install

```bash
pi install npm:pi-zcode-headers
```

## 工作原理 / How It Works

每次 pi 发出 LLM 请求前，扩展检查当前 provider：

- **智谱官方端点**（provider 名 `zai` / `zai-coding` / `zai-coding-cn` / `zhipu` / `bigmodel`，或 baseUrl 为 `api.z.ai` / `open.bigmodel.cn`）→ 注入完整 ZCode 身份 headers
- **其他 provider** (DeepSeek, OpenAI, etc.) → 不注入，零影响

注入的 headers 与官方 ZCode（桌面版 3.10.2 内置 agent runtime）实测抓包**逐字节一致**，覆盖 Anthropic 风格（`/api/anthropic`）与 OpenAI 风格（`/api/coding/paas/v4`）两类 coding-plan 端点：

| Header | 值 / Value |
|---|---|
| `User-Agent` | `ZCode/<版本> ai-sdk/provider-utils/<4.0.x> runtime/node.js/<主版本>` |
| `HTTP-Referer` | `https://zcode.z.ai` |
| `X-Title` | `Z Code@electron`（桌面身份）或 `Z Code@cli`（runtime 身份） |
| `X-ZCode-App-Version` | 与 User-Agent 一致的版本号 |
| `X-ZCode-Agent` | `glm` |
| `X-ZCode-Session-Type` | `main` |
| `X-Platform` | `darwin-arm64`（`platform-arch`） |
| `X-Os-Category` | `macos` / `windows` / `linux` |
| `X-Os-Version` | 系统内核版本（`os.release()`） |
| `X-Client-Language` | 系统 locale（如 `zh-CN`） |
| `X-Client-Timezone` | 系统时区（如 `Asia/Shanghai`） |
| `X-Release-Channel` | `production` |
| `X-Session-Id` | 每个 pi 会话一个持久 UUID |
| `X-Query-Id` / `X-Request-Id` / `X-ZCode-Trace-Id` | 每次请求新 UUID |

同时清除 openai SDK 的 `x-stainless-*` 指纹头（官方客户端不发这些头），确保 header 层面完全一致。

版本号解析顺序（优先级从高到低）：

1. 环境变量 `ZCODE_APP_VERSION`（官方 runtime 同名变量）
2. 本机安装的官方桌面版 ZCode（读取 `Info.plist`，此时伪装为桌面身份 `Z Code@electron`）
3. 本机安装的 `zcode` CLI（官方 runtime，此时为 `Z Code@cli` 身份）
4. 内置 fallback（随官方发版更新）

## 环境变量 / Environment Variables

| 变量 | 作用 |
|---|---|
| `ZCODE_APP_VERSION` | 覆盖上报的客户端版本 |
| `ZCODE_SOURCE_TITLE` | `electron` 或 `cli`，覆盖身份表面 |
| `ZCODE_AI_SDK_VERSION` | 覆盖 User-Agent 中 ai-sdk 版本后缀 |
| `ZCODE_ENV` | `test` 时上报 `X-Release-Channel: test` |

## License

MIT
