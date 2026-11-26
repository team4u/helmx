# builtin:tiers（语义模型档位与单轮模型借用）

`builtin:tiers` 解决两类协同问题：

1. **多模型按定位分工与整套切换**：用户将具体底层模型与推荐思考强度绑定为语义档位（如 `tier/scout`、`tier/coder`、`tier/senior`、`tier/architect`、`tier/reviewer`），并可将整套映射保存为多份自定义模板一键切换。
2. **单轮模型借用（模型选择器「仅下一轮」模式 / `set_borrow`）与同会话模型接力（`switch_model`）**：在顶层人类直连会话中，用户或模型可临时切到任意档位或具体模型完成当前回合，回合结算空闲后无损自动恢复原模型（含继承 Profile/全局默认态与自定义覆写态）；即使尚未配置任何档位，也可直接借用具体 `provider/modelId` 或唯一 `<modelId>`。

设计严格遵循**机制与策略分离**：

- **内核（`@helmx/kernel`）只保留极薄原语与只读事实**：`ModelRegistry` 保留 `tier` 命名空间，经插件宿主能力注册表消费插件通过 `ctx.provide('helmx.model-tiers', ...)` 提供的实时档位解析表（含变更通知与停用自动释放）；在会话创建/改模型、`spawnAgent` / `fork`、上下文压缩与 `completeText` 处将 `tier/<id>` 一次性解引用并固化为真实 `provider/modelId`（保护进行中会话的 Prompt Cache，且停用插件或切换模板后既有会话继续无损运行）；`ConversationSummary.modelOverride` 仅暴露会话当前显式模型覆写（与 `thinkingLevelOverride` 对称），内核对借用状态机零感知。
- **策略、模板、提示词、借用状态机与界面全部在本插件内闭环**：`builtin:workflow` 与 `builtin:swarm` 零修改、零档位硬编码；停用 `builtin:tiers` 时档位映射、设置界面、动作、CLI 命令、`switch_model` 工具、模型选择器「仅下一轮」标签、目录注入与受管技能即时全部退场。

## 核心行为

1. **命名空间与解引用语义**
   - `tier` 为内核保留命名空间，不可注册同名 Provider、不可设置 `disabledModels` 或逐模型 `modelThinkingLevels`，也不允许 `tier -> tier` 嵌套引用。
   - **一次性固化**：在会话创建、切换模型、`subagent` / `SubagentWorkflow` / `swarm` 派工与 `fork` 传入 `tier/<id>` 时，内核立即解引用为真实 `provider/modelId` 并落盘为会话覆写。
   - **符号继承**：将 `Profile.model`、`defaultModel` 或 `defaultCompactionModel` 设为 `tier/<id>` 时，保存的是符号引用；切换模板或改绑档位后，未设会话覆写的会话自动对齐到新模型。
   - **思考强度优先级**：显式传入（如 `effort` / `thinkingLevel`） > 档位预设 `tier.thinkingLevel` > 逐模型默认 `modelThinkingLevels` > `Profile.thinkingLevel` > 全局默认，并按底层模型实际能力裁剪（clamp）。
   - **诚实失败**：引用不存在的档位返回 `404 model_tier_not_found`（借用解析报 `404 tier_not_found`），目标模型被禁用返回 `409 model_disabled`，绝不静默回退到默认模型。

2. **自定义多套模板（Presets）**
   - 可将当前激活档位保存为命名模板（如「主力研发」「极简省钱」「纯直连容灾」），一键 `apply_template` 整体替换激活档位表。
   - 删除模板不影响当前已激活的档位映射。

3. **单轮模型借用与同会话接力（`switch_model`）**
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

4. **双层提示词配合（全在插件内自管）**
   - **动态精简目录（`before_turn` Hook）**：当至少存在一个可用档位且 `autoInjectCatalog: true`（默认开启）时，向系统段注入紧凑的 `<available_model_tiers>` 列表（含可用档位与 `switch_model` 简明指引）；关闭开关或无可用档位时零注入。
   - **受管技能 `model-tiers`**：经 `ctx.host.skills.ensureSkill` 自举通用多档位协同与同会话 `switch_model` 接力战法，不包含硬编码档位名或模型名。

5. **引用保护**
   - 当某档位仍被 `Profile.model`、`defaultModel` 或 `defaultCompactionModel` 引用时，删除该档位返回 `409 model_tier_in_use`，停用 `builtin:tiers` 返回 `409 plugin_in_use`（支持 `--force` 强制停用）；存在 `active` 借用记录同样在 `inUse()` 中报告占用。

## 动作与 CLI

所有能力经 `ctx.action` 单点声明，自动映射 HTTP（`POST /api/actions/builtin:tiers/<action>`）与 CLI（`helmx tiers <action>`）：

