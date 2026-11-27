# builtin:tiers（语义模型档位与单轮模型借用）

`builtin:tiers` 解决两类协同问题：

1. **多模型按定位分工与整套切换**：用户将具体底层模型与推荐思考强度绑定为语义档位（如 `tier/scout`、`tier/coder`、`tier/senior`、`tier/architect`、`tier/reviewer`），并可将整套映射保存为多份自定义模板一键切换。
2. **双相编排档位（`kind: 'orchestrator'`，仅人类可用）**：将一组高推理模型（`Planner`：`model` / `thinkingLevel`）与一组执行性价比模型（`Executor`：`executorModel` / `executorThinkingLevel`）组合为一个语义档位 `tier/<id>`，在同一个顶层人类会话内自动完成「只读规划 -> 切模型执行 -> 步数上限或阻塞交回 -> 再规划 / 验收收尾」闭环，支持同时定义多组档位并存入模板。
3. **单轮模型借用（模型选择器「仅下一轮」模式 / `set_borrow`）与同会话模型接力（`switch_model`）**：在顶层人类直连会话中，用户或模型可临时切到任意单模型档位或具体模型完成当前回合，回合结算空闲后无损自动恢复原模型（含继承 Profile/全局默认态与自定义覆写态）；即使尚未配置任何档位，也可直接借用具体 `provider/modelId` 或唯一 `<modelId>`。

设计严格遵循**机制与策略分离**：

- **内核（`@helmx/kernel`）只保留极薄原语与只读事实**：`ModelRegistry` 保留 `tier` 命名空间，经插件宿主能力注册表消费插件通过 `ctx.provide('helmx.model-tiers', ...)` 提供的实时档位解析表（含变更通知与停用自动释放）；单模型档位在会话创建/改模型、`spawnAgent` / `fork`、上下文压缩与 `completeText` 处将 `tier/<id>` 一次性解引用并固化为真实 `provider/modelId`（保护进行中会话的 Prompt Cache，且停用插件或切换模板后既有会话继续无损运行）。针对 `kind: 'orchestrator'` 档位，内核额外提供三项通用机制：① `ModelRefResolutionMode`（`'human_conversation' | 'single_only' | 'subagent_inherit'`）保证**仅顶层人类直连会话**可持有符号化 `ConversationSummary.modelTier` 与 `modelOverride: 'tier/<id>'`，显式自动化调用（`subagent`、`workflow`、`swarm`、`compactionModel`、`switch_model`、`set_borrow`、`completeText`）统一报 `400 orchestrator_tier_human_only`，继承型子会话自动解包为具体 `executorModel`；② `ctx.host.setConversationRuntimeModel` 仅切换底层 SDK 运行模型与思考强度，不改写 `modelOverride` / `modelTier` 也不推进 `stateChangeSeq`（守护 AskDoc CAS）；③ `HookBridge` 经 SDK `afterResponse` 边界在排队 `followUp` 启动下个 run 前恢复 Planner 运行模型。
- **策略、模板、提示词、双相状态机、借用状态机与界面全部在本插件内闭环**：`builtin:workflow` 与 `builtin:swarm` 零修改、零档位硬编码；停用 `builtin:tiers` 时档位映射、设置界面、动作、CLI 命令、`switch_model` / `orch_bash` / `exit_plan_mode` / `hand_back_to_planner` 工具、模型选择器「仅下一轮」标签、目录注入与受管技能即时全部退场。

## 核心行为

