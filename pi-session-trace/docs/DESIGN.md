# pi-session-trace — 技术方案

对应 [PRD](./PRD.md)。原则：**体验优先**，所有架构决策以服务 PRD 第 5 节的体验原则为准。

## 1. 总体架构

```
┌─────────────────────────────────────────────────────┐
│ 数据源层（同一只读来源）                               │
│                                                     │
│  LiveSource                                         │
│  pi 生命周期事件订阅 + sessionManager.getBranch()     │
│  (当前会话实时；/resume 后重填当前 root→leaf branch)   │
└──────────────┬──────────────────────────────────────┘
               │ 产出统一的 TrajectoryRecord 流
               ▼
┌─────────────────────────────────────────────────────┐
│ Store                                               │
│  有序记录列表 + turn 索引 + 增量更新通知               │
│  (replay: 一次性灌入; live: 事件驱动增量)              │
└──────────────┬──────────────────────────────────────┘
               ▼
┌─────────────────────────────────────────────────────┐
│ TUI 层（pi overlay, 无 server 无浏览器）               │
│  TraceOverlay                                       │
│   ├─ TimelineStrip   TTFT/decode 分色时间轴          │
│   ├─ RecordList      窗口化记录列表（主视图）          │
│   ├─ Inspector       选中记录详情（分层钻取）          │
│   └─ SessionPicker   历史会话选择器（独立浮层）        │
└─────────────────────────────────────────────────────┘
```

关键决策：**持久化不写自己的存储，也不直接读写 session JSONL**。Pi 的 session JSONL 是语义消息持久层；本扩展仅通过公开、只读的 `sessionManager.getBranch()` 与生命周期事件重建选中分支。`/resume`/branch 切换仍完全由 Pi 负责。

## 2. 数据模型

统一的记录模型，两种数据源都归一化到它：

```typescript
type TrajectoryRecord =
  | UserRecord        { ts, content, images? }
  | AssistantRecord   { ts, content, usage, model, stopReason,
                        timing?: { ttftMs, decodeMs } }  // timing 仅 live 有
  | ToolRecord        { ts, name, argsPreview, status: running|ok|error|interrupted,
                        durationMs?, output }
  | CompactionRecord  { ts, summary, tokensBefore }
  | MarkerRecord      { ts, kind: model_change|thinking_change|branch|interrupted, detail }
  | TurnBoundary      { turnIndex, ts }
```

- **live**：`timing.ttftMs = message_start → 首个 message_update`，`decodeMs = 首个 update → message_end`；二者标为 **live-only**。
- **history**：Pi JSONL 保存最终 provider-neutral 语义消息，而非 HTTP/SSE 过程。记录保留 `message.timestamp`、`entry.timestamp`、完整 usage/成本、provider/model/response metadata、content blocks、tool result details 等；相邻 entry 仅可画成灰色的“估算持久化窗口”，绝不标为 TTFT/decode。

## 3. 数据源

### LiveSource

订阅 Pi 扩展事件：

| pi 事件 | 用途 |
|---|---|
| `session_start` | 清空旧会话状态，并用 `sessionManager.getBranch()` 回填当前 root→leaf path；绝不使用 `getEntries()` 将其他 branch 混入默认 trace |
| `turn_start` / `turn_end` | turn 分组与边界 |
| `message_start` / `message_update` / `message_end` | assistant/user 记录，TTFT/decode 计时 |
| `tool_execution_start` / `_update` / `_end` | tool 记录状态机 running→ok/error |
| `session_compact` | compaction 记录 |

### 历史回填

不实现私有 `ReplaySource`、文件扫描或 session picker。用户先用 Pi 原生 `/resume` 选择会话，随后 `session_start` 从 readonly `sessionManager.getBranch()` 回填当前 path。

- 首选公开 `getBranch()`；旧宿主若缺少该方法，只有在可由 `getEntries()` + `getLeafId()` 安全重建唯一 parent chain 时才回填。无法证明 branch 时宁可不回填，绝不展示全部 entries。
- 转换器覆盖已知 entry/message 并保留 raw entry reference；未知、label、session_info 或未来 entry 降级为可检查的 generic marker/raw JSON，而不静默丢弃。

## 4. TUI 设计

### 布局

```
┌─ trace · 当前会话 · live ──────────────────────────── q ─┐
│ ▼ turn 3 · 14:04:21 · claude-sonnet · 2.1k tok           │
│   ● user      "帮我重构 collector 的..."          14:04  │
│   ● assistant ▓▓░░ TTFT 1.2s · 3.4s · 812 tok            │
│   ⚙ read      src/index.ts ✓ 0.1s                        │
│   ⚙ bash      npm run build ✓ 6.2s                       │
│   ● assistant "构建成功，问题在..."                       │
│ ▶ turn 4 ─ 折叠 · 5 records ────────────────             │
│ ▼ turn 5 · 进行中 ●●●                                    │
│   ● user      "顺便把测试也..."                          │
│   ● assistant ▓▓▓▓▓▓░░░░ streaming…                     │
│ ──────────────────────────────────────────────────────── │
│ timeline ▐██░░███░░░░████▌ 14:00—14:12   ↑↓ 选择 · enter 详情 · / 搜索 │
└──────────────────────────────────────────────────────────┘
```

- overlay 浮层：`width: "92%"`, `maxHeight: "88%"`，anchor center
- 记录行**严格一行**（E4）：图标 + 类型 + 摘要 + 右侧时间/耗时，超出截断
- 底部常驻时间轴条 + 键位提示行

