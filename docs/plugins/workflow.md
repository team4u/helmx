# 工作流与子代理编排插件

`builtin:workflow` 默认启用。委派一个子任务时用 `subagent`，要固定一连串步骤时用 `SubagentWorkflow` 或 `helmx workflows run`。运行记录可在会话工作台查看。需要执行真实测试来验收代码时，可以为子代理分配 Git worktree，并指定一条测试命令。 [第一个工作流](../getting-started/first-workflow.md) · [JavaScript 编排 API](../workflows/dsl-guide.md)

受管工作树的分配与清理由 [`builtin:worktree`](worktree.md) 提供：`isolation: 'worktree'` 请求经 `agent_spawn` 管道由其兑现，无插件兑现而到达原生执行路径时显式返回 `unsupported_runtime`。 [工作树与门禁](../workflows/worktree-and-gate.md)

### 模型工具（2 个，外加动态 `workflow_steer`）

- **`subagent`**：派生子代理。支持 `fork: true` 从父会话上下文分叉（默认收口为叶子，除非显式传入 `maxSubagentDepth`）、`nodeId` 动态目标计算节点覆写（显式 `'local'` 可切回本机，远端节点需兼容 `cwd`，与 `resume` 互斥）、`isolation: 'worktree'` 隔离工作树、`resume` 续接（凭 `execution.conversationId` / `executionId`）、`schema` 结构化输出、`gate` 验收命令、`model` / `effort` 覆盖、`maxSubagentDepth` 显式授予派生深度；
- **`SubagentWorkflow`**：确定性 DSL 编排（内联 `script` / `scriptPath` / 已保存 `name`），journal 账本支持 `resumeFromRunId` 断点恢复。

后台策略按**当前会话归属**判定：human 会话缺省后台（终态后幂等汇报自动到达父会话，禁止 sleep 轮询）、显式 `background: false` 同步等待；`helmx` 自动化会话缺省同步、显式 `background: true` 拒绝。同步 `subagent` 直接经内核 `ctx.host.spawnAgent` 执行并按 `(parentConversationId, parentToolCallId)` 幂等续接，不创建 `WorkflowRun` 磁盘账本记录；后台 `subagent` 与 `SubagentWorkflow` 由引擎账本持久化跟踪。`helmx workflows run` 动作与模型工具的 `background` 是不同参数、不同入口。

### 动作（10 个，五端复用）

| 动作 | CLI 映射 | 说明 |
| :--- | :--- | :--- |
| `list` | `helmx workflows list` | 列出已保存定义（每条携带真实文件事实 `updatedAt` / `size`；元数据非法条目保留并附 `metadataError`） |
| `get` | `helmx workflows get <name>` | 读取完整定义（只读源码 + 元数据；Web/AI 只读，不提供编辑） |
| `save` | `helmx workflows save <fileOrScript>` | 直接提供 `script`（位置参数为本地脚本文件时自动读入）；缺省名用 `meta.name`；默认拒绝覆盖，`--overwrite` 才覆盖；保存前语法预检，原子写入 |
| `delete` | `helmx workflows delete <name>` | 删除定义文件（历史运行记录不受影响）；防目录外符号链接 |
| `run` | `helmx workflows run [nameOrFile]` | 启动运行；新 run 必须显式指定会话（CLI `--current` 或 `--conversation-id`）；`--wait` 同步等终态；`--resume-from-run-id` 同时支持失败 DSL 工作流与具可续接句柄的 `failed/aborted` 单子代理 |
| `runs` | `helmx workflows runs` | 列出运行记录，支持按会话过滤 |
| `inspect` | `helmx workflows inspect <runId>` | 单个运行详情（节点状态 + 进度时间线） |
| `abort` | `helmx workflows abort <runId>` | 中止运行中的工作流或后台子代理 |
| `steer` | `helmx workflows steer <runId> --text` | 向在途后台子代理插话纠偏（通过 `exposeAsTool: { name: 'workflow_steer' }` 仅在存在在途后台子代理时暴露给模型）；经内核 guarded 端口按归属与 CAS 水位提交（`guardLevel: 'cas'`）；`steered=true` 仅代表投递成功 |
| `resume_failed` | `helmx workflows resume-failed` | 批量续接指定会话（`--conversation-id` / `--current`）或全局（`--all`）下所有可恢复的 `failed` 工作流与后台单子代理；不可恢复项如实记入 `skipped` |

`run` 与 `resume_failed` 对会话目标有显式冲突校验：输入 `conversationId` 与调用上下文同时存在且不一致时显式 `400 validation_error`；`resume_failed` 同时要求 `conversationId` 与 `all: true` 互斥。`worktrees` 命令族（清理 / 登记 / 检视）由 [`builtin:worktree`](worktree.md) 提供。

### 前端贡献

