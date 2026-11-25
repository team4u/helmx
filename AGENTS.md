# helmx 开发约定

**helmx** 是极简持久微内核个人助理与多智能体确定性编排系统。本文件适用于所有参与开发的智能体（不限具体宿主）与人类；按需深入文档见第 7 节。

## 1. 环境、隔离与破坏性变更授权（最高优先级）

- **工作目录与 Worktree**：主仓位于 `/root/code/helm`。开工先显式 `cd` 至当前工作树；除纯文档例外（见第 6 节）外，**严禁在 `/root/code/helm` 直接改代码，禁用 `/tmp`**。分配、合入与回收见第 6 节。
- **历史仓只读**：`/root/code/botx`、`/root/code/botd`、`/root/code/herdr` 仅可参考，**绝不修改**。
- **数据隔离**：仅限 `~/.helmx`（或 `HELMX_DATA_DIR`），严禁读写 `~/.botx`、`~/.botd`。
- **端口铁律**：Web dev `3201`（`strictPort: true`，代理 `/api`、`/ws`），Hub `3202`（`HELMX_PORT=3202`）；**永不占用 `3000`、`3001/3002`、`3101/3102`**。
- **开发阶段：不兼容、不迁移**：允许对代码、公共接口、配置、数据库与开发数据**直接破坏性修改/删除/重建**；**严禁向后兼容层、旧格式读取、迁移脚本、双写或兼容适配**，测试同步采用新契约。

```bash
HELMX_PORT=3202 pnpm dev        # 前后端一起（Web 3201 -> Hub 3202）
HELMX_PORT=3202 pnpm dev:kernel # 只起内核
pnpm dev:web                   # 只起前端（需内核已在 3202）
pnpm link:bins                 # 可选：在 /usr/local/bin 挂载 helmx / helmx-node / helmx-hub
pnpm install --prefer-offline && pnpm build   # 新建 worktree 后首次必跑（node_modules/ 与 dist/ 均被 gitignore）
pnpm verify                    # 一键全量验收（build + typecheck:only + lint + check:hygiene + test:all:run；异常加 HELMX_CLEAN_DIST=1）
pnpm build && pnpm typecheck && pnpm lint && pnpm check:hygiene && pnpm test:all # 独立分步验收
```

## 2. 架构边界与设计原则

**设计原则**：第一性原理最简正确实现（笨重先怀疑设计，不打补丁）；KISS / YAGNI；命名自解释、注释只写 Why；单一职责；**机制与策略分离**。

1. **单向包依赖**：`@helmx/kernel`（机制）、`@helmx/plugins`（内置插件与插件业务契约）、`@helmx/hub`（产品组合根与 `helmx-hub`）；内核不得依赖插件或组合根。`@helmx/plugin-client` 为独立浏览器 SDK，不得反向依赖 `@helmx/web`。`@helmx/plugin-build` 经端口注入宿主。`@helmx/protocol` 只放通用跨包契约，零重依赖。
2. **内核四块通用机制**（`@helmx/kernel`，详见 `docs/architecture/overview.md`）：
   - `pi-durable`：通用 `Conversation(nodeId, cwd)` 五态、`state.sqlite` + FTS5（**纯可重建派生索引，禁写 `pi_*` 表语义**）、`AskDoc`、`SecretStash`、`Artifacts`、资产热重载与原生 `spawnAgent`；
   - `EnvFabric` + `NodeRegistry`：`/ws/node`、`/ws/node-tunnel`（TCP-only `openTunnel`）、`local` + `@helmx/node`、`bash/read/write/edit/gate/env exec` 与 `nodeId + canonicalPath` 文件互斥；
   - `Model 与 Auth`：模型接入、禁用过滤、凭据与令牌；
   - `PluginHost`：`definePlugin(ctx)`（`provide/consume`、`kv`、`route`、`host`）、受管包生命周期与 `dependencies` 拓扑启停。
3. **零角色枚举**：内核禁硬编码 `'router' | 'worker' | 'watchdog'`；身份用 `profileId`，运行态用 `tags`。
4. **不在内核的能力**：`subagent / SubagentWorkflow` 与 DSL 归 `builtin:workflow`；`cleanup_worktree` 与 `WorktreeAllocator` 归 `builtin:worktree`；无巡检定时器、无 `watchdog_tick`、无内置 JSON 渲染轨道（归 `builtin:json-render`）。
5. **扩展面契约（零 `if/else` 插件 ID 特判）**：
   - **后端 4 Hook**（`continue | transform | handled | block`，`block` 仅 `input`）：`input`、`before_turn`、`agent_spawn`（支持 `next` around）、`turn_settled`（`completed | failed | aborted`）；
   - **前端 10 `ctx.ui`**（`client.tsx` React 单轨）：`sidebarItem`、`screen`、`timelineRenderer`、`markdownCodeBlock`、`toolView`、`composerCompleter`、`workbenchPanel`、`command`、`settingsPanel`、`slot`。