### Inspector（enter 逐层钻取）

1. 结构化摘要（entry id、来源、message/entry 时间、provider/model/response、usage/成本、stop/error）
2. 保持原顺序的 content blocks（text/thinking/image/toolCall）及完整工具参数、namespace、tool-result details/usage/added tools
3. 经脱敏的 raw session entry/live event JSON；未知 entry 也走此通用 inspector
- 默认先显示分段的 Overview / model / timing / usage / content / tool-result；raw source JSON 默认隐藏，`r` 才显示
- 长文本、thinking、输出、details 和 raw JSON 默认截断，`x` 展开文字；图片 base64 与 thinking/text/thought signatures 始终不显示
- Esc 返回

### SessionPicker（`/trace` 无参且非 live 场景 / `/trace pick`）

- 项目分组（cwd 最后一级）、时间倒序、首条 user 消息预览
- 输入即模糊过滤；enter 打开

### 键位

| 键 | 动作 |
|---|---|
| j/k / ↑↓ | trace 中移动选择；inspector 中滚动 |
| pgUp / pgDn | 两个视图都按半页移动/滚动 |
| enter | 进入 record inspector；turn header 上展开/折叠 |
| space | 展开/折叠所选记录所属的 turn，绝不打开 inspector |
| x（inspector） | 展开/收起默认截断的文字内容 |
| r（inspector） | 显示/隐藏脱敏 raw source JSON |
| g / G | 两个视图都跳至顶部/底部（trace 的 G 同时恢复尾部跟随） |
| / | 搜索 trace 记录；n/N 跳转命中 |
| t | 光标定位到时间轴条，←→ 缩放，移动焦点区间 |
| q / Esc | trace 中关闭；inspector 内返回上一层 |

### 渲染性能（E1/FR-11 的实现手段）

- **帧合并**：事件进 Store 后不直接重绘，合入 ~16ms 的渲染 tick 批量 `requestRender()`——token 流高峰时 UI 稳定（dsh 原版同款策略："coalesced to once per animation frame"）
- **窗口化**：RecordList 只渲染可视区 ± 5 行 overscan；长文本内容不进入列表渲染路径
- **泳道与折叠解耦**：时间轴投射“首个可见 record 到末个可见 record 的连续索引区间”（折叠 turn 的 header 会经 turnRange 扩展窗口），折叠/展开不引起泳道重排（dsh 同款行为）；turn 边界用 scrollbarThumb 背景竖带贯穿三道 + 轴上 ┬ 刻度
- **增量**：live 追加只 invalidate 尾部；折叠 turn 的内容完全不渲染
- **预算**：单帧 render() <8ms；1000+ entry 会话打开 <1s（边解析边显示，不全量等）

## 5. 主题与视觉

- 所有颜色取 pi theme token（success/warning/error/muted/accent），**零硬编码色值**（E5）
- 角色图标与 pi 自身消息渲染对齐；in-flight 用主题色动画字符（`●●●`/`⠋⠙⠹`）
- 窄终端（<80 列）降级：隐藏时间轴条，摘要进一步截断

## 6. 状态与边界（E6 清单）

| 状态 | 展示 |
|---|---|
| 空会话 | 居中插画行："还没有记录，去和 pi 说点什么" |
| JSONL 解析失败行 | 跳过并计数，底部提示 "跳过 N 行损坏记录" |
| 中断的记录 | 专属 interrupted 样式（dsh 有同款概念） |
| Pi `/resume`/fork/reload | 清空后仅回填 Pi 当前 root→leaf branch；不混入 alternate branches |
| compaction | 双形态：turn 间独立 / turn 内编号（对齐 dsh 语义） |

## 7. 里程碑

| 里程碑 | 内容 | 验收 |
|---|---|---|
| **M1 回放先行** | ReplaySource + Store + RecordList/Inspector/SessionPicker | 能打开任意历史会话，流畅浏览，1000+ entry 达标 |
| **M2 live 接入** | LiveSource + 帧合并 + in-flight 动画 + 尾部跟随 + TTFT/decode | `/trace` 在当前会话实时可用，流式不闪 |
| **M3 打磨发布** | 搜索、时间轴缩放、窄终端降级、动画、README/截图 | 发布 0.1.0 到 npm |

M1 先做回放的原因：数据源稳定（JSONL 格式有版本号、可静态验证），UI 组件先在确定性数据上打磨好，再接 live 的复杂度。

## 8. 开放问题（已验证，2026-08-26）

1. ~~subagent 事件在 pi 生命周期里如何暴露？~~ **核心 API 无 subagent 专属事件**（`core/extensions/types.d.ts` 已查）。FR-12 推迟，将来依赖 subagent 扩展（如 pi-subagents）自行暴露的标识。
2. ~~`session_start` 恢复旧会话时是否会重放历史 message 事件？~~ **不会重放，但可自己回填**：`SessionStartEvent.reason` 区分 `startup/reload/new/resume/fork`，且 `ctx.sessionManager`（ReadonlySessionManager）公开 `getBranch()`。live 模式在 `resume/fork/startup` 时只从当前 leaf 回溯的 branch 回填 → **live 与 history 融合成立：恢复即补全当前轨迹**，且不必解析或写入 JSONL。
3. 图片块在 pi-tui Image 组件的实际能力边界（FR-14 可行性）——实现 P2 时确认。
