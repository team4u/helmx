# 规划模式插件（`builtin:plan`）

`builtin:plan` 为顶层人类直连会话提供受控的只读调研与结构化方案审批闭环：进入规划模式后收紧为严格只读工具白名单、支持通过 `plan_save` 多轮草拟与修订方案、通过 `plan_propose` 经 `AskDoc` CAS 乐观锁发起人机审批、批准后将方案归档为会话 `Artifact`（`plan-v<N>.md`），并支持可选的全新上下文交接（`control.handoff`）与模型/档位切换执行。

## 当前状态

默认启用、非 `locked` 可停用。全部策略、状态与前端视图位于插件层；内核只通过 `PluginToolResultEnvelope.control` 透传纯机制级的 `handoff` / `terminate` 回合控制原语，对规划业务概念零感知。

## 适用范围与入口

### 1. 会话作用域约束

仅支持**顶层人类直连会话**（`parentConversationId === undefined && (ownedBy ?? 'human') === 'human'`）：

- 子代理会话（`parentConversationId !== undefined`）与 `ownedBy: 'helmx'` 后台会话调用 `toggle` / `set_mode` 拒绝 `400 plan_unsupported_conversation`；`get` 返回默认空视图 `{ mode: 'normal', awaitingApproval: false }`；
- `input` 与 `before_turn` 钩子自动忽略非顶层、非人类或 `origin !== 'human'` 输入，不向其注入规划提示词或工具。

### 2. 多端入口与 Action

插件通过 `ctx.action` 注册三个会话控制动作（均声明 `exposeToPrompt: false`，不进入系统提示词 `<available_actions>`），并注册 `/plan` 全局命令（`id: 'toggle-plan'`, `slash: 'plan'`, `scope: {}`, `icon: 'list-tree'`）：

| 入口 | 用法 | 说明 |
| :--- | :--- | :--- |
| 工具栏按钮 | 输入框左下角模型选择器旁的规划按钮（`COMPOSER_TOOLBAR_SLOT`） | 真实会话点击直接调用 `toggle`；待命页（`#/a/<profileId>`）按独立分屏草稿切换本地 `inputMeta['builtin:plan'] = { mode: 'planning' }` 预武装态（不落库、不标脏），首条消息发出时在 `onInput` 原子进入规划模式并保留原文本与自动标题 |
| 输入框斜杠 / `⌘K` | `/plan`（无参数）或 `/plan <任务>` | 真实会话中选命令执行 `toggle`；直接发送裸 `/plan` 由 `onInput` 接管（`handled`）切换至规划模式不进聊天历史；发送 `/plan <任务>` 切换至规划模式并剥离前缀（`transform`），内核据此生成无 `/plan ` 前缀的标题后直接开始调研 |
| CLI | `helmx plan toggle --current` / `set_mode --current --input '{"mode":"planning"}'` / `get --current` | 支持 `--conversation-id <id>` 与 `--json`，返回 `PlanSessionView` |
| HTTP | `POST /api/actions/builtin:plan/<toggle\|set_mode\|get>` | 入参 `conversationId` 与上下文冲突时拒绝 `400 validation_error` |

在规划审批挂起期间（存在 `pendingAskId`），若用户直接在 Composer 发送新的人类消息（`origin === 'human'`），`onInput` 会先以 `'superseded'` 结算挂起审批单并保留在 `planning` 模式，避免新消息在队列中因审批卡死。

## 能力与执行机制

### 1. `before_turn` 严格工具白名单（`priority: -50`）

- **普通模式（`mode === 'normal'`）**：仅剔除 `plan_save` 与 `plan_propose`，不注入任何提示词段落；
- **规划模式（`mode === 'planning'`）**：仅保留 `PLAN_MODE_TOOL_WHITELIST` 中的六个工具：
  `read`、`read_artifact`、`bash`、`load_skill`、`plan_save`、`plan_propose`。
  `write`、`edit`、`register_artifact`、`run_action`、`subagent`、`SubagentWorkflow`、`cleanup_worktree`、`update_memory`、`swarm_dispatch_worker` 等修改或派工工具全部被剔除；由于钩子在 `builtin:profile`（`-100`）之前执行且剔除了 `run_action` 与派工工具，系统提示词中的 `<available_actions>` 与 `<available_profiles>` 同步自然省略，并注入 `plan.mode` 段落约束 `bash` 仅作只读检查。

### 2. 草拟与审批工具（`plan_save` / `plan_propose`）