1. **命名空间、解引用语义与机器不可见边界**
   - `tier` 为内核保留命名空间，不可注册同名 Provider、不可设置 `disabledModels` 或逐模型 `modelThinkingLevels`，也不允许 `tier -> tier` 嵌套引用。
   - **单模型一次性固化 vs 编排档位符号持有**：对于 `kind !== 'orchestrator'` 的单模型档位，会话创建、切换模型、`subagent` / `SubagentWorkflow` / `swarm` 派工与 `fork` 传入 `tier/<id>` 时立即解引用为真实 `provider/modelId`；对于 `kind === 'orchestrator'` 档位，仅顶层人类会话保留符号化 `modelOverride`（如显式选中）与 `modelTier: 'tier/<id>'`（不固化 `thinkingLevelOverride`），且编辑/禁用检测同时校验 `Planner` 与 `Executor` 两端模型（任一禁用报 `409 model_disabled`）。
   - **三类解析模式（机制级杜绝机器误用）**：
     - `'human_conversation'`：顶层人类会话（`parentConversationId === undefined && (ownedBy ?? 'human') === 'human'`）初始解析为 `Planner` 模型并投影 `modelTier`；
     - `'single_only'`（缺省安全模式）：显式传递到 `spawnAgent` / `workflow` / `swarm`、`defaultCompactionModel`、`completeText` 的显式 `model` 一律拒绝并报 `400 orchestrator_tier_human_only`；
     - `'subagent_inherit'`：当子代理、后台会话或 `fork` 会话继承某绑定了编排档位的 `Profile.model` / 全局 `defaultModel` 时，自动透明解包为具体 `executorModel` 且不带 `modelTier`（保证不因绑错 Profile 而阻断子代理启动）。
   - **目录与工具隐身**：`<available_model_tiers>` 系统提示词目录自动过滤一切 `kind: 'orchestrator'` 档位；管理动作保持 `exposeToPrompt: false`；`switch_model` / `set_borrow` 拒绝指向编排档位（`400 orchestrator_tier_not_borrowable`），且在已启用编排档位的会话中禁用单轮借用（`409 orchestrator_tier_active`）。
   - **符号继承**：将 `Profile.model`、`defaultModel` 或 `defaultCompactionModel` 设为单模型 `tier/<id>` 时（`compactionModel` 禁设编排档位），保存的是符号引用；切换模板或改绑档位后，未设会话覆写的会话自动对齐到新模型。
   - **思考强度优先级**：显式传入（如 `effort` / `thinkingLevel`） > 档位预设 `tier.thinkingLevel` > 逐模型默认 `modelThinkingLevels` > `Profile.thinkingLevel` > 全局默认，并按底层模型实际能力裁剪（clamp）。
   - **诚实失败**：引用不存在的档位返回 `404 model_tier_not_found`（借用解析报 `404 tier_not_found`），目标模型被禁用返回 `409 model_disabled`，绝不静默回退到默认模型。

2. **自定义多套模板（Presets）**
   - 可将当前激活档位（同时含单模型与双相编排档位，支持多组独立编排档位共存）保存为命名模板（如「主力研发」「轻量双相」），一键 `apply_template` 整体替换激活档位表。
   - 删除模板不影响当前已激活的档位映射。

3. **双相自动规划与执行编排（`kind: 'orchestrator'`）**
   - **双阶段闭环**：
     - **规划阶段（Planning，默认初始阶段）**：运行 `Planner` 模型，仅放行只读工具（`read`、`read_artifact`、`load_skill`、`ask_user`、`orch_bash`、`exit_plan_mode`），其中 `orch_bash` 复用共享引号感知只读 shell 校验器拒绝文件重定向与写命令。若问题只需直接讨论或调研，模型可直接文本作答，零切换完成回合；若需要修改工作区，模型调用 `exit_plan_mode({ plan })` 切至 `Executor` 模型并进入执行阶段（不清除同线程上下文）。
     - **执行阶段（Execution）**：放行工作区写/终端/子代理等能力（剥离规划专属工具与 `switch_model`），并按 `before_turn` 记录执行步数 `executionStepCount`（上限 `maxExecutionSteps` 0–100，默认 `30`，设 `0` 表示不限步数、不触发强制交回）。当达到正数上限时工具收拢为仅 `hand_back_to_planner` 并注入静态上限提示，强制交回 `Planner` 复盘决策；`Executor` 也可随时主动调用 `hand_back_to_planner({ reason, summary })` 请求重规划或架构仲裁。
   - **Prompt Cache 稳定**：注入的 `tiers.orchestrator.plan`、`tiers.orchestrator.execute`、`tiers.orchestrator.step_limit` 均为纯静态常量文本，绝不拼入动态步数或临时计划文本，最大限度保留同线程前缀 KV Cache 命中率。
   - **与 `/plan`、排队的 `followUp` / `steer` 共存**：`/plan` 模式严格优先生效（`plan.mode` 激活时剥离编排工具与提示段落）；`execution` 期间允许人工 `steer` 保持当前执行态；当执行态自然完成并紧随排队 `followUp` 时，`afterResponse` 会在 `followUp` 启动前将运行模型重置回 `Planner`，并按 `runKey` 变更回到 `planning` 阶段（即便 `Planner === Executor` 仅思考强度不同也可正确同步）。
   - **状态持久化**：持久化于 `ctx.kv('orchestrators')`，按会话投影至只读 `ctx.sessionDoc('orchestrator', null, { public: true, durable: false })`；会话退出编排档位、`conversation.deleted`、`pi.reset`（`/clear`）与异常停靠后均自动复位或清理。

