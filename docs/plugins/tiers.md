# builtin:tiers（语义模型档位）

`builtin:tiers` 解决「多模型按定位分工且可整体切换」的问题：用户将具体底层模型与推荐思考强度绑定为语义档位（如 `tier/scout`、`tier/coder`、`tier/senior`、`tier/architect`、`tier/reviewer`），并可将整套映射保存为多份自定义模板一键切换。

设计严格遵循**机制与策略分离**：

- **内核（`@helmx/kernel`）只保留极薄解引用原语**：`ModelRegistry` 保留 `tier` 命名空间，经插件宿主能力注册表消费插件通过 `ctx.provide('helmx.model-tiers', ...)` 提供的实时档位解析表（含变更通知与停用自动释放）；在会话创建/改模型、`spawnAgent` / `fork`、上下文压缩与 `completeText` 处将 `tier/<id>` 一次性解引用并固化为真实 `provider/modelId`（保护进行中会话的 Prompt Cache，且停用插件或切换模板后既有会话继续无损运行）。
- **策略、模板、提示词与界面全部在本插件内闭环**：`builtin:workflow` 与 `builtin:swarm` 零修改、零档位硬编码；停用 `builtin:tiers` 时档位映射、设置界面、动作、CLI 命令、目录注入与受管技能即时全部退场。

## 核心行为

1. **命名空间与解引用语义**
   - `tier` 为内核保留命名空间，不可注册同名 Provider、不可设置 `disabledModels` 或逐模型 `modelThinkingLevels`，也不允许 `tier -> tier` 嵌套引用。
   - **一次性固化**：在会话创建、切换模型、`subagent` / `SubagentWorkflow` / `swarm` 派工与 `fork` 传入 `tier/<id>` 时，内核立即解引用为真实 `provider/modelId` 并落盘为会话覆写。
   - **符号继承**：将 `Profile.model`、`defaultModel` 或 `defaultCompactionModel` 设为 `tier/<id>` 时，保存的是符号引用；切换模板或改绑档位后，未设会话覆写的会话自动对齐到新模型。
   - **思考强度优先级**：显式传入（如 `effort` / `thinkingLevel`） > 档位预设 `tier.thinkingLevel` > 逐模型默认 `modelThinkingLevels` > `Profile.thinkingLevel` > 全局默认，并按底层模型实际能力裁剪（clamp）。
   - **诚实失败**：引用不存在的档位返回 `404 model_tier_not_found`，目标模型被禁用返回 `409 model_disabled`，绝不静默回退到默认模型。

2. **自定义多套模板（Presets）**
   - 可将当前激活档位保存为命名模板（如「主力研发」「极简省钱」「纯直连容灾」），一键 `apply_template` 整体替换激活档位表。
   - 删除模板不影响当前已激活的档位映射。

3. **双层提示词配合（全在插件内自管）**
   - **动态精简目录（`before_turn` Hook）**：当至少存在一个可用档位且 `autoInjectCatalog: true`（默认开启）时，向系统段注入紧凑的 `<available_model_tiers>` 列表（仅包含当前可用且未禁用的档位），使主控零额外轮次即可直接选用 `tier/<id>`；关闭开关或无可用档位时零注入。
   - **受管技能 `model-tiers`**：经 `ctx.host.skills.ensureSkill` 自举通用多档位协同战法（按档位定位做探索 → 主力实现 → Gate 失败梯级升级 → 异构盲审 / `fork` 会诊），不包含硬编码档位名或模型名。

4. **引用保护**
   - 当某档位仍被 `Profile.model`、`defaultModel` 或 `defaultCompactionModel` 引用时，删除该档位返回 `409 model_tier_in_use`，停用 `builtin:tiers` 返回 `409 plugin_in_use`（支持 `--force` 强制停用）。

## 动作与 CLI

所有能力经 `ctx.action` 单点声明，自动映射 HTTP（`POST /api/actions/builtin:tiers/<action>`）与 CLI（`helmx tiers <action>`）：

| Action | CLI | 用途 |
| :--- | :--- | :--- |
| `list` | `helmx tiers list` | 查看当前激活档位（含实时可用性与支持思考档位）及全部模板 |
| `set` | `helmx tiers set` | 新增或更新单个档位（`id / model / thinkingLevel / description`） |
| `remove` | `helmx tiers remove` | 删除单个档位（存在符号引用时默认拒绝） |
| `replace` | `helmx tiers replace` | 原子替换整套激活档位表 |
| `save_template` | `helmx tiers save_template` | 将当前激活档位（或指定映射）保存为命名模板 |
| `apply_template` | `helmx tiers apply_template` | 一键切换整套激活档位并触发继承会话重对齐 |
| `delete_template` | `helmx tiers delete_template` | 删除已保存模板 |

## Web 界面

- **模型档位主视图**（`#/s/builtin:tiers/main`）：管理激活档位（支持一键填充推荐 5 档草稿骨架后，通过共享 `ModelPickerControl` 一体化选择卡逐行选定底层模型与思考强度）、查看实时可用性状态、保存与一键切换自定义模板。
- **插件详情设置面板**（`settingsPanel`）：展示当前激活档位数、模板数与生效模板名，提供快捷入口跳转主视图。
- **共享模型选择器增强（`ModelPickerControl`）**：存在可用档位时在下拉列表顶部展示「模型档位」分组；配置具体模型目标的入口传 `allowTiers={false}` 防止递归绑定。

## 源码与测试入口

| 模块 | 路径 |
| :--- | :--- |
| 内核纯解引用原语 | `packages/kernel/src/runtime/model-registry.ts`、`conversation-profile.ts`、`conversation-service.ts`、`spawn-fork.ts` |
| 插件后端与校验 | `packages/plugins/src/tiers.ts`、`packages/plugins/src/tiers/contracts.ts`、`packages/plugins/src/tiers/validation.ts`、`packages/plugins/src/tiers/skill.ts` |
| 插件前端 UI | `packages/plugins/src/tiers/client/` |
| 共享选择器扩展 | `packages/plugin-client/src/ui/ModelPicker.tsx`、`model-picker-model.ts` |
| 集成与契约测试 | `packages/plugins/test/tiers-plugin.test.ts`、`packages/web/test/tiers-client-interactions.test.tsx` |
