# 插件系统设计与契约

本文面向两类读者：想理解 Helmx 插件宿主如何工作的内核/插件贡献者，以及准备为自己的能力选择承载形态（内置插件、外部插件还是全栈微应用）的开发者。读完你应当能回答：插件能拿到哪些宿主能力、一次 `ctx.action` 声明如何映射到五个消费端、插件的状态存放在哪里、停用一个插件会发生什么。插件开发的上手教程见[插件开发实战](plugin-development.md)，Hook 与 UI 扩展点的逐项契约见[扩展点详解](../architecture/extension-points.md)。

## 当前状态

插件系统是 Helmx 的核心生产能力：内核（`@helmx/kernel`）只保留持久会话、跨节点执行底座、Model/Auth 与插件宿主四块通用机制，其余一切业务能力由插件承载。官方插件实现与资产位于 `packages/plugins`，由产品组合根 `packages/hub/src/app.ts` 的 `createHelmx` 注册，共 15 个内置插件（全部默认启用）：

| 插件 ID | 名称 | 职责一句话 | 默认状态 | locked |
| :--- | :--- | :--- | :--- | :--- |
| `builtin:profile` | 角色与技能底座 | 按会话 Profile 注入 SYSTEM.md / AGENTS.md 与技能目录，补写默认 `assistant` 托管声明并提供 `load_skill` 工具（内核核心技能由 `core:*` 直接自举） | 启用 | 是（常驻不可停用） |
| `builtin:workflow` | 工作流与子代理编排 | `subagent` / `SubagentWorkflow` 工具、DSL 引擎与账本恢复 | 启用 | 否 |
| `builtin:worktree` | 受管工作树 | 受管 Git Worktree 分配、持久租约与持有锁、两段式结构化探测、`cleanup_worktree` 工具与 `worktrees` CLI | 启用 | 否 |
| `builtin:changes` | 通用改动检视 | 跨普通会话工作区与受管工作树的只读 Git 差异检视台、工作台 `Changes` 面板与跨插件检视插槽 | 启用 | 否 |
| `builtin:swarm` | Swarm 对等协同看板 | 扁平对等序号黑板、正交唤醒、`turn_settled` 纯事件防掉棒自愈与自适应协同看板 | 启用 | 否 |
| `builtin:memory` | 长期记忆 | 按 Profile 管理 MEMORY.md 注入与启停，提供 `update_memory` 工具与每日 Dream 自动整理（`dream` / `dream_status` / `dream_configure`） | 启用 | 否 |
| `builtin:json-render` | JSON 卡片渲染 | 接管 ```ui 代码围栏渲染声明式 JSON Spec 卡片，自举 `generative-ui` 技能 | 启用 | 否 |
| `builtin:mermaid` | Mermaid 图表 | 接管 ```mermaid 围栏，把 Mermaid 文本渲染为矢量图表 | 启用 | 否 |
| `builtin:triggers` | 触发器 | Cron 定时与 Webhook 签名入站连接器 | 启用 | 否 |
| `builtin:magpie` | Magpie 网关 | 动态模型网关接入：目录、配额与路由组诊断 | 启用 | 否 |
| `builtin:token-speed` | Token 速率 | 输入区状态行实时解码速率（只读展示，内核零速率计算） | 启用 | 否 |
| `builtin:tiers` | 模型档位 | 语义模型档位（`tier/<id>`）、自定义多套模板与 `model-tiers` 受管技能 | 启用 | 否 |
| `builtin:title` | 会话标题 | 首轮完成后后台静默整理清晰标题，提供 `/title` 命令按当前内容随时重整 | 启用 | 否 |
| `builtin:plan` | 计划模式 | 只读调研、澄清问答、只读 Shell 与结构化计划草拟：严格工具白名单、`AskDoc` 审批、人工编辑、产物归档与可选新上下文/模型交接执行 | 启用 | 否 |

内核包自身不注册任何插件；同一注册点还会调用 `loadExternalPlugins` 从 `<dataDir>/installed-plugins/` 目录加载外部插件（默认停用；与运行期数据目录 `<dataDir>/plugins/<id>/` 物理分离）。各插件的深度文档见文末「相关文档」。

