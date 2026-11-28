# builtin:duo（Planner / Executor 双相协同）

`builtin:duo` 为**顶层人类直连会话**提供透明的「只读规划 -> 原地切换执行 -> 步数上限或阻塞交回」双相闭环（`planning` <-> `execution`）：

- **Planner（规划模型）**：恒等于当前会话本身配置生效的模型（`modelOverride` -> `Profile.model` -> 全局 `defaultModel`）；
- **Executor（执行模型）**：按 **单会话覆写 > Profile 默认配置** 解析的 `executorModel`（支持具体 `provider/model` 或 `tier/<id>` 语义档位，及可选 `executorThinkingLevel` 与步数上限 `maxExecutionSteps`）。

所有运行期切换均通过内核 `ctx.host.setConversationRuntimeModel` 完成，**绝不篡改会话持久的 `modelOverride`**；配合 `tier/architect` + `tier/coder` 等语义档位，即可在不修改既有会话配置的前提下实现多模型协同与一键整体升级。

## 作用域与配置层次

1. **严格限定顶层人类会话（`DUO_ELIGIBLE_SCOPE`）**
   - 仅 `parentConversationId === undefined && (ownedBy ?? 'human') === 'human'` 的会话生效；子代理与 `ownedBy: 'helmx'` 后台会话不挂载前端入口、不订阅 `duo` `sessionDoc`，也不运行双相状态机。
2. **配置优先级与待命页预装**
   - **Profile 默认值（`set_profile` / `clear_profile`）**：持久化于 `ctx.kv('profile_configs')` 并投影到公开文档 `profiles`（`ctx.doc`）。启用后，使用该 Profile 的所有顶层人类会话自动继承 Duo 默认配置。
   - **单会话覆写（`set_conversation` / `clear_conversation`）**：持久化于 `ctx.kv('conv_configs')`，可为任意顶层会话单独开启 Duo、覆写 `executorModel` / `maxExecutionSteps`，或显式传入 `enabled: false` 关闭该会话对 Profile 的继承。
   - **待命页草稿预装（`#/a/<profileId>`）**：在未发首条消息前通过 `+` 菜单或工具栏胶囊配置 `draftMeta['builtin:duo']`（不建空会话、不标脏正文草稿），首条消息发送时由 `input` Hook（`priority: -190`）原子写入会话配置。

## 双相状态机与工具契约

状态持久化于 `ctx.kv('states')`，并按会话投影至非持久公开会话文档 `ctx.sessionDoc('duo', null, { public: true, durable: false })`：

1. **规划阶段（`phase: 'planning'`，初始默认态）**
   - 运行会话的 Planner 模型；
   - `before_turn`（`priority: -60`）收紧工具为 `DUO_PLAN_BASE_TOOL_WHITELIST`（`read`、`read_artifact`、`load_skill`、`ask_user`、`bash`、`run_action`、`exit_plan_mode`，不含 `update_steps`）叠加从 `ctx.consume('helmx.planning-orchestration-tools')` 动态收集的活跃编排工具（如启用时的 `subagent`、`SubagentWorkflow`、`workflow_steer` 与全部 `swarm_*` 工具），同时剥离 `write` / `edit` / `register_artifact` / `update_steps` / `cleanup_worktree` 等写工作区与步骤工具，并注入 `duo.plan` 系统提示段落；
   - 单线修改或收尾验收时，模型单独调用 `exit_plan_mode({ plan })` 携带实施与验证方案（含 `Re-plan if:` 条件）原地切换至 Executor；纯问答或需留在顶层统筹多线派工时直接留在规划阶段。
2. **执行阶段（`phase: 'execution'`）**
   - 原地将运行模型切换为 `executorModel`（若为 `tier/<id>` 则实时解引用；`setConversationRuntimeModel`）并开放全量写工具与 `update_steps`，同时剥离 `exit_plan_mode` 与 `ask_user`（需要向用户澄清或拍板时统一交回 Planner），注入 `duo.execute` 段落；
   - 每次执行回合在 `before_turn` 累计 `executionStepCount`（步数上限 `maxExecutionSteps` 范围 `0..100`，默认 `30`；`0` 表示不限步数）；
   - 达到正数步数上限时置 `stepLimitPaused = true`，将工具收敛为仅保留 `hand_back_to_planner` 并注入 `duo.step_limit` 提示；遇到计划偏差、阻塞或需求变更时模型主动调用 `hand_back_to_planner({ reason, summary })` 返回 Planner 复审。
3. **自动复位守卫**
   - 回合结束（`turn_settled`）、人工 `/clear`（`pi.reset`）、收到 `origin !== 'human'` 唤醒输入、会话删除（`conversation.deleted`）或插件停用/重启恢复时自动恢复至 Planner 基准并清理运行期模型覆盖。

## 跨插件协同

- **与 [`builtin:plan`](plan.md) 的协同**：
  - `builtin:plan` 在 `priority: -50` 先于 `builtin:duo`（`-60`）运行；`builtin:duo` 消费 `helmx.plan-mode-active`，当会话处于只读 `/plan` 模式时完全避让（不注入 `duo.*` 提示词或工具）；
  - 批准 `/plan` 后 `builtin:plan` 发布 `plan.approved`（`PLAN_APPROVED_EVENT`），`builtin:duo` 监听后将活跃 Duo 会话直接切入 `execution` 阶段，同时保留交接产生的 `pi.reset` 且尊重用户在审批卡中显式选择的执行模型（`planChosenModelActive`）。