| Action | CLI | 用途 |
| :--- | :--- | :--- |
| `list` | `helmx tiers list` | 查看当前激活档位（含实时可用性与支持思考档位）及全部模板 |
| `set` | `helmx tiers set` | 新增或更新单个档位（`id / model / thinkingLevel / description`） |
| `remove` | `helmx tiers remove` | 删除单个档位（存在符号引用时默认拒绝） |
| `replace` | —（`visibility: 'ui'`） | 原子替换整套激活档位表（供 Web 主视图编辑器调用） |
| `save_template` | `helmx tiers save-template` | 将当前激活档位（或指定映射）保存为命名模板 |
| `apply_template` | `helmx tiers apply-template` | 一键切换整套激活档位并触发继承会话重对齐 |
| `delete_template` | `helmx tiers delete-template` | 删除已保存模板 |
| `get_borrow` | `helmx tiers get-borrow --current` | 查询会话当前预装/活跃的单轮借用状态（无则返回 `null`） |
| `set_borrow` | `helmx tiers set-borrow --current --model <target> [--effort <level>]` | 为顶层空闲人类会话预装下一轮借用模型（忙时报 `409 conversation_busy`） |
| `clear_borrow` | `helmx tiers clear-borrow --current` | 取消预装，或取消活跃借用的自动恢复并留在当前模型（忙态允许） |

## Web 界面

- **模型档位主视图**（`#/s/builtin:tiers/main`）：管理激活档位（支持一键填充推荐 5 档草稿骨架后，通过共享 `ModelPickerControl` 一体化选择卡逐行选定底层模型与思考强度）、查看实时可用性状态、保存与一键切换自定义模板。
- **插件详情设置面板**（`settingsPanel`）：展示当前激活档位数、模板数与生效模板名，提供快捷入口跳转主视图。
- **Composer 单轮借用集成**（`BorrowToolbarPill` + `useComposerModelPickerMode`）：
  - 在可借用且非忙/非活跃态的顶层人类会话与待命页中，`BorrowToolbarPill` 通过 `useComposerModelPickerMode('tiers:one-turn', ...)` 向宿主 `ModelPickerControl` 顶部注册「仅下一轮」模式标签（选定即设下一轮借用且不改会话持久模型；每次点击底部按钮或 `Ctrl+L` 打开一律回到默认「切换模型」页防误触）；
  - 未预装且非借用中时工具栏返回 `null`（零占位 DOM、零 Tab 焦点位）；预装态展示紧凑 24px 胶囊 `[ 下一轮: <label> | × ]`（点击主体调 `openMode()` 直达「仅下一轮」标签，点击独立兄弟按钮 `×` 取消预装）；借用中展示 `[ 本轮借用: <label> | × ]`（主体禁用且不注册模式标签，点击 `×` 即使忙态也可取消自动恢复）；停用 `builtin:tiers` 后模式标签即时消失。
- **时间线工具行**（`SwitchModelToolRow`）：`toolView`（`replaceRow: true`）消费 `presentationMeta` 渲染 26px `.trace-row`，简洁区分「单轮自动恢复」与「持久切换」。
- **共享模型选择器增强（`ModelPickerControl`）**：存在可用档位时在下拉列表顶部展示「模型档位」分组；配置具体模型目标的入口传 `allowTiers={false}` 防止递归绑定；支持可选受控 `open`/`onOpenChange`、`showResetDefault` 与 `renderTrigger`。
- **档位与按模型默认等级展示**：选中 `tier/<id>` 或具体模型后，触发按钮显示内核实际生效的等级，并按内核 clamp 规则收敛（如预设 `max` 而底层模型仅支持 `high|xhigh` 时显示 `xhigh`）。全局规则默认模型与 Profile 绑定遵循 `档位预设 > 按模型默认 > Profile/全局等级`；上下文压缩模型遵循 `压缩等级 > 档位预设 > 按模型默认`。共享选择器只展示调用方传入的链结果，待命页的草稿链仍为 `草稿覆盖 > 档位预设 > 按模型默认 > Profile > 全局`。模型中心「当前生效」状态行与 Profile 卡片经 `resolveDefaultChainThinkingLevel` 走同一规则。

## 源码与测试入口

| 模块 | 路径 |
| :--- | :--- |
| 内核纯解引用原语与只读覆写投影 | `packages/kernel/src/runtime/model-registry.ts`、`conversation-profile.ts`、`conversation-service.ts`、`spawn-fork.ts`、`store/conversation-repo.ts` |
| 插件后端、借用状态机与校验 | `packages/plugins/src/tiers.ts`、`packages/plugins/src/tiers/contracts.ts`、`packages/plugins/src/tiers/borrow.ts`、`packages/plugins/src/tiers/validation.ts`、`packages/plugins/src/tiers/assets.ts` |
| 插件前端 UI | `packages/plugins/src/tiers/client/`（`manager.tsx`、`settings.tsx`、`BorrowToolbarPill.tsx`、`SwitchModelToolRow.tsx`、`borrow-models.ts`） |
| 共享选择器扩展 | `packages/plugin-client/src/ui/ModelPicker.tsx`、`model-picker-model.ts` |
| 集成与契约测试 | `packages/plugins/test/tiers-plugin.test.ts`、`packages/web/test/tiers-client-interactions.test.tsx`、`packages/kernel/test/runtime-thinking-config.test.ts` |