| 工具 | 参数与边界 | 行为 |
| :--- | :--- | :--- |
| `plan_save` | `title`（1..120 字符）、`markdown`（1..98,304 UTF-8 字节） | 仅允许在顶层人类会话 `planning` 模式下调用；经 `ctx.host.redact` 脱敏、递增 `version`、持久化 `ctx.kv('plans')` 并 `await flushKv()`，更新 `plan` `sessionDoc` 与 `plan-badges`，返回结构化 `presentationMeta` |
| `plan_propose` | `summary`（1..300 字符纯文本，拒绝 ```` ``` ```` 代码围栏防误触 `AskDock` 终端快照） | 要求已存在草稿且无并发挂起审批；预生成 `askId` 落盘并跟踪于 `liveTasks`，绑定 `context.signal` 中止取消回调，携带 `expectedStateSeq` 调用 `ctx.host.createAsk` 发起审批 |

审批选项（`decision` 单选 + 可选 `feedback` 文本）：

1. **`revise` / `cancelled` / `superseded`**：清除 `pendingAskId`，保持在 `planning` 模式（若人类通过 `toggle`/`set_mode('normal')` 主动退出则切回 `normal`），不生成 Artifact；
2. **`approve`**：通过 `ctx.host.createArtifact` 归档为 `plan-v<N>.md`（`text/markdown`），切回 `normal` 并 `flushKv()`，下一回合恢复全部工具；
3. **`approve_handoff`**：归档 `plan-v<N>.md`、切回 `normal` 并 `flushKv()`，返回 `control: { handoff }`（经 SecretStash 脱敏，UTF-8 上限 128 KiB，超限时仅裁剪可选 `feedback`），由内核在同回合追加可见 `pi.reset` 并立即在干净上下文中继续生成执行；
4. **`approve_handoff_model`**：仅当配置了非空 `executionModel` 时展示。执行顺序为**先调用 `ctx.host.updateConversation(id, { model: executionModel })`**（如目标模型禁用 `409 model_disabled` 或档位不存在 `404 model_tier_not_found`，立即停留在 `planning` 模式并返回 `{ isError: true }` 诊断，不创建 Artifact、不触发交接、绝不静默回退）；模型切换成功后归档 `plan-v<N>.md`、切回 `normal` 并通过 `control.handoff` 立即在目标模型与全新上下文中开始执行。

## 配置项

| 配置 | 类型 | 缺省 | 说明 |
| :--- | :--- | :--- | :--- |
| `executionModel` | string (`format: 'model'`) | `""` | 可选执行模型或档位（如 `tier/coder`）；配置非空值后，审批单自动提供一键切换该模型并开启新上下文执行的选项 |

## 数据投影、界面与生命周期

- **持久键值（`ctx.kv('plans')`）**：按 `conversationId` 存储 `{ mode, pendingAskId?, draft?, approved? }`，所有状态变更均先 `flushKv()` 再同步投影或对外响应；
- **公共文档**：
  - `plan`（`ctx.sessionDoc`，`public: true, durable: false`）：按会话分片的 `PlanSessionView`，经专用 SSE 按需推送，不进入全局首帧；
  - `plan-badges`（`ctx.doc`，`public: true, durable: false`）：全局紧凑角标摘要（`accent` 规划中 / `warn` 等待审批 / `neutral` 已批准或已有草稿）。
- **前端界面（`packages/plugins/src/plan/client/`）**：遵循 `clientRoot` 隔离与 Fast Refresh 规范（零 Emoji），提供四个按需组件：`PlanToolbarButton`（`COMPOSER_TOOLBAR_SLOT`，主输入框左下角模型选择器右侧；待命页使用轻量 `draftMeta`/`setDraftMeta` 零订阅本地切换，窄屏/窄分屏自动折叠为图标按钮；非顶层/非人类会话零订阅返回 `null`）、`PlanActiveTray`（`COMPOSER_DOCK_SLOT`，仅当存在方案草稿或审批等待中 `draft !== undefined || awaitingApproval` 时展示，普通模式与仅预武装待草拟时零高度 `null`）、`PlanWorkbenchPanel`（右侧 `plan` 面板，只读渲染计划 Markdown 与已批准产物链接）及 `PlanToolRow`（`toolView`，只消费 `props.presentationMeta` 渲染 26px `.trace-row`）。
- **服务治理与崩溃恢复**：
  - `start()` 从 KV 水合 `plan` 与 `plan-badges` 投影；`reconcile()` 在重启后扫描孤儿 `pendingAskId`，以 `'superseded'` 清理对应 `AskDoc`（忽略 `404`/`409`）并解除会话 `blocked`；
  - 审批等待期间停用插件触发 `liveTasks()` 硬阻断（`409 plugin_has_live_tasks`，不可 `--force`）；存在空闲 `planning` 会话时停用返回 `409 plugin_in_use`，`--force` 可强制停用并立即恢复全量工具（保留草稿待重新启用恢复）；
  - `conversation.deleted` 事件自动取消残留审批单并清理对应 KV、`sessionDoc` 与角标条目。

## 源码与测试入口

| 内容 | 位置 |
| :--- | :--- |
| 插件入口（配置 / 动作 / 命令 / UI / 服务） | `packages/plugins/src/plan.ts` |
| 契约、白名单、Schema 与边界守卫 | `packages/plugins/src/plan/contracts.ts` |
| 状态管理、KV 序列化与生命周期对账 | `packages/plugins/src/plan/state.ts` |
| 钩子注册（`input` / `before_turn` / `conversation.deleted`） | `packages/plugins/src/plan/hooks.ts` |
| 模型工具（`plan_save` / `plan_propose`） | `packages/plugins/src/plan/tools.ts` |
| 前端组件与样式 | `packages/plugins/src/plan/client/` |
| 内核工具结果 `control` 边界校验与交接透传 | `packages/protocol/src/plugin-dto.ts`、`packages/kernel/src/runtime/tools/tool-result-contract.ts` |
| 单测、集成与前端 DOM 测试 | `packages/plugins/test/plan-plugin.test.ts`、`packages/plugins/test/plan-plugin.integration.test.ts`、`packages/web/test/plan-client-interactions.test.tsx` |

## 相关文档

- [插件系统设计与契约](overview.md)
- [微内核架构总览](../architecture/overview.md)
- [后端生命周期 Hook 与前端全界面扩展点](../architecture/extension-points.md)