4. **单轮模型借用与同会话接力（`switch_model`）**
   - **作用域**：严格限定于顶层人类直连会话（`parentConversationId === undefined && (ownedBy ?? 'human') === 'human'`），子代理与 `helmx` 后台会话不可见 `switch_model` 工具、不注册「仅下一轮」模式也不触发单轮借用。
   - **确定性目标解析（`resolveBorrowTarget`，0 档位与已配档位通用）**：
     1. 校验非空与可选 `effort`（非法报 `400 invalid_effort`）；
     2. `tier/<id>` 或命中已配置档位名的 `<tierId>` -> 校验档位存在（`404 tier_not_found`）及目标模型存在（`404 model_not_found`）、未禁用（`409 model_disabled`）且供应商凭据可用（`available === true`，不可用报 `409 model_unavailable`）；
     3. 精确匹配目录中的 `provider/modelId`（支持多斜杠 modelId）-> 禁用报 `409 model_disabled`，不可用报 `409 model_unavailable`；
     4. 无斜杠简写 `<modelId>` -> 启用且可用恰为 1 项则解析，>1 项报 `409 ambiguous_model_ref` 并列出候选，存在禁用匹配报 `409 model_disabled`，存在目录项但不可用报 `409 model_unavailable`，完全无匹配报 `404 model_not_found`；
     5. 其余未命中含斜杠引用 -> 报 `404 model_not_found`。
   - **多端触发方式**：
     - **界面与动作预装**：在底部模型选择器顶部切到「仅下一轮」标签选定目标，或调用 `set_borrow`（CLI `helmx tiers set-borrow`）在空闲时落盘 `phase: 'armed'`，点亮工具栏胶囊 `[ 下一轮: <label> | × ]`，下一条普通消息发送时在 `input` Hook 自动激活借用并在回合结算后恢复；
     - **待命页预装（`#/a/<profileId>`）**：在待命页底部模型选择器顶部切到「仅下一轮」标签，于本地 `draftMeta['builtin:tiers'] = { borrowModel, effort? }` 预装（不建空会话、零后端写），首条消息发出时在 `onInput` 原子激活；
     - **模型自发接力**：顶层会话模型调用 `switch_model({ model, effort?, restoreAfterTurn? })` 立即在同线程切换下一推理步模型；默认 `restoreAfterTurn: true` 回合结束后自动恢复原模型，传 `false` 则永久切换并清除借用记录。
   - **五大安全不变量**：
     1. **空闲恢复守卫**：`turn_settled` 触发 `restoreIfIdle` 时，若会话仍处于 `working` / `blocked` / `pendingAskCount > 0` / `compacting`（如排队 `followUp` 或挂起 `AskDoc`），保留 `active` 记录直到最终回合落回空闲；
     2. **CAS 快照守卫**：恢复前比对 `conv.modelOverride === record.appliedModelOverride`；若期间人工改选/清空模型或 `plan_propose` 交接改写了执行模型，仅清理借用记录绝不覆盖；`thinkingLevel` 同样按 CAS 守卫无损恢复（原为继承态时传 `''` 清空覆写）；
     3. **同轮链式切换基线保持**：同一回合内连续多次 `switch_model`（A → B → C）保留最初基线 A（绝不被中间模型 B 覆盖）；若传 `restoreAfterTurn: false` 则清除借用记录；
     4. **`onInput` 低优先级（`-200`）+ 自愈 + 忙态保护**：晚于 `builtin:plan`（`-50`）与 `builtin:swarm`（`0`）执行，避免下游短路留下孤儿借用；入口先收敛空闲残留 `active`；忙态跳过预装激活且 `set_borrow` 显式报 `409 conversation_busy`；
     5. **全生命周期自洽**：状态持久化于 `ctx.kv('borrows')` 并按会话投影至 `ctx.sessionDoc('borrow', null, { public: true, durable: false })`；`conversation.deleted` 与 `pi.reset`（`/clear`）自动清理记录；重启后 `reconcile()` 清理已删除会话记录并恢复遗留空闲 `active` 会话；存在 `active` 借用时 `inUse()` 阻止无感停用/重载。

