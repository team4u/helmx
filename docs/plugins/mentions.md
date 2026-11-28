# 角色点名插件（`builtin:mentions`）

`builtin:mentions` 为存在派工能力的会话提供跨角色（Profile）`@` 点名协作支持：在主输入框注册 `@` 自动补全源（`role-mentions`），并在当回合实际保有派工工具时向系统提示词注入可协作候选目录（`mentions.catalog` / `<available_profiles>`）。与内核通用角色及技能底座（`SYSTEM.md` / `AGENTS.md` / `restrictToCwd` / `ScopedSkillService` / `load_skill`）以及 [`builtin:memory`](memory.md) 完全正交。

## 当前状态

默认启用、可按需自由停用。停用后 `@` 补全源（`role-mentions`）、`list_mentionable` 动作、`helmx mentions list_mentionable` 动态 CLI 命令与 `mentions.catalog` 系统提示段落即时消失，不留幻影提示词；内核的角色配置（`SYSTEM.md`、`AGENTS.md`、`restrictToCwd`）与 `load_skill` 工具不受影响。

## 能力和入口

### 1. `before_turn` 协作目录注入（`priority: -100`）

- **条目标注与裁剪**：每回合开始时剥离历史残留的 `mentions.catalog`，再消费活跃插件经 `ctx.provide('helmx.dispatch-tools')` 声明的派工工具名（如 `builtin:workflow` 的 `subagent` / `SubagentWorkflow`、`builtin:swarm` 的 `swarm_dispatch_worker`）；
- **与 tool-stripping 钩子对齐**：以低于默认优先级的 `-100` 运行，读取普通钩子（如只读 `/plan` 模式、深度限制守卫）裁剪后的真实 `turn.tools`。当回合无任何派工工具或无合规候选时，不注入 `mentions.catalog`；
- **候选过滤（`isCollaborationCandidate`）**：排除当前会话自身的 Profile，并经 `isProfileOwnerActive` 过滤掉所属插件未启用的托管 Profile（`core:*` 托管的 Profile 恒定活跃，如 `core:profiles` 托管的 `assistant`）；
- **摘要提取（`extractSystemSummary`）**：读取候选 `SYSTEM.md` 的首段自然段（忽略 frontmatter 与标题，限制 100 码点）生成 `<available_profiles>` 摘要；`SYSTEM.md` 缺失（`not_found`）只省略该候选的 `summary`，绝不伪造简介，其余 IO/权限错误如实上抛。

### 2. 动作与输入补全

- **`list_mentionable` 动作**（`exposeToPrompt: false`，`idempotent: true`）：`role-mentions` `@` 补全的单一数据源。调用时若带宿主会话上下文，唯一信任上下文会话的 `profileId`；无会话上下文时允许显式传入 `--conversation-id` 或 `--profile-id`（用于待命草稿态），三者皆缺显式拒绝 `400 validation_error`。CLI：`helmx mentions list_mentionable`。
- **`composerCompleter` `role-mentions`**：监听触发字符 `@`（`priority: 100`），插入 `@<profileId> `，供用户在输入区快速点名其他 Profile 协助。

## 配置与数据边界

本插件**无 `ctx.configSchema` 配置项**，也不持有持久文档或 `ctx.kv` 状态；候选目录与 `SYSTEM.md` 摘要每次按需经 `ctx.host.profiles` 与 `ctx.host.listPlugins()` 实时计算。

## 源码与测试入口

| 内容 | 位置 |
| :--- | :--- |
| 插件入口（Hook / Action / `@` 补全注册） | `packages/plugins/src/mentions.ts` |
| 纯函数目录计算、过滤与 XML 渲染 | `packages/plugins/src/mentions/catalog.ts` |
| 单测与 Hook/补全契约 | `packages/plugins/test/mentions-plugin.test.ts` |
| 真实组合层集成测试 | `packages/plugins/test/mentions-plugin.integration.test.ts` |

## 相关文档

- [微内核架构总览](../architecture/overview.md)：内核通用角色与技能底座、`TurnContextAssembler` 与 `load_skill`
- [长期记忆](memory.md)：MEMORY.md 注入与单 Profile 开关（与本插件正交）
- [CLI 命令参考](../cli/reference.md)：`helmx profiles`、`helmx skills` 与 `helmx mentions` 命令
