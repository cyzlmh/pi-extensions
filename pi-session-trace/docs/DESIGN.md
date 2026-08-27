# pi-session-trace — 技术方案

对应 [PRD](./PRD.md)。原则：**体验优先**，所有架构决策以服务 PRD 第 5 节的体验原则为准。

## 1. 总体架构

```
┌─────────────────────────────────────────────────────┐
│ 数据源层（两种模式，同一接口）                          │
│                                                     │
│  LiveSource                ReplaySource             │
│  pi 生命周期事件订阅         session.jsonl 解析器      │
│  (当前会话, 实时)           (~/.pi/agent/sessions/)  │
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

关键决策：**持久化不写自己的存储**。pi 的 session.jsonl 已是完整的持久层（replay 直接读），live 数据 pi 自己也在落盘——这与 pi-trace-extension 自存 events.jsonl 的路线有本质区别，我们零冗余。

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

- **live**：`timing.ttftMs = message_start → 首个 message_update`，`decodeMs = → message_end`（ppmina 同款推导）
- **replay**：JSONL 只有 entry 级 ISO 时间戳，无 per-token 计时 → 时间轴降级为 entry 间隔，`timing` 缺省时 UI 明确显示为灰色而非留空（E6）

## 3. 数据源

### LiveSource

订阅 pi 扩展事件（与 ppmina 版相同集合）：

| pi 事件 | 用途 |
|---|---|
| `session_start` | 初始化；恢复旧会话时标注"此前记录不可见"分隔线 |
| `turn_start` / `turn_end` | turn 分组与边界 |
| `message_start` / `message_update` / `message_end` | assistant/user 记录，TTFT/decode 计时 |
| `tool_execution_start` / `_update` / `_end` | tool 记录状态机 running→ok/error |
| `session_compact` | compaction 记录 |

### ReplaySource

解析 `~/.pi/agent/sessions/--<path>--/<ts>_<uuid>.jsonl`：
- 流式逐行读（不整文件载入内存），entry → record 增量喂给 Store，打开大文件时列表**边解析边出现**（E2）
- 会话选择器索引：扫 sessions 目录，读 header + 首条 user 消息做预览，结果缓存（mtime 失效）
- 需覆盖的 entry 类型：message / compaction / model_change / thinking_level_change / branch_summary / custom（custom 未知类型降级为灰色 marker，不报错）

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

1. 第一层：摘要卡（usage、耗时、model、状态）
2. 第二层：完整内容（Markdown 组件渲染 assistant/user；tool 显示 JSON args + 输出，输出可滚动）
3. 第三层：原始 entry JSON（replay）/ 原始事件（live）
- Esc 逐层返回

### SessionPicker（`/trace` 无参且非 live 场景 / `/trace pick`）

- 项目分组（cwd 最后一级）、时间倒序、首条 user 消息预览
- 输入即模糊过滤；enter 打开

### 键位

| 键 | 动作 |
|---|---|
| j/k / ↑↓ | 移动选择（自动滚动） |
| enter | 进入 inspector / 展开折叠 |
| space | 折叠/展开 turn |
| g / G | 顶部 / 底部（G 同时恢复尾部跟随） |
| / | 搜索；n/N 跳转命中 |
| t | 光标定位到时间轴条，←→ 缩放，移动焦点区间 |
| q / Esc | 关闭（inspector 内为返回上一层） |

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
| live 中 pi 恢复旧会话 | 插入"── 以下为本次进程记录 ──"分隔线 |
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
2. ~~`session_start` 恢复旧会话时是否会重放历史 message 事件？~~ **不会重放，但可自己回填**：`SessionStartEvent.reason` 区分 `startup/reload/new/resume/fork`，且 `ctx.sessionManager`（ReadonlySessionManager）暴露 `getEntries()`/`getSessionFile()`/`getTree()`。live 模式在 `resume/fork/startup` 时直接从 sessionManager 拿全量 entries 回填 → **live 与 replay 融合成立：恢复即补全轨迹**，且不必重复解析 JSONL。
3. 图片块在 pi-tui Image 组件的实际能力边界（FR-14 可行性）——实现 P2 时确认。