插件是**可信代码**，宿主不提供权限沙箱：隔离是状态与配置层面的（专属数据目录、文档命名空间、凭据命名空间），任意插件天然可读环境变量与进程内数据。文档涉及机密边界处均以此前提如实陈述。

## 能力和入口

### `definePlugin(ctx)` 契约

每个插件实现 `definePlugin(ctx)`（`PluginDefinition`，见 `@helmx/protocol` 的 `packages/protocol/src/plugin.ts`）。内置插件经 TypeScript 工厂函数构造；外部插件在 `plugin.json` 声明入口后 `export default` 定义对象。上下文能力面：

| 接口 | 职责 | 关键约束 |
| :--- | :--- | :--- |
| `ctx.pluginId` / `ctx.dataDir` | 只读身份与专属数据目录 | `<dataDir>/plugins/<id>/` |
| `ctx.getConfig()` / `ctx.configSchema(schema)` | 读取与声明配置 | `ctx.getConfig()` 合并 Schema 默认值与持久化覆写（在 `defining` / active / `stopWindow` 可用，停用后抛 `409 plugin_context_closed`）；`type: string/number/boolean`（`string` 支持 `format: 'model' / 'node' / 'profile'`，由宿主渲染标准选择控件）；`secret: true` 分离至 `credentials.json` |
| `ctx.hook` | 注册 4 个生命周期 Hook | `input / before_turn / agent_spawn / turn_settled`，支持 `priority` |
| `ctx.action(spec)` | 注册五端复用动作 | 强类型 `inputSchema` / `outputSchema`；可选 `cli.command` / `exposeAsTool` / `promptSnippet` / `promptGuidelines` / `scope` / `idempotent`；工具名与公开 CLI 路径在注册与启用提交期强唯一校验（冲突报 `409 duplicate_tool_name` / `409 duplicate_cli_command`） |
| `ctx.tool(spec)` | 注册仅对模型可见的工具 | 同样支持 `scope` 与提示词投射字段；禁止与 `KERNEL_TOOL_NAMES` 或其他活跃插件重名（`409 duplicate_tool_name`） |
| `ctx.route(spec)` | 挂载 Web Standard 原始 HTTP 路由 | 支持 `GET / POST / PUT / PATCH / DELETE / HEAD`；提取 `:param` 经第二参数 `{ params }` 透传；注册期拒绝重复/结构冲突路由（`400 validation_error`）；流式响应体在 EOF/cancel/abort 前计入 `liveTasks`；对 `text/*`（含 `text/event-stream`）与 `application/x-ndjson` 直接流式 SecretStash 脱敏，`application/json` / `*+json` JSON 感知脱敏上限 4 MiB（超限无缝降级流式脱敏），二进制流零缓冲透传；前端经 `PluginClientContext.fetchRoute(path, init?)` 鉴权调用；`public: true` 跳过 Token 鉴权 |
| `ctx.doc(name, initial, opts)` | 声明全局持久文档 | state.sqlite；`public: true` 进全局首帧与 SSE 广播 |
| `ctx.sessionDoc(name, initial, opts)` | 按会话分片的持久文档 | 不进全局首帧/全局 SSE，专用 SSE 按需订阅 |
| `ctx.kv<T>(namespace)` | 轻量插件专属键值存储 | state.sqlite `helmx_plugin_kv`；按条目独立 `get / set / delete / list(prefix/limit/cursor) / clear / flush`（无整命名空间序列化），写入自动过 SecretStash 脱敏、单条上限 256 KiB（超限 `413 plugin_kv_too_large`），受 epoch 守卫，卸载清理 |
| `ctx.provide<T>(id, impl)` / `ctx.consume<T>(id)` / `ctx.onCapabilityChanged(id, listener)` | 类型化插件间能力注册、发现与变更观察 | `id` 边界强校验（`^[a-z0-9][a-z0-9._-]{0,63}$`）；停用/停止/回滚自动释放提供与订阅；`consume` 仅返回活跃插件实现；`onCapabilityChanged` 返回幂等退订函数；内核子系统亦通过 `PluginHost.consumeCapability` 消费（如 `helmx.dispatch-tools` 与 `helmx.model-tiers`） |
| `ctx.service(spec)` | 注册后台长驻服务 | `prepare / start / reconcile / stop / liveTasks / inUse` |
| `ctx.provider(provider)` | 注册模型供应商网关 | 启用时挂载、停用后注销，宿主统一协调 |
| `ctx.ui` | 前端扩展点注册表（10 个 surface） | 见[扩展点详解](../architecture/extension-points.md) |
| `ctx.host` | 宿主运行时能力（`HelmxHostApi`） | 见下文 |

