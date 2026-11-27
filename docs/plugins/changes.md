# 通用改动检视插件（builtin:changes）

`builtin:changes` 默认启用，提供**跨普通会话工作区与受管工作树**的统一只读 Git 差异检视体验，与 `builtin:worktree`、`builtin:workflow`、`builtin:swarm` 保持零静态依赖。

## 核心能力与视图形态

1. **两段式只读探测（彻底避免全量 `git diff` 超出 1 MiB 输出上限）**：
   - 先拉取轻量结构化概览（`status --porcelain=v2 --branch -z` + `--numstat -z` + `--name-status -z` + 有界 `git log`）；
   - 选中单文件后按需拉取单文件差异（已跟踪文件先经 `--numstat` 预检行数/二进制，超限或超大补丁显式返回 `too_large` / `binary`，未跟踪文件走 TOCTOU 安全的有界读取返回预览或 `special_file`）。
2. **双模式全屏/右分屏检视台（`screen:builtin:changes/inspector`）**：
   - **普通会话工作区模式（`?sp.conv=<id>`）**：覆盖直接在 `main` 或任意分支改代码的场景，支持四种范围：`working`（未提交 + 未跟踪）、`unpushed`（`@{upstream}..HEAD`）、`commit`（最近提交明细）与 `since`（选定历史提交作为基线对比当前工作区）；
   - **受管工作树模式（`?sp.wt=<worktreeId>`）**：支持 `all`（相对 `baseCommit` 总改动）/ `committed` / `uncommitted`，集成「让主会话审阅并合入」与 `builtin:worktree` 提供的 `worktree-cleanup` 清理插槽；
   - **左对话 + 右分屏联动**：复用宿主 `useConversation` 状态与 `completionSeq`，当被观察会话回合 settle 后自动清缓存并刷新最新差异。
3. **会话工作台面板（`workbenchPanel: changes`）**：在任意会话右侧工作台提供当前工作区改动与关联受管工作树的速览入口，点选文件直达右分屏。
4. **跨插件 UI 插槽**：向 `builtin:workflow` 贡献 `worktree-inspect` / `worktree-trace-inspect`，向 `builtin:swarm` 贡献 `worktree-actions`（成员行、保留分支行与看板快照行），停用本插件时所有入口即时无痕消失。

## 动作与 CLI（`exposeToPrompt: false`，全部只读幂等）

| 动作 | CLI | 说明 |
| :--- | :--- | :--- |
| `inspect_workspace` | `helmx changes inspect` | 按 `conversationId`（或 `--current`）解析权威 `(nodeId, cwd)`，返回非 Git 判定或结构化文件/提交概览 |
| `inspect_workspace_file` | `helmx changes file` | 单文件按需差异或未跟踪文件有界预览（严格校验仓内相对路径，拒绝穿越与任意绝对路径） |

## 源码与测试入口

| 内容 | 位置 |
| :--- | :--- |
| 插件入口与动作 | `packages/plugins/src/changes.ts`、`packages/plugins/src/changes/actions.ts` |
| 共享只读 Git 探测引擎 | `packages/plugins/src/git-diff/` |
| 客户端视图、面板与插槽 | `packages/plugins/src/changes/client/` |
| 集成与交互测试 | `packages/hub/test/changes-inspect.integration.test.ts`、`packages/plugins/test/git-diff.test.ts`、`packages/web/test/changes-client-interactions.test.tsx` |
