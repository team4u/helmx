# 通用改动检视插件（builtin:changes）

`builtin:changes` 默认启用，提供**跨普通会话工作区与受管工作树**的统一只读 Git 差异检视体验，与 `builtin:worktree`、`builtin:workflow`、`builtin:swarm` 保持零静态依赖。

## 核心能力与视图形态

1. **两段式只读探测（彻底避免全量 `git diff` 超出 1 MiB 输出上限）**：
   - 先拉取轻量结构化概览（`status --porcelain=v2 --branch -z` + `--numstat -z` + `--name-status -z` + 有界 `git log`）；
   - 选中或展开单文件后按需拉取单文件差异（已跟踪文件先经 `--numstat` 预检行数/二进制，超限或超大补丁显式返回 `too_large` / `binary`，未跟踪文件走 TOCTOU 安全的有界读取返回预览或 `special_file`）。
2. **会话工作台面板（`workbenchPanel: changes`——默认零跳转主路径）**：
   - **极简单行顶栏**：左侧范围分段切换（工作区 `未提交 / [未推送] / 提交`；受管工作树 `全部 / 已提交 / 未提交`），右侧仅保留 `刷新` 与唯一 `分屏检视` 图标按钮（点击分屏检视时先收起工作台抽屉再打开右分屏，避免抽屉遮罩覆盖分屏）；
   - **本会话作用域合并**：仅当当前会话存在活跃受管工作树（或经 `params.wt` 指定）时展示目标切换下拉框（严格限于当前工作区与本会话活跃工作树），无工作树时不展示任何目标选择框；
   - **原地手风琴展开单文件 Diff**：点击文件行直接在下方展开单列吸顶行号彩色 Diff（支持自动换行切换、复制路径、350 行折叠与按需重新拉取），左侧对话与输入全程可用，回合 settle 后自动清缓存并刷新。
3. **按需分屏 / 全屏检视台（`screen:builtin:changes/inspector`）**：
   - 面向大改动多文件审阅，通过工作台右上角 `分屏检视` 或深链按需进入（不注册全局侧栏 `sidebarItem`，不展示跨会话全局下拉框，仅限定在当前目标会话及其活跃工作树内切换）；
   - `< 8` 个文件时自动隐藏搜索框；宽容器（`> 680px`）左右分栏独立滚动，窄容器（`@container (max-width: 680px)`）以 URL `sp.file` 驱动列表/单文件切换（单文件默认直达 diff、顶部 `< i/n >` 快速翻页、单列吸顶行号、默认横向滚动 + `wrap-text` 换行开关、移动端侧滑返回回到文件列表），不承担任何会话输入、审阅合入或工作树清理写操作。
4. **跨插件只读 UI 插槽**：向 `builtin:workflow` 贡献 `worktree-inspect` / `worktree-trace-inspect`，向 `builtin:swarm` 贡献 `worktree-actions`（成员行、保留分支行与看板快照行）。在会话上下文中点击统一调用 `ctx.openWorkbench('plugin:builtin:changes/changes', { wt })` 直接切至工作台「改动」页签并选中该工作树（无会话上下文时回退打开分屏检视），停用本插件时所有入口即时无痕消失。

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