- **与 [`builtin:workflow`](workflow.md) / [`builtin:swarm`](swarm.md) 的协同**：
  - `builtin:duo` 提供 `helmx.default-child-model`（`DefaultChildModelCapability`），当活跃 Duo 会话及其后代派发子代理（`subagent` / `SubagentWorkflow`）或 Swarm 成员（`swarm_dispatch_worker`）且未显式传入 `model` 时，默认继承该 Duo 会话的 `executorModel` 与 `executorThinkingLevel`（子会话不运行 Duo 状态机自身）；
  - `agent_spawn`（`priority: 100`）同时负责在 `AgentSpawnRequest` 缺省 `model` 时填充继承模型；
  - 若顶层会话带有 `swarm-coordinator` 标签，`builtin:duo` 进入**协调者让位态（`suppressedByCoordinator: true`）**：协调者自身始终保持 Planner 仅做编排（不切入自编码执行回合），同时继续通过 `helmx.default-child-model` 把 `executorModel` 下发给新派生的 Worker。
- **与 [`builtin:steps`](steps.md) 的协同**：规划阶段自动剥离 `update_steps`，进入执行阶段后恢复供 Executor 维护实时步骤清单。

## 动作与 CLI

所有动作经 `ctx.action` 单点声明（`exposeToPrompt: false`），自动映射 HTTP（`POST /api/actions/builtin:duo/<action>`）与 CLI（`helmx duo <action>`）：

| Action | CLI | 用途 |
| :--- | :--- | :--- |
| `status` | `helmx duo status [--current \| --conversation-id <id>]` | 查询会话当前生效配置、阶段、Planner/Executor 模型与步数（只读） |
| `set_conversation` | `helmx duo set-conversation [--current] --enabled <bool>` | 为单个顶层人类会话开启、配置或显式禁用 Duo（支持 `--executor-model`、`--executor-thinking-level`、`--max-execution-steps`） |
| `clear_conversation` | `helmx duo clear-conversation [--current]` | 清除单会话覆写并恢复继承 Profile 默认配置 |
| `set_profile` | `helmx duo set-profile --profile-id <id> --enabled <bool>` | 配置 Profile 级 Duo 默认执行模型与步数上限 |
| `clear_profile` | `helmx duo clear-profile --profile-id <id>` | 移除 Profile 级 Duo 配置 |

## Web 界面（`packages/plugins/src/duo/client/`）

- **`DuoProfileSection`（`PROFILE_DETAIL_SECTION_SLOT`）**：在 Profile 编辑抽屉内嵌入双相开关、Executor `ModelPickerControl`（支持选 `tier/<id>`）与步数上限表单；新建未保存 Profile 时展示友好引导。
- **`DuoMenuItem`（`COMPOSER_MENU_SLOT`）**：在主输入框左下角 `+` 菜单提供「双相协同」开关（对子会话与 `ownedBy: 'helmx'` 会话返回 `null`）。
- **`DuoToolbarPill` & `DuoSetupDialog`（`COMPOSER_TOOLBAR_SLOT`）**：仅当 Duo 激活（或被协调者让位）时在工具栏显示紧凑 `22px` 胶囊（`规划` / `执行 步数/上限` / `协调`），点击弹出 Radix Popover 支持实时切换 Executor 模型、恢复 Profile 默认或关闭本会话 Duo；初次开启无预设执行模型时唤起 `DuoSetupDialog`。
- **`DuoTransitionToolRow`（`toolView`, `replaceRow: true`）**：消费 `presentationMeta` 渲染 `exit_plan_mode` 与 `hand_back_to_planner` 的 `26px` `.trace-row` 切换轨迹。

## 源码与测试入口

| 内容 | 位置 |
| :--- | :--- |
| 插件入口、动作、工具与事件订阅 | `packages/plugins/src/duo.ts` |
| 契约、Schema 与白名单 | `packages/plugins/src/duo/contracts.ts` |
| 双相状态机与运行期调度 | `packages/plugins/src/duo/orchestrator.ts` |
| 受管技能 `duo` | `packages/plugins/src/duo/skill/SKILL.md` |
| 前端组件与样式 | `packages/plugins/src/duo/client/` |
| 后端单测、跨插件与前端 DOM 测试 | `packages/plugins/test/duo-plugin.test.ts`、`packages/plugins/test/steps-plugin.integration.test.ts`、`packages/web/test/duo-client-interactions.test.tsx` |

## 相关文档

- [模型档位插件（`builtin:tiers`）](tiers.md)：`tier/<id>` 语义档位与模板切换
- [计划模式插件（`builtin:plan`）](plan.md)：`/plan` 只读审批与 `plan.approved` 协作
- [工作流与子代理编排](workflow.md) · [Swarm 对等协同](swarm.md)：`helmx.default-child-model` 默认模型继承