6. **13 个内置插件**（`@helmx/plugins`，`@helmx/hub` 注册，全默认启用；详情见 `docs/plugins/overview.md`）：`profile`（`locked`）、`workflow`、`worktree`（与 workflow 零静态依赖）、`swarm`、`memory`、`json-render`、`mermaid`、`triggers`、`magpie`、`token-speed`、`tiers`、`title`、`plan`。
   - **插件铁律**：① 停用后工具、动作、CLI、受管技能与 UI 贡献**即时消失，不留幻影提示词**；② 高频会话态用 `ctx.sessionDoc` 按需订阅，禁塞全局 `ctx.doc`（单文档上限 2 MiB，超限 `413`）；③ 启动先按依赖拓扑全体 `prepare()` 再 `start()`，随后按依赖与 `reconcileAfter` 软序 `reconcile()`；④ 停用/重载在途任务经 `liveTasks` 硬阻断（`409 plugin_has_live_tasks`，不可 force），持久占用或被依赖报 `409 plugin_in_use`（可 `--force`）。
7. **明确不做**：服务端 TUI 兼容层；独立 `Space` CRUD 表（直用 `(nodeId, cwd)`）；内嵌 Python SSH 桥接（走 `EnvFabric`）；混装 `helmx` 与 `helmx-node`；第二套微应用子宿主（全栈微应用即带 `ctx.ui.screen` 的受管插件）；Web 端 Worktree Diff 合入状态机；在 `Conversation`/`ModelProvider` 底层伪装终端 CLI Agent。

## 3. 诚实性红线与安全不变量（禁止造假）

- **边界强校验**：外部输入（HTTP body、插件产物、DSL、事件载荷、RPC 响应）在入口做类型/Schema 校验，非法即拒。
- **禁静默降级**：能力不支持、节点离线（`409 node_offline`）、排空拒新（`node_draining`）或校验失败必须显式报错附诊断，**绝不回退本机或编造 fallback/mock**。
- **归属权红线（内核强制）**：`ownedBy: 'human' | 'helmx'` 存 `helmx_conversations.owned_by`（缺省 `'human'`）；对 `'human'` 会话**严禁自动化发送输入或中止**，仅可只读诊断与通知。一切自动化提交/中止走 `submitInputGuarded` / `abortConversationGuarded`，原子复核 `expectedOwnership` 与 `expectedStateSeq`。
- **CAS 乐观锁**：`AskDoc` 带 `expectedStateSeq`；会话 `stateChangeSeq` 已推进时迟到审批转 `superseded` 或报 `409 ask_state_conflict`，绝不重复提交。
- **机密边界如实**：`SecretStash` 保证已登记凭据与受管令牌不落库、不进模型上下文与 SSE；但不承诺对 shell 与进程内可信插件零泄漏，文档不得夸大。
- **会话与路由不变量**：`#1` 无删除豁免（凭 tombstone 不复活）；受管会话经 `ctx.host.manageConversation` 保护（`409 conversation_managed_by_plugin`）。无显式目标的 `dispatchTrigger` 选最新无父链 human-owned assistant；工作流新 run 须指定会话或 `--current`，resume 沿用原目标。忙时策略仅 `steer | followUp | reject`（默认 `steer`，批处理 `followUp`）；`origin: human | agent | trigger` 透传至 `turn_settled`。

## 4. 高频改动联动检查单（改 X 同步 Y）