5. **双层提示词配合（全在插件内自管）**
   - **动态精简目录（`before_turn` Hook）**：当至少存在一个可用档位且 `autoInjectCatalog: true`（默认开启）时，向系统段注入紧凑的 `<available_model_tiers>` 列表（含可用档位与 `switch_model` 简明指引）；关闭开关或无可用档位时零注入。
   - **受管技能 `model-tiers`**：经 `ctx.host.skills.ensureSkill` 自举通用多档位协同与同会话 `switch_model` 接力战法，不包含硬编码档位名或模型名。

6. **引用保护**
   - 当某档位仍被 `Profile.model`、`defaultModel` 或 `defaultCompactionModel` 引用时，删除该档位返回 `409 model_tier_in_use`，停用 `builtin:tiers` 返回 `409 plugin_in_use`（支持 `--force` 强制停用）；存在 `active` 借用记录同样在 `inUse()` 中报告占用。

## 动作与 CLI

所有能力经 `ctx.action` 单点声明，自动映射 HTTP（`POST /api/actions/builtin:tiers/<action>`）与 CLI（`helmx tiers <action>`）：

| Action | CLI | 用途 |
| :--- | :--- | :--- |
| `list` | `helmx tiers list` | 查看当前激活档位（含实时可用性与支持思考档位）及全部模板 |
| `set` | `helmx tiers set` | 新增或更新单个档位（支持 `single` 与 `orchestrator` 双相参数：`executorModel / executorThinkingLevel / maxExecutionSteps`） |
| `remove` | `helmx tiers remove` | 删除单个档位（存在符号引用时默认拒绝） |
| `replace` | —（`visibility: 'ui'`） | 原子替换整套激活档位表（供 Web 主视图编辑器调用） |
| `save_template` | `helmx tiers save-template` | 将当前激活档位（或指定映射）保存为命名模板 |
| `apply_template` | `helmx tiers apply-template` | 一键切换整套激活档位并触发继承会话重对齐 |
| `delete_template` | `helmx tiers delete-template` | 删除已保存模板 |
| `get_borrow` | `helmx tiers get-borrow --current` | 查询会话当前预装/活跃的单轮借用状态（无则返回 `null`） |
| `set_borrow` | `helmx tiers set-borrow --current --model <target> [--effort <level>]` | 为顶层空闲人类会话预装下一轮借用模型（忙时报 `409 conversation_busy`） |
| `clear_borrow` | `helmx tiers clear-borrow --current` | 取消预装，或取消活跃借用的自动恢复并留在当前模型（忙态允许） |

## Web 界面

- **模型档位主视图**（`#/s/builtin:tiers/main`）：管理激活档位（支持在单模型与双相编排 `Planner -> Executor` 模式间逐行切换、分别绑定规划/执行模型及思考强度、设置最大执行步数 0–100，默认 30，0 表示不限步数；支持一键填充推荐 5 档草稿骨架）、查看实时可用性状态、保存与一键切换自定义模板。
- **插件详情设置面板**（`settingsPanel`）：展示当前激活档位数、模板数与生效模板名，提供快捷入口跳转主视图。
- **Composer 集成**（`BorrowToolbarPill` + `useComposerModelPickerMode`）：
  - 在配置了双相编排档位的顶层人类会话中，自动禁用「仅下一轮」借用标签并渲染只读阶段胶囊（展示当前处于规划中/执行中、实时底层模型名及执行步数 `step/max`）；
  - 在可借用且非忙/非活跃态的顶层人类会话与待命页中，`BorrowToolbarPill` 通过 `useComposerModelPickerMode('tiers:one-turn', ...)` 向宿主 `ModelPickerControl` 顶部注册「仅下一轮」模式标签（选定即设下一轮借用且不改会话持久模型；每次点击底部按钮或 `Ctrl+L` 打开一律回到默认「切换模型」页防误触）；
  - 未预装且非借用中时工具栏返回 `null`（零占位 DOM、零 Tab 焦点位）；预装态展示紧凑 24px 胶囊 `[ 下一轮: <label> | × ]`（点击主体调 `openMode()` 直达「仅下一轮」标签，点击独立兄弟按钮 `×` 取消预装）；借用中展示 `[ 本轮借用: <label> | × ]`（主体禁用且不注册模式标签，点击 `×` 即使忙态也可取消自动恢复）；停用 `builtin:tiers` 后模式标签即时消失。