启动时序遵守**全局 prepare 后 start 屏障**：`PluginHost.start` 先对全体已启用服务执行 `prepare()`，全部完成后才依次 `start()`，最后恢复会话调度。热启用单个插件同样先 prepare 后 start。`stop()` 返回后本周期 doc 句柄失效；宿主在 await `stop()` 链期间开放受控停止窗口，允许本插件当前周期的 doc 句柄完成最终写入（`builtin:workflow` 在此窗口做最终 runs 投影并 `await flush()`）。

### 动作五端映射

`ctx.action()` 是插件对外暴露业务能力的唯一入口，宿主按声明自动映射到五个消费端：

| 消费端 | 映射形态 |
| :--- | :--- |
| HTTP | `POST /api/actions/:pluginId/:actionId`（pluginId 含 `:` 时 URI 编码） |
| CLI | `helmx <plugin> <action>` 顶层动态命令（`builtin:` 前缀剥离，`cli.command` 可整体覆写） |
| Agent Tool | `exposeAsTool: true` 直接注入工具列表；否则经 `run_action` 元工具按需调用 |
| Workflow | 编排脚本 `action('pluginId.actionId', input, options)` |
| Web UI | 声明式 Spec `{ type: 'helmx:action', pluginId, actionId, input }` 或 `ctx.callAction` |

输入输出在边界处统一 JSON Schema 强校验；输出经宿主统一脱敏。启用且匹配会话 `scope`、未 `exposeAsTool` 的动作会投射进系统提示 `<available_actions>` 目录，随插件启停即时增删，不留幻影提示词。`idempotent: true` 是作者对安全重试的承诺：工作流账本在成功后进入前缀缓存复用，中断恢复可安全重跑；缺省 `false` 的动作一旦执行状态不确定，账本标记 `workflow_action_uncertain`，恢复时显式交由人类确认。

### `ctx.host` 能力面

`ctx.host`（`HelmxHostApi`）是插件调用内核机制的唯一受信通道，实现已绑定插件自身 ID。按职责分组：

| 分组 | 端口 |
| :--- | :--- |
| 外部事件 | `dispatchTrigger(envelope)`（统一 defang 防逃逸投递） |
| 输入与会话 | `submitInput` / `submitInputGuarded`（均支持 `attachments` 产物 ID 列表，按会话或祖先链授权挂载）、`createConversation / forkConversation / listConversations / getConversation / getConversationDetail / getConversationSubmission / updateConversation / abortConversation / abortConversationGuarded`、`resetConversation / resetConversationGuarded / compactConversation / compactConversationGuarded`（原地重置与手动压缩：无守卫版供人类交互通道代理保持 `ownedBy: 'human'`，Guarded 版供后台自动化在串行域内强制归属红线与可选 CAS 水位；`handoff`/`instructions` 经统一脱敏）、`manageConversation`（删除保护）、`markConversationOwnership`（仅允许 `'human' \| 'helmx'`，非法值显式 400） |
| 人机审批 | `createAsk / cancelAsk` |
| 子代理与执行 | `spawnAgent / runGate / execEnv / resolveSpawnTarget / listActiveSpawnExecutions` |
| 动作互调与治理 | `prepareAction / invokeAction / listActions / listPlugins` |
| 资产端口 | `profiles / skills / secrets`（Profile 与 SYSTEM.md、技能受管自举、插件私有机密）、`listArtifacts / createArtifact / readArtifact`（内存字节写入与授权元数据+隔离字节读取，不暴露宿主磁盘路径） |
| 节点与文件 | `nodeIpc`（含 `listNodes()` 无凭据只读计算节点快照，支持 `stopWindow`） / `openTunnel / executionEnv / withFileLock / atomicWriteFile / inspectNodePathUsage` |
| 通用机制 | `redact / completeText / refreshModels / listModels / listUi / isClosing / onEvent / emitEvent`（内建事件经 `HostEventMap` 提供强类型重载，自定义事件保持通用 `string` 回退） |