- `toolView`：`subagent-card`（`replaceRow: true`）与 `workflow-card`（`replaceRow: true`）；时间线单行收口为 26px `.trace-row`，`SubagentToolView` 通过 `{ includeDetail: false, includeLive: false }` 同时跳过子会话全量详情拉取与 60Hz 流式正文订阅；视图直接消费宿主持久化到 `details` 的有界 `presentationMeta`（配合 `useTimelineToolCalls('subagent')` 按工具名分片订阅续接关系，零 `JSON.parse` / 尾注文本刮取），并通过叶子组件 `ElapsedClock` / `WorkflowTimingClock` 隔离宿主共享 1Hz 时钟 `useSharedNowMs`；
- `timelineRenderer` `background-report`：后台结算汇报折叠卡，基于 `KvGrid` / `Callout` 原语直接解析入口 `data.meta.report` 结构化载荷（完成默认折叠，失败/中止/损坏默认展开）；
- `slot` `active-tray`（基于 `@helmx/plugin-client` `DockTray` / `DockTrayRow`，空闲返回 `null` 零 1Hz 计时渲染）与 `workbenchPanel` `tasks`（badge 绑定 `run-badges`，工作台与停靠区统一以 `runs` 为唯一执行树根来源，人类 `fork` 与 Swarm 成员会话不进入工作流树；工作台统一使用 `WorkflowRunCard` + `ExecutionNodeRow`，`aborted` 独立呈现不折算成完成；运行卡折叠仅渲染 `resultPreview`，点击展开结果才调 `inspect` 按需拉取并缓存完整 `result`）；工作树只读检视与清理按钮经 `<PluginSlot name="worktree-inspect" />` / `<PluginSlot name="worktree-cleanup" />` 开放给 [`builtin:worktree`](worktree.md) 贡献，停用 `builtin:worktree` 时自动隐去；
- `sidebarItem` + `screen` `library`：工作流库全屏视图（基于 `Screen` / `SearchBox` / `DetailDrawer` / `ConfirmDialog` 原语，原生 `<button>` 卡片、只读浏览、显式选择目标会话运行、两步确认删除；无编辑器，「交由助手修改」仅提供可复制请求文本）。

## 配置与数据边界

| 配置 | 类型 | 缺省 | 说明 |
| :--- | :--- | :--- | :--- |
| `maxConcurrentAgents` | integer | 按 CPU 并行度计算（2..32） | 单个 run 的并发 agent 上限（1..128） |
| `maxSubagentDepth` | integer | 2 | 受管子代理嵌套深度上限（1..5）；主会话为第 0 层，变更只影响新派生任务树 |
| `autoRecoverOnRestart` | boolean | `true` | Hub 重启后尝试恢复在途任务。设为 `false` 或 `HELMX_AUTO_RECOVER=0` 时，关停会中止任务，启动时会把遗留的运行标为失败。 |

状态按冷热分层持久化与投影，彻底消除整表写放大：

| 存储 / 文档 | 类型 | 内容 |
| :--- | :--- | :--- |
| `ctx.kv('runs')` | 私有按键 KV（SQLite） | 每 run 紧凑 `RunHeader`（`id` / `name` / `conversationId` / `status` / `phase` / `kind` / `createdAt` / `updatedAt` / `settledAt` / `errorCode` / `journalPath` / `replayedFrom` / `notifyParentOnSettle` / `notifiedAt` / `crashRecoveries`）；`resumedByRunId`（接管索引）由单键 `replayedFrom` 在内存派生，零双写；完整节点/参数/结果按需原子落盘至 `<ctx.dataDir>/artifacts/<conversationId>/wf-<runId>.detail.json`（128 项 LRU 缓存） |
| `ctx.kv('depth')` | 私有按键 KV（SQLite） | 按会话 ID 存储的受管子代理深度记录（`depth` / `parentConversationId` / 子树上限 / 可选 `forked` 事实），深度契约唯一事实来源 |
| `runs` | 公开 `ctx.sessionDoc`（`durable: false`） | 纯内存瞬态投影（真增量 `O(depth)` 更新）：当前会话及后代发起的 run 分片（专有 SSE 订阅，单分片 `MAX_PROJECTED_RUNS_PER_CONVERSATION = 100` 保留全部 `running` + 最新终态，剥离完整 `result` 仅保留 `hasResult`/`resultPreview` 并附带 `errorCode`/`resumable`）；启动时自 `ctx.kv('runs')` 重建，停用不落盘 |
| `run-badges` | 公开 `ctx.doc`（`durable: false`） | 纯内存瞬态投影：基于全量运行态聚合的每会话紧凑角标（`count / tone / footerText`，不受 100 条分片滑窗影响；**一级口径**——只计本会话直接发起的 run，后代 run 归其发起会话自己的角标）；启动时自 `ctx.kv('runs')` 重建，停用不落盘 |

工作流定义文件唯一存储真源是 `<ctx.dataDir>/workflows/<name>.js`。引擎经 `emitEvent` 发布 `workflow.updated`（全局仅状态失效提示）与 `workflow.settled`（完整 summary，`broadcast: false` 进程内分发）。