- **跨包类型 / 接口 / 导出** → 先改所属包（通用 `@helmx/protocol`，插件业务 `@helmx/plugins`），再 `rg` 普查同步全仓。生产源码禁相对路径跨包或导他包私有 `src`；新增依赖须声明且无环。
- **面向用户的 HTTP 接口** → 同步 `helmx` CLI（`packages/cli/src/commands/`，含 `--json`/`--current`）、`@helmx/protocol` 的 `CORE_CLI_COMMAND_PATHS` 与 `builtin:profile` 的 `helmx-cli` 技能（`services.test.ts` 双向锁定）。
- **插件业务能力** → 用 `ctx.action({ id, inputSchema, outputSchema })` 单点声明获五端映射：HTTP（`POST /api/actions/<pluginId>/<actionId>`）、CLI（`helmx <plugin> <action>`，剥 `builtin:`，`cli.command` 可覆写）、Tool（`exposeAsTool` 或 `run_action`）、Workflow `action()` 与 Web UI。
- **Web 界面与插件 `client.tsx`** → 先读 `docs/conventions/web-frontend.md` 与 `web-navigation.md`，严守五条铁律：
  1. **零 Emoji**：全界面文案与控件严禁 Emoji，图标统一 `lucide-react`（`HelmxIcon`）或纯文本；
  2. **视图形态三级**：海量项 / 多维检索 / 管理与市场类用「全屏主舞台卡片网格 + 右侧 520~560px 详情抽屉」，严禁塞居中弹窗；
  3. **Radix UI 唯一原语**：共享原语用 `@helmx/plugin-client` Radix 封装，Web 专有在 `packages/web/src/ui/`（禁原生 `<select>` 与手写浮层）；插件优先复用 SDK 原语与宿主类，禁大面积内联样式或复制通用 CSS；字号与移动端（≤680px）禁放大见 `web-frontend.md`；
  4. **唯一 Hash 导航**：由 `url-hash-model.ts` + `HelmxStoreProvider` 唯一管理（`#/c/<id>`、`#/a/<profileId>`、`#/overview`、`#/views/<pluginId>/<screenId>`、`#/settings/*`、`sp.*`/`ssp.*`、`split`；侧栏空间由主屏推导非独立 URL 状态）；统一调 `store.openTarget / setScreenParams / openSpace`，**新建对话进待命页、首次发送才落库**，禁平行路由或直调 `history.*`；
  5. **Fast Refresh**：`.tsx` 只导出组件与 TS 类型，纯函数/常量剥至独立 `.ts`。

## 5. 测试分层与执行规范

- **命令与单跑**：
  - 分档：`pnpm test:unit` / `test:integration` / `test:all`（`TEST_CONCURRENCY` 覆写并发，默认上限 16）；
  - 快速反馈：`pnpm test:unit` 或 `pnpm check:changed`（支持 `-- --base main --list`，仅补充，不替代分档必跑与合并前 `test:all`/`verify`）；
  - 单跑指定文件：`node scripts/run-tests.mjs <file...>`（禁裸跑 `node/tsx --test`、禁管道吞失败日志、不依赖 Unix `timeout`）；
  - 变更进程环境/信号的隔离测试文件头标 `// @test-isolation: process`。
- **`pnpm check:hygiene` AST 五条红线**：
  1. `test`/`it` 显式 `{ timeout: 60_000 }`；
  2. `skip` 必附理由字符串；
  3. **禁设 `HELMX_TEST_SUITE_TIMEOUT_MS`**（触发 `env-registry-races` 误报）；
  4. **禁对 DOM / `Window` 调 `assert.equal`/`deepEqual`**（防 Fiber 树 `util.inspect` OOM，用 `assert.ok(a === b)` 或标量断言）；
  5. **钩子不受测试超时覆盖**：`before/beforeEach/after/afterEach`（含 `t.after`）调 `close/dispose/stop/kill` 等 teardown 必传 `{ timeout: 60_000 }`。
- **分档归属**（`all = unit ∪ integration`；新包同步 `scripts/test-suites.mjs` `SUITES` 与 `scripts/lib/workspace-meta.mjs` `PACKAGE_TIERS`）：
  - `unit`：`protocol + env-io + test-kit + cli + web + plugin-client`；
  - `integration`：`kernel + plugins + hub + plugin-build + node + payload`，含两条路径例外：`packages/cli/test/launcher/`、`packages/env-io/test/update/`；
  - 跨档两档都跑，合并前跑 `test:all`/`verify`。
- **共享基座与三禁**：复用 `@helmx/test-kit`（仅 `devDependencies`/`test/`，`package-boundaries` 锁定零生产泄漏）与 harness（`cli-harness` / `dom-harness` / `plugin-test-env` / `hub-test-env` / `host-backend-stub`）：`useTempDir`、`createGitTemplate().cloneTo()`、`sanitizedHostEnv`/`makeCliEnv`、DOM 首行 `import './helpers/register-happy-dom.js'` + `ensureHappyDom()/resetHappyDom()`（禁裸 `GlobalRegistrator.register()`）。等待用 `deferred`/`waitFor`/可注入计时，禁长固定 `sleep`。**三禁**：禁已删功能墓碑测试、禁正则扫 CSS/TSX 脆弱断言、禁碎片一两行测试文件。
- **进程 `kill` 纪律**：只杀**自己 spawn 且持有 PID/句柄**的进程（POSIX `kill(-pid)`；Windows `taskkill /PID <pid> /T /F`）；按端口清理前核验 cwd 与归属。**严禁 `pkill -f`、`pgrep | xargs kill`、`taskkill /IM` 与猜 PID**。

## 6. Worktree 隔离、多智能体合入与 Git 纪律

