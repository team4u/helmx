# builtin:duo（编排器 / Orchestrator）

`builtin:duo` 为顶层人类会话提供**只读规划（Planner）与工作区落地执行（Executor）**的双相协同编排：用户将「规划模型 + 执行模型 + 步数预算」定义为可复用的**编排器（Orchestrator）**，并挂载为模型选择器中的一级模型档位（`tier/<id>`）。

> 相关指南：[语义模型档位（`builtin:tiers`）](tiers.md) · [多模型协同扩展点](../architecture/extension-points.md)

## 设计定位

- **编排器即一级档位（`tier/<id>`）**：每个编排器通过 `ctx.provide('helmx.model-tiers', ...)` 挂载到内核 `ModelRegistry`（`preserveRef: true`、`singleTurnEligible: false`、`displayGroup: 'duo'`）：
  - 在主模型选择器顶部以**编排器**（`Orchestrator`）分组展示（`Planner → Executor` 摘要），可直接绑定到具体会话、Profile 或全局默认；
  - 对顶层人类会话保留 `tier/<id>` 符号引用（存入运行期 `effectiveModelRef`），主输入栏 `ModelPicker` 在规划与执行切换期间始终稳定显示该编排器，避免模型名跳变；
  - `singleTurnEligible: false` 保证编排器仅用于顶层协同会话，绝不泄漏到单轮「仅本轮」标签页或子代理 `<available_model_tiers>` 目录；
  - 编排器自身的 `plannerModel` 与 `executorModel` 可直接指定 `provider/modelId`，也可引用 [`builtin:tiers`](tiers.md) 等外部提供方的单模型档位（`tier/<id>`，禁止嵌套引用自身或其他编排器）；外部档位尚未挂载时自动从 `getTiers()` 暂隐，上线或模板切换后即时串联生效且无循环通知。
- **规划与执行自动轮替**：
  - **规划阶段（Planning Phase）**：使用 Planner 模型与只读工具白名单（保留 `READ_ONLY_PLANNING_BASE_TOOLS`、`exit_plan_mode` 及通过 `helmx.planning-orchestration-tools` 动态放行的 `subagent` / `SubagentWorkflow` / `swarm_*` 等编排工具），并注入 `<section id="duo.plan">`；
  - **工具切相（`exit_plan_mode({ plan })`）**：由 Planner 单独调用，原子通过 `setConversationRuntimeModel` 原位切换至 Executor 模型与思考强度，进入 **Execution Phase**（注入 `<section id="duo.execute">` 并按轮递增步数）；
  - **自动复位与显式退回**：达到 `maxExecutionSteps`（默认 `30`，`0` 表示不限）后暂停工作区写工具并注入 `<section id="duo.step_limit">` 要求 Executor 调用 `hand_back_to_planner({ reason, summary })`；正常回合结束（`turn_settled`）、`pi.reset` 或显式 `hand_back_to_planner` 均自动复位为 Planner 与规划阶段。
- **单会话临时覆盖（`override_executor`）**：可在 Composer 底部状态行（`COMPOSER_STATUS_SLOT`）编排器胶囊弹窗中针对当前会话临时更换 Executor（同样支持选单模型 `tier/<id>`）而**不改写底层编排器配置**；当会话切离当前编排器或更换为其他模型时，临时覆盖自动清理。

## 跨插件与安全边界

- **归属权与会话边界**：仅作用于顶层 `ownedBy: 'human'` 会话（`DUO_ELIGIBLE_SCOPE`）；待命草稿、子会话与 `ownedBy: 'helmx'` 自动化会话在客户端状态行守卫层提前 `return null`，零无效 `sessionDoc` 订阅、零与待命模型选择器重复展示。
- **子代理 / Swarm 默认执行模型（`helmx.default-child-model`）**：向 `PluginHost` 暴露 `resolveDefaultChildModel(parentConversationId)` 并在 `agent_spawn` Hook（`priority: 100`）解析以下两种场景且省略显式 `model` 的子代理请求：
  1. 子请求的 `agentType` 指向绑定了 `tier/<id>` 编排器的 Profile；
  2. 沿父会话链可追溯到活跃编排器会话树（直接映射到其有效 Executor 模型与思考强度）。
- **Swarm 协调者让位（`swarm-coordinator`）**：带 `swarm-coordinator` 标签的顶层会话（`suppressedByCoordinator: true`）保持 Planner 运行并隐藏 `exit_plan_mode` / `hand_back_to_planner` 与 `<duo_*>` 段落，同时继续通过 `helmx.default-child-model` 把 Executor 透传给新派发的 Worker。
- **`/plan` 协同（[`builtin:plan`](plan.md)）**：`/plan` 只读规划回合先于 `builtin:duo` 运行，后者消费 `helmx.plan-mode-active` 避让；待用户审批触发 `plan.approved`（`PLAN_APPROVED_EVENT`）后自动切入 Execution Phase 并尊重审批时用户显式改选的模型（`planChosenModelActive`）。
- **引用保护与生命周期收敛**：删除仍被全局 `defaultModel`、`defaultCompactionModel`、`Profile.model` 或顶层会话引用的编排器返回 `409 model_tier_in_use`（支持 `--force` / 二次确认强删）；存在活跃引用时停用 `builtin:duo` 返回 `409 plugin_in_use`（支持 `--force`）；崩溃或强制停用遗留的运行期模型覆写会在下次 `reconcile()`（`reconcileAfter: ['builtin:tiers']`）及会话清理时安全复位。