**嵌套深度契约**：受管子代理（经 `subagent` / 编排引擎 / 任何 `agent_spawn` 管道派生、`onResolved` 回传 `conversationId` 的子会话）非分叉默认可嵌套 2 层，达到子树上限即编排叶子；`fork: true` 默认收口为当前子层级的叶子（`maxSubagentDepth = childDepth`）并持久记录 `forked: true`，在 `before_turn` 注入 `<forked_subagent_context>` 边界段落防止重复派发继承来的父级委托指令，仅当显式传入 `maxSubagentDepth`（且不超出继承上限）时才允许继续嵌套。三道防线：`before_turn` 剥离叶子回合的派工工具（含所有活跃 `helmx.dispatch-tools` 提供方声明的工具，自然抑制 `<available_profiles>`）、工具/动作入口前置拒绝（`403 subagent_depth_exceeded`）、`agent_spawn` 钩子（priority 300）兜底。会话级 `conversations fork` 与非分叉 Swarm 成员不进登记表、不受限。DSL `workflow()` 脚本组合深度上限为 2 层（`MAX_WORKFLOW_NESTING_DEPTH = 2`），与子代理层级分别计数。

## 停用与失败语义

- 有任务正在运行时，停用插件会返回 `409 plugin_has_live_tasks`，`--force` 也无法继续。
- Hub 重启时，默认保留可恢复的 `running` 任务（`RunPhase` 置为 `'suspended'`）。启动阶段会在调度器恢复前为无法原位恢复的子会话写入中止标记，再重新接上符合条件的后台子代理与工作流，并补发未送达的汇报。关闭自动恢复、连续崩溃超过上限或遇到未确认的动作副作用，都会改变恢复结果。 [Hub 重启恢复](../workflows/journaling-recovery.md#hub-重启恢复)
- 插件停用时先停止发布 `runs` 和 `run-badges`，再执行 `suspend()`（优雅关闭）或 `close()`（插件停用/关闭自动恢复）并收敛在途落盘与动作终态写入。索引损坏时以 `workflow_index_corrupt` 显式报错。
- 父会话中止后，`turn_settled` 会取消其子树里的在途运行。中止受管子会话前，内核用 `abortConversationGuarded` 复核会话归属。
- 工作树租约与清理由 [`builtin:worktree`](worktree.md) 承载：租约在 `git worktree add` 前持久登记，崩溃后无法确认执行已经停止时，清理会返回 `worktree_execution_unknown` 并保留租约。停用本插件不影响该插件独立工作。

## 源码与测试入口

| 内容 | 位置 |
| :--- | :--- |
| 插件入口（组装与生命周期编排） | `packages/plugins/src/workflow.ts` |
| 纯 JS DSL 运行时与账本 | `packages/plugins/src/workflow/dsl/`（`types.ts`、`meta.ts`、`boundary.ts`、`journal.ts`、`worker-source.ts`、`runtime.ts`） |
| Run 协调、仓储、恢复与库管理 | `packages/plugins/src/workflow/runs/`（`run-repository.ts`、`run-coordinator.ts`、`cancellation.ts`、`action-bridge.ts`、`resumability.ts`、`spawn-bridge.ts`、`library-store.ts`） |
| 适配器与投影 | `packages/plugins/src/workflow/`（`depth.ts`、`projection.ts`、`hooks.ts`、`tools.ts`、`actions.ts`、`steer.ts`、`config.ts`） |
| 前端 UI（12 模块） | `packages/plugins/src/workflow/client/`（`index.tsx`、`execution-model.ts`、`parsers.ts`、`hooks.ts`、`copy.ts`、`ElapsedClock.tsx`、`ExecutionNodeRow.tsx`、`ToolTraceRows.tsx`、`WorkflowRunPanel.tsx`、`WorkflowActiveTray.tsx`、`WorkflowLibrary.tsx`、`styles.css`） |
| 共享契约（run/doc/meta 形状） | `packages/plugins/src/contracts.ts` |
| 主要测试 | `packages/plugins/test/workflow*.test.ts`（DSL 引擎、恢复重放、steer、abort 级联、库管理、前端模型/交互/三区/插槽检视测试）、`workflow-shutdown.integration.test.ts`、`background-restart.integration.test.ts`、`workflow-seamless-recovery.integration.test.ts` |

## 相关文档

- [受管工作树](worktree.md)：`isolation: 'worktree'` 的分配、租约与清理（`builtin:worktree`）
- [Swarm 对等协同](swarm.md)：复用 `builtin:worktree` 受管工作树的横向对等协同黑板
- [原生 JavaScript DSL 手册](../workflows/dsl-guide.md)：`agent` / `parallel` / `pipeline` / `phase` 语法与确定性约束
- [Git Worktree 与代码门禁](../workflows/worktree-and-gate.md)：Worktree 生命周期、租约与 Gate 验收
- [状态流水与故障恢复](../workflows/journaling-recovery.md)：journal 记账、前缀重放与断点续跑语义
