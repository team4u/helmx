# builtin:tiers（语义模型档位与预设模板）

`builtin:tiers` 聚焦**纯语义模型档位映射与编制模板（1 tier = 1 concrete model）**：用户将底层具体模型与推荐思考强度绑定为稳定的语义代号（如 `tier/scout`、`tier/coder`、`tier/senior`、`tier/architect`、`tier/reviewer`），并可将整套映射保存为多份预设模板一键切换。

> 单轮临时切模型已收敛至内核 `submitInput` 与 Web 模型选择器顶部「仅下一轮」标签（`helmx send --model ... --thinking ...`）；规划/执行双相模型编排由 [`builtin:duo`](duo.md) 独立承载。

设计严格遵循**机制与策略分离**：

- **内核（`@helmx/kernel`）只保留极薄 `tier` 命名空间原语**：`ModelRegistry` 经 `PluginHost` 消费插件通过 `ctx.provide('helmx.model-tiers', ...)` 提供的只读映射表（含变更通知与停用自动释放），并在会话创建/改模型、`spawnAgent` / `fork`、上下文压缩与 `completeText` 处将 `tier/<id>` 一次性解引用并固化为真实 `provider/modelId`（保护进行中会话的 Prompt Cache，停用插件或切换模板后既有会话继续无损运行）。
- **模板、提示词目录、受管技能与管理界面在本插件内闭环**：停用 `builtin:tiers` 时档位映射、设置界面、动作、CLI、`helmx.search` 检索、`<available_model_tiers>` 目录与 `model-tiers` 受管技能即时全部退场。

## 核心行为

1. **命名空间、固化与符号继承**
   - `tier` 为内核保留命名空间，不可注册同名 Provider、不可设置 `disabledModels` 或逐模型 `modelThinkingLevels`，也不允许 `tier -> tier` 嵌套引用（`set` / `replace` 强校验拒绝自引与未包含 `/` 的非法引用）。
   - **会话固化 vs 符号继承**：在具体会话上选用普通单模型档位 `tier/<id>` 或经 `subagent` / `swarm` / `fork` 派工时，内核立即将其解引用并固化为真实 `provider/modelId`；而在 `Profile.model`、`defaultModel`、`defaultCompactionModel`、`preserveRef: true` 档位（如 [`builtin:duo`](duo.md) 编排器）或编排器的 `plannerModel` / `executorModel` 中绑定 `tier/<id>` 时保留符号引用——切换模板或更新档位后，相关配置与未设覆写的会话及编排器自动对齐到新模型。
   - **思考强度优先级**：显式传入（如 `thinkingLevel` / `effort`）> 档位预设 `tier.thinkingLevel` > 逐模型默认 `modelThinkingLevels` > `Profile.thinkingLevel` > 全局默认，并按底层模型实际能力裁剪（clamp）。
   - **诚实失败**：引用不存在的档位返回 `404 model_tier_not_found`，目标模型被禁用返回 `409 model_disabled`，绝不静默回退到默认模型。

2. **自定义多套模板（Presets）**
   - 可将当前激活档位保存为命名模板（`save_template`），通过 `apply_template` 原子替换当前激活档位表，并同步触发符号继承对齐。
   - 删除模板（`delete_template`）不影响当前已激活的档位映射。

3. **目录注入与受管技能**
   - **动态目录（`before_turn` Hook）**：当至少存在一个可用且 `singleTurnEligible !== false` 的档位且 `autoInjectCatalog: true`（默认开启）时，向系统段注入紧凑的 `<available_model_tiers>` 列表（自动排除 [`builtin:duo`](duo.md) 编排器等仅顶层可用的 `tier/<id>`）；关闭开关或无可用单轮档位时零注入。
   - **受管技能 `model-tiers`**：经 `ctx.host.skills.ensureSkill` 自举通用多档位分工指南，不包含硬编码档位名或具体供应商模型名。

