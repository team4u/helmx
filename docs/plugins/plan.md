# 计划模式插件（`builtin:plan`）

`builtin:plan` 为顶层人类直连会话提供受控的只读调研与结构化计划审批闭环：进入计划模式后收紧为规划工具白名单（剥离文件修改与派工工具，保留只读观察用 `bash`、`run_action` 与内核提问工具 `ask_user`）、支持通过 `plan_save` 多轮草拟自包含实施计划（并支持在工作台面板人工直接编辑修订）、通过 `plan_propose` 经 `AskDoc` CAS 乐观锁发起人机审批（支持单选决定、即选执行模型与温和提示）、批准后将计划归档为会话 `Artifact`（`plan-v<N>.md`），并支持可选的全新上下文交接（`control.handoff`）与模型/档位切换执行。

## 当前状态

默认启用、可按需停用。全部策略、状态与前端视图位于插件层；内核只通过 `AskDoc` 通用字段（`choice` / `model` / `defaultValue` / `hint`）与 `PluginToolResultEnvelope.control` 透传纯机制级的回合控制原语，对计划业务概念零感知。

## 适用范围与入口

### 1. 会话作用域约束

仅支持**顶层人类直连会话**（`parentConversationId === undefined && (ownedBy ?? 'human') === 'human'`）：

- 子代理会话（`parentConversationId !== undefined`）与 `ownedBy: 'helmx'` 后台会话调用 `toggle` / `set_mode` / `update_draft` 拒绝 `400 plan_unsupported_conversation`；`get` 返回默认空视图 `{ mode: 'normal', awaitingApproval: false }`；
- `input` 与 `before_turn` 钩子自动忽略非顶层、非人类或 `origin !== 'human'` 输入，不向其注入计划提示词或工具。

### 2. 多端入口与 Action

插件通过 `ctx.action` 注册四个会话控制动作（均声明 `exposeToPrompt: false`，不进入系统提示词 `<available_actions>`），并注册 `/plan` 全局命令（`id: 'toggle-plan'`, `slash: 'plan'`, `scope: { topLevelOnly: true, ownedBy: 'human' }`, `icon: 'list-tree'`）：

| 入口 | 用法 | 说明 |
| :--- | :--- | :--- |
| `+` 菜单 / `Ctrl+.` / 激活态胶囊 | 输入框左下角统一 `+` 菜单内「计划模式」（`COMPOSER_MENU_SLOT`）、主屏/分屏 `Ctrl+.`，或开启后模型选择器旁激活态紧凑胶囊（`COMPOSER_TOOLBAR_SLOT`） | 未开启时不占工具栏宽度，菜单与 `Ctrl+.` 均可用；激活态在工具栏呈现轻量紧凑胶囊并带一键退出 `×`；真实会话点击或快捷键直接调用 `toggle`；待命页（`#/a/<profileId>`）按独立分屏草稿切换本地 `inputMeta['builtin:plan'] = { mode: 'planning' }` 预武装态（不落库、不标脏），首条消息发出时在 `onInput` 原子进入计划模式并保留原文本与自动标题 |
| 输入框斜杠 / `⌘K` | `/plan`（无参数）或 `/plan <任务>` | `PlanToolbarButton` 通过 `useComposerCommand('toggle-plan', ...)` 统一接管输入框内 `/plan` 的交互式执行：待命页切换本地 `inputMeta['builtin:plan']` 预武装态（零后端请求、零空会话创建），顶层人类真实会话乐观切换模式且不锁发送栏、不弹多余通知；`⌘K` 与其他入口仍按作用域 `{ topLevelOnly: true, ownedBy: 'human' }` 调用 `toggle` 动作（自动排除子代理与 `helmx` 后台会话）；直接发送 `/plan <任务>` 则在 `onInput` 进入计划模式并剥离前缀（`transform`），内核据此生成无 `/plan ` 前缀的标题后直接开始调研 |
| 工作台人工编辑 | 在右侧「执行计划」面板点击草稿卡片「编辑」 | 触发 `update_draft` Action（携带 `expectedVersion` CAS 版本校验，冲突报 `409 plan_draft_conflict`）；若审批挂起期间编辑保存了新版草稿，批准归档与交接将采用最新编辑版本 |
| CLI | `helmx plan toggle --current` / `set_mode --current --input '{"mode":"planning"}'` / `get --current` / `update_draft --current --input '{"title":"...","markdown":"..."}'` | 支持 `--conversation-id <id>` 与 `--json`，返回 `PlanSessionView` |
| HTTP | `POST /api/actions/builtin:plan/<toggle\|set_mode\|get\|update_draft>` | 入参 `conversationId` 与上下文冲突时拒绝 `400 validation_error` |

