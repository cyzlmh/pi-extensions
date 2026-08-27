# pi-session-trace — 产品需求文档

## 1. 背景

调研结论（2026-08-26）：pi 生态现有的 trajectory/trace 类插件各有明显缺口——

| 插件 | 历史会话 | Live | 持久化 | 形态 |
|---|---|---|---|---|
| pi-trajectory (ktappdev) | ✅ | ❌ | 读 pi JSONL | 浏览器 + 独立 server |
| pi-trajectory (ppmina) | ❌ | ✅ | ❌ 内存 | 浏览器 + 内置 server |
| pi-trace-extension | ❌ | ✅ | ✅ 自存 events.jsonl | 单文件 HTML |
| dsh 原版 trajectory | ✅ | ✅ | ✅ | dsh web UI（生态外不可用） |

**空白**：没有插件同时做到「dsh 级 live 体验 + 历史回放 + 持久化」，且全部依赖浏览器——远程/SSH 场景需要绑端口（无鉴权风险）或端口转发。

## 2. 产品定位

纯 TUI 的 pi 会话轨迹查看器。一个 `/trace` 命令，live 看当前会话，回放看历史会话，零 server、零浏览器、零额外存储。

**差异化竞争力就是体验**：功能上各家都做了个七七八八，这个包要赢在"用起来爽"。

## 3. 目标

1. **Live**：会话进行中实时渲染轨迹，turn 分组，assistant 消息区分 TTFT / decode 阶段
2. **回放**：读取 pi 自己的 session JSONL（`~/.pi/agent/sessions/`），历史会话用同一视图打开
3. **持久化**：不写私有存储——pi 的 session.jsonl 就是持久层，pi 重启后一切可回看
4. **纯 TUI**：overlay 浮层渲染，SSH 场景开箱即用，无端口、无鉴权问题

## 4. 非目标

- ❌ 成本统计、错误分析、跨会话 dashboard（pi-trace-extension 的地盘）
- ❌ 云端上传 / 可观测平台对接
- ❌ 修改或控制 agent 行为（只读）
- ❌ 浏览器 UI（明确选择 TUI 路线，不与 web 方案比视觉表现力）

## 5. 体验原则（本包的核心竞争力）

- **E1 流畅不闪**：流式事件合并到渲染帧（~16ms 粒度）再重绘，token 狂飙时界面稳定；滚动位置永不被意外打断
- **E2 即时反馈**：任何按键 <100ms 有视觉响应；进行中的记录有明确的"活"的动态（动画态），不是干等
- **E3 键盘优先**：全套 vim 习惯键位（j/k/g/G、/、n/N），不需要摸鼠标——本来也没有鼠标
- **E4 密度分级**：列表层一眼扫完全貌（每条记录一行，信息克制）；详情一层层钻进去（摘要 → 完整 I/O → 原始 JSON）
- **E5 像 pi 原生**：全部颜色走 pi 主题 token，换主题自动适配；排版、留白、键位风格与 pi 自身 UI 一致，不能有"外来插件感"
- **E6 状态完整**：加载中、空会话、解析失败、中断的记录——每种状态都有设计过的展示，不允许出现裸报错或空白屏

## 6. 用户场景

- **S1 过程监控**：长跑任务时打开浮层，实时看模型在做什么、卡在哪一步
- **S2 事后复盘**：昨天的会话出了问题，从会话列表打开，定位到具体 turn 看 tool I/O
- **S3 远程开发**：SSH 到服务器上用 pi，直接 TUI 查看，不需要任何端口转发
- **S4 性能感知**：看 TTFT/decode 分布，感知 provider 当前的响应质量（live 模式）

## 7. 功能需求

### P0（MVP）

- FR-1 `/trace` 打开当前会话的 live 轨迹浮层
- FR-2 turn 分组列表：user / assistant / tool / compaction 四类记录，每条一行摘要
- FR-3 inspector：选中记录逐层查看——摘要 → 完整输入/输出（Markdown 渲染）→ 原始数据
- FR-4 历史会话：会话选择器打开任意历史会话（按项目分组、时间排序、首条消息预览、模糊搜索）
- FR-5 导航：j/k 滚动、enter 展开、space 折叠 turn、q/Esc 关闭

### P1（体验核心）

- FR-6 TTFT / decode 分色时间轴条；聚焦某条记录时显示精确起止时刻与耗时
- FR-7 live 尾部自动跟随；上滚暂停跟随并显示"↓ N 条新记录"指示器，回到底部恢复
- FR-8 in-flight 记录动画态（进行中的 assistant 流式增长、running tool 转圈）
- FR-9 `/` 搜索记录内容，n/N 在命中间跳转
- FR-10 model_change / thinking_level_change / 中断记录等事件内联可见
- FR-11 窗口化渲染：只渲染可视区 ± overscan，1000+ entry 会话滚到底不卡

### P2（打磨）

- FR-12 subagent 事件嵌套缩进展示
- FR-13 分支（session tree / fork）可视化
- FR-14 图片内容块终端内展示（pi-tui Image 能力内）
- FR-15 浮层打开/关闭动画（pi overlay 支持）

## 8. 成功标准

| 指标 | 目标 |
|---|---|
| 1000+ entry 历史会话 | 打开 <1s，滚动帧率不掉 |
| live 事件→渲染延迟 | <100ms 感知 |
| token 流式高峰 | 界面无闪烁、滚动位置不跳 |
| 依赖 | 零 server 进程、零端口，`pi install` 即用 |
| 主观 | 用过 dsh trajectory 的人不觉得降级 |

---

## 决策变更（2026-04）：移除内置会话选择器

**变更**：删除 `/trace pick`、`/trace <id>`、SessionPicker、JSONL 文件扫描/流式解析（约 400 行）。`/trace` 只看当前会话。

**理由**：
1. dsh 原版的 layering 也是「先选 session → 再看 trace」，选择器不属于 trajectory 视图
2. pi 原生已有 session 切换（`/resume` / `--resume` / `/fork`）；`session_start` 触发 backfill，`sessionManager.getEntries()` 补全完整历史——**pi 自己就是 replay 引擎**，内置 picker 是重复造轮子

**保留**：EntryConverter（backfill 命脉）、TraceStore、overlay 全套。历史会话查看路径 = `/resume` 切换 → `/trace`。

**代价**：无法"只读窥看"别的会话（/resume 是切换）；想看旧会话又不打断当前工作需另开终端。接受。