4. **引用保护与搜索**
   - 当档位仍被 `Profile.model`、`defaultModel` 或 `defaultCompactionModel` 引用时，删除该档位返回 `409 model_tier_in_use`（传 `force: true` 可绕过），停用 `builtin:tiers` 返回 `409 plugin_in_use`（支持 `--force`）。
   - 插件同时提供 `helmx.search` 搜索实现，将激活档位（直达 `?edit=<id>`）与已保存模板（直达 `?tab=templates`）接入全局 Omnibox 联合检索。

## 动作与 CLI

所有能力经 `ctx.action` 单点声明（均设 `exposeToPrompt: false`），自动映射 HTTP（`POST /api/actions/builtin:tiers/<action>`）与 CLI（`helmx tiers <action>`）：

| Action | CLI | 用途 |
| :--- | :--- | :--- |
| `list` | `helmx tiers list` | 查看当前激活档位（含实时可用性与支持思考档位）及全部模板 |
| `set` | `helmx tiers set --id <id> --model <provider/model>` | 新增或更新单个档位（可选 `--thinking-level`、`--description`） |
| `remove` | `helmx tiers remove --id <id>` | 删除单个档位（存在符号引用时默认拒绝，可选 `--force`） |
| `replace` | —（`visibility: 'ui'`） | 原子替换整套激活档位表（供 Web 主视图编辑器调用） |
| `save_template` | `helmx tiers save-template --id <id> --name <name>` | 将当前激活档位（或指定映射）保存为命名模板 |
| `apply_template` | `helmx tiers apply-template --id <id>` | 一键切换整套激活档位并触发继承会话重对齐 |
| `delete_template` | `helmx tiers delete-template --id <id>` | 删除已保存模板 |

## Web 界面

- **模型档位主视图**（`#/views/builtin:tiers/main`）：采用「页头动作 + 居中有界单列发丝分割列表（`.tiers-list`）+ 右侧详情抽屉（`DetailDrawer`，桌面 520px）」布局，提供「档位 / 模板」分段切换与搜索栏；空态提供推荐 5 档（`scout / coder / senior / architect / reviewer`）起步列表行，点击任一档位行或「新增档位」滑出抽屉配置单一目标模型与思考强度，单条调用 `set` / `remove` 实时落盘；模板页展示模板快照、一键应用、删除与「存为模板」弹窗。
- **插件详情设置面板**（`settingsPanel`）：展示当前激活档位数、模板数与生效模板名，提供跳转主视图入口。
- **共享模型选择器增强（`ModelPickerControl`）**：存在可用档位时在下拉列表顶部展示「模型档位」分组；需要绑定具体模型目标的入口（如档位抽屉内部）传 `allowTiers={false}` 防止 `tier -> tier` 递归绑定；配合宿主内置的「切换模型 / 仅下一轮」顶部标签与 `resolveDefaultChainThinkingLevel` 一致展示夹紧后的生效思考等级。

## 源码与测试入口

| 模块 | 路径 |
| :--- | :--- |
| 内核档位解析与引用投影 | `packages/kernel/src/runtime/model-registry.ts`、`conversation-profile.ts` |
| 插件后端与校验 | `packages/plugins/src/tiers.ts`、`packages/plugins/src/tiers/contracts.ts`、`packages/plugins/src/tiers/validation.ts`、`packages/plugins/src/tiers/assets.ts` |
| 插件前端 UI | `packages/plugins/src/tiers/client/`（`manager.tsx`、`TierDetailDrawer.tsx`、`SaveTemplateDialog.tsx`、`settings.tsx`、`models.ts`、`copy.ts`、`styles.css`） |
| 共享选择器扩展 | `packages/plugin-client/src/ui/ModelPicker.tsx`、`model-picker-model.ts` |
| 测试 | `packages/plugins/test/tiers-plugin.test.ts`、`packages/plugins/test/omnibox-search.test.ts`、`packages/web/test/tiers-client-interactions.test.tsx`、`packages/plugin-client/test/model-picker.test.ts` |

## 相关文档

- [编排器插件（`builtin:duo`）](duo.md)：Planner / Executor 编排器切换与 `tier/<id>` 协同
- [CLI 命令参考](../cli/reference.md)：`helmx send --model` 单轮模型临时覆盖