在计划审批挂起期间（存在 `pendingAskId`），若用户直接在 Composer 发送新的人类消息（`origin === 'human'`），`onInput` 会先以 `'superseded'` 结算挂起审批单并保留在 `planning` 模式，避免新消息在队列中因审批卡死；内核内建 `ask_user` 的直接回复/取代亦由内核统一结算。

## 典型流程

以一次顶层人类直连会话为例，计划模式按以下顺序闭环（各步的入口、工具边界与状态字段见上下两节）：

1. **进入计划模式**：点击输入框左下角 `+` 菜单内「计划模式」、按 `Ctrl+.`、在输入框选或发 `/plan` / `/plan <任务>`，或在 CLI 执行 `helmx plan toggle --current`；待命页（`#/a/<profileId>`）只在本地写入预武装态并显示紧凑胶囊，首条消息发出时才真正进入计划模式。
2. **只读调研**：`before_turn`（`priority: -50`）将本回合工具收紧为 `PLAN_MODE_TOOL_WHITELIST` 中的八个工具（不含 `update_steps`）；文件编辑与派工工具全部剥离，模型使用 `read` / `read_artifact` / `load_skill` 审阅内容，并在模型级只读提示词约束下使用原生 `bash`（代码检索、构建、类型检查、测试、`git status/log/diff`）与 `run_action`（`list` / `describe` 及只读状态/检查动作）收集事实（不设静态 Shell 校验器）。
3. **澄清需求**：存在真实歧义时，在发起提案前优先调用内核内建工具 `ask_user` 发起 1..4 题结构化提问（不触发 `awaitingApproval`，不把未决问题留进计划正文；次要默认假设写入 `User Review Required`）；等待期间人类直接在 Composer 发送消息会以 `'superseded'` 结算该 AskDoc，并保持在 `planning` 模式。
4. **起草计划**：调用 `plan_save` 写入自包含、易审阅的结构化实施计划（按需包含 `Goal`、`User Review Required` 配合 GitHub Alerts、`Proposed Changes` 配合 `[MODIFY]`/`[NEW]`/`[DELETE]` 标记与工作区文件链接/`[NEW]` 行内代码路径、`Verification Plan` 等分节，并附完整文件路径、关键符号、分步改动、约束与验收命令），不在聊天正文重复粘贴计划全文；重复提交完全相同的标题与正文幂等跳过版本递增，改动则递增 `version` 并维护差异基准 `previousDraft`（`plan_propose` 之后通过 `lastProposedVersion` 将多轮修改统一锚定到最近一次提审版本，直到下次提审），经 `ctx.kv('plans')` 持久化后投影到 `plan` sessionDoc；人类亦可在右侧「执行计划」面板切换版本对比视图或直接编辑（`update_draft` 携带 `expectedVersion` 做 CAS 校验，冲突报 `409 plan_draft_conflict`）。
5. **提交审批**：调用 `plan_propose` 生成 AskDoc 审批卡，单选 `approve_handoff`「批准并在新上下文执行」/ `approve`「批准并在当前上下文继续」/ `revise`「退回修改」，可选 `executionModel` 模型与思考等级选择器（`thinkingLevelField: 'executionThinkingLevel'`）；`revise`、取消或超时销单都会清除 `pendingAskId` 并停留在 `planning` 模式，不生成 Artifact。
6. **归档与交接执行**：任一 `approve*` 决定都把最新草稿（含审批期间的人工编辑版本）归档为会话 Artifact `plan-v<N>.md`、切回 `normal` 并通过 `ctx.host.emitEvent` 发布 `plan.approved`（供 [`builtin:orchestrator`](orchestrator.md) 等编排插件协同切换阶段），下一回合恢复全部工具；选择 `approve_handoff` 时额外登记 `markExpectedHandoffReset` 并返回 `control.handoff`，内核在同回合追加可见 `pi.reset` 后在干净上下文中继续生成执行。若在审批单中选择了 `executionModel`（及可选思考等级），会先通过 `ctx.host.setConversationRuntimeModel(..., { resetOnRunEnd: true })` 执行单轮运行期模型切换（不覆写会话持久配置，回合结束后恢复），切换失败则停留在 `planning` 并显式报错，不静默回退。同时，本插件向 `PluginHost` 提供 `helmx.plan-mode-active`（`PlanModeActiveCapability`），确保其他插件可按只读协议查询是否处于 `/plan` 模式。