- **时间线工具行**（`SwitchModelToolRow` & `OrchestratorToolRow`）：`toolView`（`replaceRow: true`）消费 `presentationMeta` 渲染 26px `.trace-row`，简洁区分「单轮自动恢复 / 持久切换」及「切换执行阶段 / 交回规划阶段」。
- **共享模型选择器增强（`ModelPickerControl`）**：存在可用档位时在下拉列表顶部展示「模型档位」分组；默认 `allowOrchestratorTiers={false}` 隐藏双相编排档位（仅顶层人类对话/待命页、`Profile.model` 与全局 `defaultModel` 显式放行，且切换至「仅下一轮」等模式标签时自动过滤编排档位，全球 `defaultCompactionModel` 亦不可选）；配置具体模型目标的入口传 `allowTiers={false}` 防止递归绑定；支持可选受控 `open`/`onOpenChange`、`showResetDefault` 与 `renderTrigger`。
- **档位与按模型默认等级展示**：选中 `tier/<id>` 或具体模型后，触发按钮显示内核实际生效的等级，并按内核 clamp 规则收敛（如预设 `max` 而底层模型仅支持 `high|xhigh` 时显示 `xhigh`）。模型档位主视图中的主模型 / Planner 与 Executor 选择器以及下拉列表档位行徽章遵循 `档位预设 > 按模型默认`（`resolveDefaultChainThinkingLevel(..., 'tier')`），点击模型行主体留空 `thinkingLevel` 保持动态继承的同时如实展示当前生效的按模型默认思考等级；全局规则默认模型与 Profile 绑定遵循 `档位预设 > 按模型默认 > Profile/全局等级`；上下文压缩模型遵循 `压缩等级 > 档位预设 > 按模型默认`。共享选择器只展示调用方传入的链结果，待命页的草稿链仍为 `草稿覆盖 > 档位预设 > 按模型默认 > Profile > 全局`。模型中心「当前生效」状态行与 Profile 卡片经 `resolveDefaultChainThinkingLevel` 走同一规则。

## 源码与测试入口

| 模块 | 路径 |
| :--- | :--- |
| 内核纯解引用原语与只读覆写投影 | `packages/kernel/src/runtime/model-registry.ts`、`conversation-profile.ts`、`conversation-service.ts`、`spawn-fork.ts`、`store/conversation-repo.ts` |
| 插件后端、借用与编排状态机及校验 | `packages/plugins/src/tiers.ts`、`packages/plugins/src/tiers/contracts.ts`、`packages/plugins/src/tiers/orchestrator.ts`、`packages/plugins/src/tiers/borrow.ts`、`packages/plugins/src/tiers/validation.ts`、`packages/plugins/src/shared/read-only-shell/` |
| 插件前端 UI | `packages/plugins/src/tiers/client/`（`manager.tsx`、`settings.tsx`、`BorrowToolbarPill.tsx`、`SwitchModelToolRow.tsx`、`OrchestratorToolRow.tsx`、`borrow-models.ts`、`orchestrator-models.ts`） |
| 共享选择器扩展 | `packages/plugin-client/src/ui/ModelPicker.tsx`、`model-picker-model.ts` |
| 集成与契约测试 | `packages/plugins/test/tiers-plugin.test.ts`、`packages/plugins/test/tiers-orchestrator.integration.test.ts`、`packages/web/test/tiers-client-interactions.test.tsx`、`packages/plugin-client/test/model-picker.test.ts`、`packages/kernel/test/runtime-thinking-config.test.ts` |
