# 实时步骤清单插件（`builtin:steps`）

`builtin:steps` 为顶层人类直连会话提供轻量的实时任务步骤清单（`update_steps` 工具 + 输入框上方可折叠托盘 + 时间线紧凑单行轨迹），全部逻辑与前端视图位于插件层，零内核特判。

## 当前状态

默认启用、非 `locked` 可停用。停用后 `update_steps` 工具、Prompt 指南、CLI 动作与前端托盘/轨迹行即时消失，不留幻影提示词。

## 工具契约与 Prompt 纪律

- **工具名**：`update_steps`（`scope: { topLevelOnly: true, ownedBy: 'human' }`，`replay: 'safe'`）。
- **入参 Schema**：`{ steps: Array<{ title: string, status: 'pending' | 'in_progress' | 'done' | 'skipped' | 'failed' }> }`
  - 全量列表覆盖语义（`0..12` 项），传入空数组 `[]` 即清空当前会话清单；
  - `title` 经 `ctx.host.redact` 脱敏并修剪，限制单行 `1..120` 字符（拒绝控制字符/换行）。
- **双通道返回**：
  - 给模型的 `output` 只返回单行英文摘要（例如 `Updated steps: 2/5 done, current: Run verification.`），避免 JSON 回显膨胀上下文；
  - UI 结构化快照写入 `presentationMeta`（受 `STEPS_PRESENTATION_META_SCHEMA` 约束，持久化于 `pi.tool-result.model[0].details`，不进模型上下文）。
- **与 `builtin:orchestrator` / `builtin:plan` 的协同**：
  - 实时步骤清单仅面向执行阶段：`builtin:orchestrator` 规划阶段（`ORCHESTRATOR_PLAN_BASE_TOOL_WHITELIST`）与 `builtin:plan` 只读 `/plan` 阶段（`PLAN_MODE_TOOL_WHITELIST`）均收紧白名单并剥离 `update_steps`，进入 `builtin:orchestrator` 执行阶段或 `/plan` 批准回到 `normal` 执行期后自动恢复可用。

## 生命周期收敛语义

状态持久化至 `ctx.kv('steps')`（启动时 `hydrate()` 水合），并通过非持久公开会话文档 `ctx.sessionDoc('steps', null, { public: true, durable: false })` 实时推送：

- **全部完成即刻关闭（`turn_settled`）**：若所有步骤均已为 `done` 或 `skipped`（零 `pending` / `in_progress` / `failed`），模型末次标齐后在输出最终总结期间托盘先自动折叠为单行摘要，**本轮结算（`turn_settled`）立即清空 KV 与 `steps` `sessionDoc` 并关闭托盘**；
- **失败终态（含 `failed`）**：本轮结算仍保留清单展示失败项（直到用户点 `×` 或发起下一轮人类输入自动清空）；
- **回合结束未完成（`turn_settled: completed | failed | aborted`）**：保留步骤列表与 `in_progress` 状态，仅记录 `settledOutcome`；当会话非 `working` 时，前端将 `in_progress` 派生显示为暂停/中断状态灯，而非继续转圈；
- **下一轮人类输入（`input`, `origin === 'human'`）**：若仍有达终态清单（含 `failed`），自动清空旧清单；若仍有未完成步骤，保留清单并清除旧 `settledOutcome` 跨轮续跑；
- **重置（`pi.reset`）与删除（`conversation.deleted`）**：立即清空 KV 与 `sessionDoc`；
- **历史回滚（`helmx.rewind`）**：逆向扫描当前可见历史条目恢复回滚前的最近未完结 `update_steps` 列表（遇 `pi.reset` 或已完结清单则清空）。

## 多端入口与 Action

| 动作 | 可见性 | CLI / HTTP | 说明 |
| :--- | :--- | :--- | :--- |
| `get` | `public`（`idempotent: true`） | `helmx steps get --current` | 读取当前会话的 `StepsSessionView` |
| `clear` | `public` | `helmx steps clear --current` | 清空当前会话步骤清单 |
| `dismiss` | `ui` | — | 按当前 `version` 收起关闭托盘，直到模型下次更新递增 `version` |

## 前端界面（`packages/plugins/src/steps/client/`）

- **`StepsActiveTray`（`COMPOSER_DOCK_SLOT`, `order: 15`）**：复用 `@helmx/ui` 的 `DockTray` / `DockTrayRow` 原语；桌面端（`> 680px`）进行中默认展开、全部终态后自动折叠为 `32px` 单行摘要，移动端默认折叠，支持点击 `×` 触发 `dismiss`；
- **`StepsToolRow`（`toolView`, `replaceRow: true`, `foldable: true`）**：仅消费 `props.presentationMeta`，将每次 `update_steps` 调用渲染为紧凑 `26px` `.trace-row`（`check-square` / `loader` 图标、进度摘要、`done/total` Badge 与 `StatusLight`）；因声明 `foldable: true` 而归入 `<StepGroup>` 过程折叠组内，不切碎思考/工具流、也不写入右侧会话大纲。

## 源码与测试入口

| 内容 | 位置 |
| :--- | :--- |
| 插件入口与动作注册 | `packages/plugins/src/steps.ts` |
| 契约、Schema 与边界校验 | `packages/plugins/src/steps/contracts.ts` |
| 状态持久化与生命周期收敛 | `packages/plugins/src/steps/state.ts` |
| 前端组件与样式 | `packages/plugins/src/steps/client/` |
| 单测、集成与前端 DOM 测试 | `packages/plugins/test/steps-plugin.test.ts`、`packages/plugins/test/steps-plugin.integration.test.ts`、`packages/web/test/steps-client-interactions.test.tsx` |

## 相关文档

- [插件系统设计与契约](overview.md)
- [计划模式插件（`builtin:plan`）](plan.md)
- [编排器插件（`builtin:orchestrator`）](orchestrator.md)
- [模型档位插件（`builtin:tiers`）](tiers.md)