## 动作、HTTP 与 CLI

所有动作经 `ctx.action` 单点声明（`exposeToPrompt: false`），自动映射 HTTP（`POST /api/actions/builtin:duo/<action>`）与 CLI（`helmx duo <action>`）：

| Action | CLI | 说明 |
| :--- | :--- | :--- |
| `list` | `helmx duo list` | 列出全部编排器及解析后的 Planner/Executor 可用状态（`idempotent: true`） |
| `get` | `helmx duo get --id <id>` | 按 ID 查看单个编排器与实时解析结果（`idempotent: true`） |
| `set` | `helmx duo set --id <id> --name <name> --planner-model <ref> --executor-model <ref>` | 新增或更新编排器（校验 ID 冲突、禁止编排器嵌套及禁用模型；支持 `--planner-thinking-level`、`--executor-thinking-level`、`--max-execution-steps`、`--description`） |
| `remove` | `helmx duo remove --id <id> [--force]` | 删除编排器；存在符号引用时默认返回 `409 model_tier_in_use`，`--force` 强删并清理关联临时覆盖 |
| `status` | `helmx duo status [--current \| --conversation-id <id>]` | 查询会话当前实时相态、编排器、步数及临时覆盖状态（`idempotent: true`）；同构只读端点 `GET /api/plugins/builtin%3Aduo/routes/status/:conversationId` |
| `override_executor` | `helmx duo override-executor [--current] --executor-model <ref>` | 为活跃编排器会话设置临时 Executor 模型、思考深度或步数上限 |
| `clear_override` | `helmx duo clear-override [--current]` | 清除当前会话的临时 Executor 覆盖，恢复编排器默认值 |

## 界面与 Omnibox 检索

遵循 Helmx Quiet Surface 与模块化独立入口规范：

- **`DuoManagerScreen`（`manager.tsx`，`sidebarItem` order 17）**：全站标准 `<Screen layout="contained" toolbar>` + 状态筛选 `Tabs(variant="pills")`（全部 / 就绪 / 异常）+ `SearchBox(variant="toolbar", size="sm")` + `<List>` / `<ListRow>` 单列发丝分割列表（直观展示 `tier/<id>`、`Planner → Executor` 流、步数上限与可用状态 `StatusLight`），空态提供推荐起步列表行；搭配右侧 `DuoDetailDrawer`（`useScreenDrawer` 驱动创建/编辑、`.duo-orchestrator-fields` 分组框、`<MonoId>` 标识行、`Cmd/Ctrl + Enter` 提交与 `ConfirmDialog` 删除/强删确认）。
- **`DuoSettingsPanel`（`settings.tsx`，`settingsPanel` order 27）**：在设置中心展示当前编排器总数/就绪数及 `<List density="compact">` 摘要列表，并提供直达 `screen:builtin:duo/main` 的入口。
- **`DuoToolbarPill`（`index.tsx`，`COMPOSER_STATUS_SLOT`）**：挂载于输入框下方状态行，以极简 22px `.helmx-toolbar-pill` 展示 `规划 · <planner>` / `执行 · <executor>` / `协调 · <planner>`（仅步数暂停告警时切 `--warn`）；点击弹出 `Popover` 查看 `<MonoId>`、只读规划模型、交互式执行模型 `ModelPickerControl` 临时覆盖、恢复默认、执行步数计数与跳转编辑入口；待命草稿与非顶层人类会话直接返回 `null`。
- **`DuoTransitionToolRow`（`index.tsx`，`toolView` `replaceRow: true`）**：在时间线以 26px `.trace-row` 紧凑渲染 `exit_plan_mode`（切换执行阶段）/ `hand_back_to_planner`（交回规划阶段）切相轨迹、目标阶段徽标、状态灯、耗时与报错摘要。
- **Omnibox 动态检索（`helmx.search`）**：按编排器名称、`tier/<id>` 与底层模型 ref 实时索引（面包屑 `编排器` / `Orchestrator`），命中条目直达 `screen:builtin:duo/main?edit=<id>`（另注导航命令 `duo-create` -> `?create=1`）。

## 代码位置

| 模块 | 路径 |
| :--- | :--- |
| 插件入口与动作/UI 声明 | `packages/plugins/src/duo.ts` |
| 契约、校验与外部档位解析 | `packages/plugins/src/duo/contracts.ts` |
| 双相状态机、挂载调度与回收 | `packages/plugins/src/duo/orchestrator.ts` |
| 受管技能 `duo` | `packages/plugins/src/duo/skill/SKILL.md` |
| 前端模块（状态行胶囊 / 管理页 / 设置面板） | `packages/plugins/src/duo/client/{index.tsx,manager.tsx,DuoDetailDrawer.tsx,settings.tsx,DuoToolbarPill.tsx,DuoTransitionToolRow.tsx,models.ts,copy.ts,styles.css}` |
| 测试 | `packages/plugins/test/duo-plugin.test.ts`、`packages/plugins/test/duo-plugin.integration.test.ts`、`packages/plugins/test/omnibox-search.test.ts`、`packages/web/test/duo-client-interactions.test.tsx` |