使用纪律：
- 受管 Git Worktree 清理不在 `ctx.host`——需要清理时调用 `builtin:worktree` 的 `cleanup_worktree` 动作；
- `execEnv` 目标节点或目录缺省继承请求会话坐标，节点离线显式报 `409 node_offline`，绝不静默回退本机；插件不得经 `execEnv`/`executionEnv` 反向调用宿主 `helmx` CLI 绕过类型契约与归属红线；
- 会话上下文重置与压缩必须走内核 `resetConversation*` / `compactConversation*` 端口，**不得**用 `createConversation` 另起会话冒充上下文清理：人类聊天通道转发用户显式 `/clear`、`/compact` 时走无守卫版（保持会话 `ownedBy: 'human'`，使长期记忆 Dream 与 Web 归档/删除正常生效），后台自动化/巡检维护**一律走** `resetConversationGuarded` / `compactConversationGuarded`。

## 配置与数据边界

- **专属数据目录与键值存储**：每个插件分配 `<dataDir>/plugins/<id>/`，`ctx.doc` / `ctx.sessionDoc` 与 `ctx.kv` 在 `state.sqlite` 中按插件严格隔离。文档是紧凑状态而非数据仓库：单文档 JSON 序列化超过 **2 MiB** 即显式拒绝（`413 plugin_doc_too_large`）；需要按 key 独立读写或前缀分页检索的轻量持久化状态（缓存、游标、条目索引）使用 `ctx.kv<T>(namespace)`（落盘 `helmx_plugin_kv`，写入自动过 SecretStash 脱敏，单条上限 **256 KiB**、超限显式 `413 plugin_kv_too_large`，免整命名空间重序列化；停用保留数据、卸载随 `purgePluginPersistentData` 一并清空）。大体量二进制内容应落盘为文件资产。
- **公共与私有文档**：`public: true` 的 `ctx.doc` 进入全局 SSE 首帧 `pluginDocs` 并广播更新；`ctx.sessionDoc` 按会话分片、经专用 SSE 按需订阅（`builtin:workflow` 的 `runs` 与 `builtin:token-speed` 的 `speed` 即此形态）。公共文档禁止包含未脱敏机密。
- **配置与机密**：`ctx.configSchema` 声明 `secret: true` 的字段自动分离到 `credentials.json` 的 `pluginSecrets.<pluginId>`（恒 0600）并注册 SecretStash 脱敏；插件配置经插件中心或 `helmx plugins config <id>` 同权读写。
- **只读契约自省（`PluginManifestProjection`）**：宿主直接基于既有 `CapabilityRegistry`、`UiRegistry`、`PluginDocRegistry` 与 `PluginState` 按需投影单一插件的完整能力契约（经 `GET /api/plugins/:id/manifest`、`helmx plugins manifest <id>`，或在 `doctor` `register` dry-run 阶段随 `PluginDoctorReport.manifest` 返回）；按 UTF-16 code unit / 规范 Hook 序确定性排序，在边界处强校验，绝不执行 Provider 或动作处理器、绝不暴露运行期配置值、`secret: true` 默认值或私有文档。
- **技能与 Profile 资产**：插件可经 `ctx.host.skills.ensureSkill` 自举受管技能（frontmatter `managedByPlugin` 绑定本插件 ID，随启停进出技能目录），经 `ctx.host.profiles` 读写 Profile 资产。