- **隔离与合入原则（宿主原生隔离优先，不绑定特定 Agent）**：
  1. **原生隔离优先、禁手工绕过**：写代码或集成合入必须在独立 Git worktree 完成（禁直改 `/root/code/helm`，禁 `/tmp`）。若当前宿主/编排工具提供原生 worktree 或工作区隔离机制，**必须直接使用，严禁先手工 `git worktree add` 再通过目录参数绕过托管分配**；派工提示词只写任务目标与允许修改的文件范围，**不要猜测或写死尚未分配的 worktree 绝对路径**。只读调研/审查可继承共享目录。
  2. **进入前归属确认**：若宿主或协调者已明确将该隔离工作树分配给本任务（如注入的工作树上下文说明或显式授权），直接开发并在交接前 `git add` + `git commit`，无需重复建树。否则写前核实 `pwd`、`git rev-parse --path-format=absolute --git-common-dir`（匹配 `/root/code/helm`）与 `git worktree list --porcelain`；归属不明则停写询问，不得因目录恰好是 worktree 就默认占用。
  3. **合入主干**：单分支在 worktree 内合入最新 `main` 并过验证后合回 `main`。多并行分支**严禁逐个盲合进 `main`**，须先在独立集成 worktree 合并全部待合分支与最新 `main`、解冲突并过全量验证后再一步合回 `main`（宿主支持原生隔离时优先派发独立集成任务使用原生受管树，避免阻塞协调者；无原生机制时用手工集成树 `/root/code/helm-worktrees/<integration>`）。跨节点分支在各自节点合入。

  | 类型 | 路径与分支 | 适用来源 | 回收（严禁跨类操作） |
  | :--- | :--- | :--- | :--- |
  | **宿主受管树** | 宿主托管目录（如 `.helmx-worktrees/<repo>-<shortId>` + `helmx/spawn-*`，或其他宿主自定目录，非 `/tmp`） | 宿主原生 worktree / 工作区隔离 | **按宿主机制回收**（`.helmx-worktrees/*` 仅限受管清理接口/命令或协作组结单，**禁裸 `rm -rf` 或 `git worktree remove`**） |
  | **手工 / 兜底树** | `/root/code/helm-worktrees/<name>`，`feat/*` 或 `fix/*`（**禁 `helmx/spawn-*`、`helmx/wf-*`**） | 仅限人工开发或宿主无原生隔离机制时 | 合入后 `git worktree remove` + `git branch -d` |

  受管树通常基于分配时刻主仓 `HEAD` 创建（不含未提交改动），不会自动合入 `main`。
- **合后收尾**：① 按第 5 节 `kill` 纪律停本轮自启服务；② 确认已合入且无保留未提交改动后按表分类回收 worktree；③ 清临时 `HELMX_DATA_DIR`，确认主仓 `git status` 干净。
- **轻量文档例外**：仅改独立文档（`AGENTS.md`、`docs/`、`README.md`、`.helmx/skills/` 等，不涉 `packages/`、脚本、构建配置或受测资产）可直接在主仓修改并跳过独立 worktree 与构建/测试跑批。
- **改动所有权**：已有修改/暂存/未跟踪文件默认归属他人，记录保留并询问，禁重置覆盖。
- **恢复纪律**：禁从移动中 `HEAD` 盲目恢复（含 `git show HEAD:<file> > <file>`），误覆盖立即停写保留现场查快照或 reflog。
- **Git 提交**：中文 Conventional Commits（如 `feat(kernel): ...`），不加 `Co-Authored-By`。

## 7. 文档中心速查（按需阅读）

- **总览与入门**：`docs/README.md` · `docs/getting-started/`（index / installation / first-workflow / orchestration-guide）· `docs/cli/reference.md` · `docs/releasing.md`
- **架构机制**：`docs/architecture/overview.md` · `extension-points.md` · `envfabric.md` · `pi-durable.md`
- **编排引擎**：`docs/workflows/dsl-guide.md` · `worktree-and-gate.md` · `journaling-recovery.md`
- **插件生态**：`docs/plugins/overview.md` · `plugin-development.md` 及 13 插件同名文档：`profile / workflow / worktree / swarm / memory / triggers / magpie / json-render / mermaid / token-speed / tiers / title / plan`
- **Web 约定**：`docs/conventions/web-frontend.md` · `docs/conventions/web-navigation.md`
- **工程排障**：`.helmx/skills/helmx-troubleshooting/SKILL.md`（长测试后台跑法、合并后 `HEAD^{tree}` 免重跑、happy-dom / Radix / TS 踩坑、fork `spawn_error` 恢复）——若当前环境未自动加载 `.helmx/skills/`，请按需主动读取