辅助事件：人工 `/clear` 自动清空计划模式、草稿与角标；时间线编辑重发（`helmx.rewind`）仅以 `'superseded'` 结算挂起 Ask 并保留计划模式与草稿；Hub 重启后 `reconcile()` 将孤儿 `pendingAskId` 以 `'superseded'` 清理并解除会话 `blocked`。

## 能力与执行机制

### 1. `before_turn` 严格工具白名单（`priority: -50`）

- **普通模式（`mode === 'normal'`）**：仅剔除 `plan_save` 与 `plan_propose`（保留内核 `ask_user`），不注入任何提示词段落；
- **计划模式（`mode === 'planning'`）**：仅保留 `PLAN_MODE_TOOL_WHITELIST` 中的八个工具：
  `read`、`read_artifact`、`load_skill`、`ask_user`、`bash`、`run_action`、`plan_save`、`plan_propose`（明确不含 `update_steps`，实时步骤清单面向执行阶段）。
  `write`、`edit`、`register_artifact`、`subagent`、`SubagentWorkflow`、`cleanup_worktree`、`update_memory`、`swarm_*` 等文件修改与派工工具全部被剔除；原生 `bash` 与 `run_action` 经 `plan.mode` 段落施加模型级只读规划约束（仅用于代码检索、构建、类型检查、测试、`git` 只读命令以及 `list` / `describe` / 只读查询动作，禁止修改文件、重定向写入、提交或变更宿主机状态；无静态 Shell 校验器）。由于钩子在 `builtin:mentions`（`-100`）之前执行且剔除了派工工具，系统提示词中的 `<available_profiles>` 同步自然省略；同时注入 `plan.mode` 段落明确只读约束、提案前用 `ask_user` 澄清阻塞歧义、自包含且易审阅的 Markdown 章节契约（`Goal`、`User Review Required` GitHub Alerts、`Proposed Changes` `[MODIFY]`/`[NEW]`/`[DELETE]` 标记与既有文件链接/新建文件行内代码路径规范、`Verification Plan`），以及「在 `plan_save` 与 `plan_propose` 之后不在聊天正文重复粘贴或复述计划全文」的防冗余提示（确保 `handoff` 后零上下文执行者无需二次盲搜）。

### 2. 工具清单与边界