## 插件间依赖与停用/失败语义

插件定义或清单可声明 `dependencies: string[]`（其他插件 ID，仅 ID 不做版本解析）：

- **启用门禁**：启用时逐项校验依赖已注册且已启用，缺失/未启用分别报 `409 plugin_dependency_missing` / `plugin_dependency_not_enabled`；
- **环路拒绝**：依赖图成环（含自依赖）在注册边界拒绝（`409 plugin_dependency_cycle`）；
- **拓扑时序**：全局启动屏障按依赖拓扑序 prepare/start，`stop` / `dispose` 按逆拓扑序；
- **依赖者保护**：停用被依赖插件时，依赖它的已启用插件（含传递依赖者）作为 `plugin_in_use` 占用项拦截；`--force` 停用后依赖者被显式标记为故障态（`status=failed` 附诊断），绝不静默潜伏。

停用一个插件要过三道关卡，顺序固定：

1. **locked 硬拒绝**：`locked: true` 的插件（仅 `builtin:profile`）永久禁止停用或卸载，返回 `403 plugin_locked`；
2. **在途任务硬阻断**：`liveTasks()` 非空（执行中的动作/工具/子代理派生/服务自声明任务）即 `409 plugin_has_live_tasks`，**不可 force**；`liveTasks()` 执行崩溃按 `500 plugin_live_tasks_check_failed` 拒绝，绝不默认放行；
3. **持久资源知情确认**：`inUse()` 声明持久生效资源（如已启用的 cron 任务、webhook 端点、Profile 运行时绑定、模型引用），非空默认 `409 plugin_in_use` 并列出占用清单；显式 `--force` 可越过（磁盘配置保留，重新启用后恢复）。

停用后该插件的工具、动作、动态 CLI 命令、受管技能、UI 贡献与事件订阅**即时消失，不留幻影提示词**。插件加载或启用失败不拖垮内核：`PluginSummary.status` 置 `failed` 并携带结构化 `error`（`code / message / stage / details`），`stage` 标明故障阶段（`scan` / `load` / `define` / `enable`）；失败插件在插件中心可见且诊断可读，修复源码后经 `reload` 或重启恢复。

## 源码与测试入口

| 内容 | 位置 |
| :--- | :--- |
| 内置插件实现 | `packages/plugins/src/<name>.ts` 与同名子目录 |
| 插件契约（编排业务形状） | `packages/plugins/src/contracts.ts` |
| 插件宿主（PluginHost / 生命周期 / doctor / 受管包） | `packages/kernel/src/plugins/` |
| 宿主能力端口与 Hook/UI 契约类型 | `packages/protocol/src/plugin.ts` / `ui.ts` |
| 产品注册点 | `packages/hub/src/app.ts` |
| 契约锁定测试 | `packages/kernel/test/plugins-contract.test.ts`、`packages/plugins/test/contracts.test.ts` |
| 宿主测试 | `packages/kernel/test/plugins.test.ts`、`plugin-*.test.ts`（生命周期、依赖、doc 上限、受管包等） |
| 各插件测试 | `packages/plugins/test/<domain>*.test.ts`（见各插件文档「源码与测试入口」） |

## 相关文档

- 各内置插件深度文档：[workflow](workflow.md) · [worktree](worktree.md) · [changes](changes.md) · [swarm](swarm.md) · [profile](profile.md) · [memory](memory.md) · [triggers](triggers.md) · [magpie](magpie.md) · [json-render](json-render.md) · [mermaid](mermaid.md) · [token-speed](token-speed.md) · [tiers](tiers.md) · [title](title.md) · [plan](plan.md)
- [插件开发实战](plugin-development.md)：从 `helmx plugins init` 到 doctor / rescan / enable / reload 的完整闭环
- [生命周期 Hook 与全界面扩展点](../architecture/extension-points.md)：4 个 Hook 与 10 个 UI surface 的逐项契约
- [微内核架构总览](../architecture/overview.md)：内核四块机制与包依赖方向