| 工具 | 参数与边界 | 行为 |
| :--- | :--- | :--- |
| `plan_save` | `title`（1..120 字符）、`markdown`（1..98,304 UTF-8 字节） | 仅允许在顶层人类会话 `planning` 模式下调用；经 `ctx.host.redact` 脱敏；若脱敏后标题与正文与当前草稿完全一致则幂等返回当前版本（不递增版本、不覆盖对比基线）；有变更则递增 `version` 并按 `resolveNextPreviousDraft` 更新 `previousDraft`、持久化 `ctx.kv('plans')` 并 `await flushKv()`，更新 `plan` `sessionDoc` 与 `plan-badges`，返回结构化 `presentationMeta` 与不重复正文提醒 |
| `plan_propose` | `summary`（1..300 字符纯文本，拒绝 ```` ``` ```` 代码围栏） | 要求已存在草稿且无并发挂起审批；在 `pendingAskId` 入库时同步锚定 `lastProposedVersion = draft.version`（保留既有 `previousDraft` 供审阅期间查看增量对比）；生成 `kind: 'approval'` 全双语 `AskCreateSpec`：单选 `decision`（默认 `approve_handoff`「批准并在新上下文执行」，标 `recommended: true`；`approve`「批准并在当前上下文继续」；`revise`「退回修改」）、可选 `executionModel` 模型选择器（默认预填配置项 `executionModel`，无论是否切换新上下文均生效）、可选 `feedback` 与底部直接打字修订提示 |

审批选项行为：

1. **`revise` / `cancelled` / `superseded`**：清除 `pendingAskId`，保持在 `planning` 模式（若人类通过 `toggle`/`set_mode('normal')` 主动退出则切回 `normal`），不生成 Artifact；
2. **`approve`**：若选择了非空 `executionModel`，先以 `resetOnRunEnd: true` 设置本轮运行期模型与思考强度（失败停留 `planning` 并报 `isError: true`，绝不静默回退）；随后将最新草稿（`latest?.draft ?? draft`）归档为 `plan-v<N>.md`（`text/markdown`）、切回 `normal`、发布 `plan.approved` 事件并 `flushKv()`，下一回合恢复全部工具；
3. **`approve_handoff`**：若选择了非空 `executionModel`，先以 `resetOnRunEnd: true` 设置运行期模型；归档 `plan-v<N>.md`、切回 `normal`、发布 `plan.approved` 事件、登记 `markExpectedHandoffReset` 豁免随后的交接 `pi.reset` 并返回 `control: { handoff }`（经 SecretStash 脱敏，UTF-8 上限 128 KiB），由内核在同回合追加可见 `pi.reset` 并立即在干净上下文中继续生成执行。

## 配置项

| 配置 | 类型 | 缺省 | 说明 |
| :--- | :--- | :--- | :--- |
| `executionModel` | string (`format: 'model'`) | `""` | 可选默认执行模型或档位（如 `tier/coder`）；审批单中作为 `executionModel` 的默认预选项，用户审批时可按需改选或清空 |

## 数据投影、界面与生命周期

- **持久键值（`ctx.kv('plans')`）**：按 `conversationId` 存储 `{ mode, pendingAskId?, draft?, previousDraft?, lastProposedVersion?, approved? }`，所有状态变更均先 `flushKv()` 再同步投影或对外响应；
- **公共文档**：
  - `plan`（`ctx.sessionDoc`，`public: true, durable: false`）：按会话分片的 `PlanSessionView`（含 `awaitingApproval` 与仅在 `previousDraft.version !== draft.version` 时投影的 `previousDraft?`；内部锚点 `lastProposedVersion` 不对外投影），经专用 SSE 按需推送，不进入全局首帧；
  - `plan-badges`（`ctx.doc`，`public: true, durable: false`）：全局紧凑角标摘要（`accent` 计划中 / `warn` 等待审批 / `neutral` 已批准或已有草稿）。
- **前端界面（`packages/plugins/src/plan/client/`）**：遵循 `clientRoot` 隔离与 Fast Refresh 规范（零 Emoji），提供五个按需组件：
  - `PlanMenuItem`（`COMPOSER_MENU_SLOT`）：挂载于主输入框左下角统一 `+` 菜单内，提供带激活对勾与 `Ctrl+.` 提示的「计划模式」开关（待命页复用本地 `draftMeta`/`setDraftMeta` 零订阅切换）；
  - `PlanToolbarButton`（`COMPOSER_TOOLBAR_SLOT`）：仅在计划/待批或待命预武装激活态呈现 24px 紧凑可退出胶囊，普通态仅保留隐藏的 `Ctrl+.` 快捷键锚点以保持工具栏零冗余；
  - `PlanActiveTray`（`COMPOSER_DOCK_SLOT`）：存在草稿或等待审批时展示；桌面端（`innerWidth > 900`）在同一会话内 `awaitingApproval` 由 `false` 跃迁为 `true` 时自动展开右侧 `Plan` 面板；展开托盘内嵌可滚动 `<MarkdownText>` 计划预览；
  - `PlanWorkbenchPanel`（右侧 `plan` 面板）：展示计划正文（支持人工「编辑 / 保存」与外部版本冲突提醒）、当存在 `previousDraft` 时在卡片体内通过 `SegmentedControl` 提供「预览 / 对比 vM」切换与 `+A / -R` 行统计（采用 LCS 行级差异与 3 行上下文折叠、标题变更条及超大草稿保护提示，切换会话/进入编辑/无基线时自动复位为预览），以及准确区分「上下文交接」与「执行模型」的已批准记录；
  - `PlanToolRow`（`toolView`）：消费 `props.presentationMeta` 渲染 `plan_save` 与 `plan_propose` 的 26px `.trace-row`。
- **服务治理与事件清理**：
  - `start()` 经 `ctx.host.skills.ensureSkill` 自举受管技能 `plan`（`managedByPlugin: builtin:plan`，覆盖准入条件、只读工具、自包含计划撰写、AskDoc 审批/交接与 `get`/`toggle`/`set_mode`/`update_draft` 动作；停用插件后即时从可用技能目录消失）并从 KV 水合 `plan` 与 `plan-badges` 投影；`reconcile()` 在重启后扫描孤儿 `pendingAskId`，以 `'superseded'` 清理对应 `AskDoc` 并解除会话 `blocked`；
  - 监听 `conversation.entry`：人工 `/clear`（非本插件 `handoff` 豁免的 `pi.reset`）自动清空旧话题的计划模式、草稿与角标；时间线编辑重发（`helmx.rewind`）仅以 `'superseded'` 结算挂起 Ask 并保留计划模式与草稿；`turn_settled` 兜底清理未消费的交接豁免计数；
  - 审批等待期间停用插件触发 `liveTasks()` 硬阻断（`409 plugin_has_live_tasks`，不可 `--force`）；存在空闲 `planning` 会话时停用返回 `409 plugin_in_use`，`--force` 可强制停用并立即恢复全量工具；
  - `conversation.deleted` 事件自动取消残留审批单并清理对应 KV、`sessionDoc` 与角标条目。

## 源码与测试入口

| 内容 | 位置 |
| :--- | :--- |
| 插件入口（配置 / 动作 / 命令 / UI / 服务） | `packages/plugins/src/plan.ts` |
| 受管技能资产 | `packages/plugins/src/plan/skill/SKILL.md` |
| 契约、白名单、Schema 与边界守卫 | `packages/plugins/src/plan/contracts.ts` |
| 状态管理、KV 序列化与生命周期对账 | `packages/plugins/src/plan/state.ts` |
| 钩子注册（`input` / `before_turn` / `turn_settled` / `conversation.entry` / `conversation.deleted`） | `packages/plugins/src/plan/hooks.ts` |
| 模型工具（`plan_save` / `plan_propose`） | `packages/plugins/src/plan/tools.ts` |
| 前端组件与样式 | `packages/plugins/src/plan/client/` |
| 内核 `AskDoc` 与工具 `control` 契约 | `packages/protocol/src/ask.ts`、`packages/kernel/src/runtime/asks.ts`、`packages/kernel/src/runtime/tools/tool-result-contract.ts` |
| 单测、集成与前端 DOM 测试 | `packages/plugins/test/plan-plugin.test.ts`、`packages/plugins/test/plan-plugin.integration.test.ts`、`packages/web/test/plan-client-interactions.test.tsx` |

## 相关文档

- [插件系统设计与契约](overview.md)
- [微内核架构总览](../architecture/overview.md)
- [后端生命周期 Hook 与前端全界面扩展点](../architecture/extension-points.md)
