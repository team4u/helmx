# 后端生命周期 Hook 与前端全界面扩展点

本文面向插件开发者与宿主维护者：给出后端 4 个生命周期 Hook 与前端 10 个 `ctx.ui` 注册方法的完整契约、宿主协调架构、`ctx.action` 五端映射规则，以及插件持久状态（doc / sessionDoc）与公共数据的投影边界。类型唯一真源在 [`packages/protocol/src/plugin.ts`](../../packages/protocol/src/plugin.ts) 与 [`ui.ts`](../../packages/protocol/src/ui.ts)。插件开发的完整实战（目录结构、构建、发布）见[插件开发指南](../plugins/plugin-development.md)；插件系统设计总纲见[插件系统概览](../plugins/overview.md)。

## 宿主内部协调架构

`PluginHost` 是插件生命周期的唯一协调者（启停状态机与拒绝边界见[架构总览](overview.md#插件宿主生命周期与停止重载边界)）。服务启动遵循**全局 prepare → start 屏障**：`PluginHost.start` 先对全体已启用服务执行 `prepare()`，全部完成后才依次 `start()`（如 `builtin:workflow` 在 `prepareRecovery` 中先于 SDK 调度器落持久中断标记），随后恢复调度器；热启用同样先 prepare 后 start。停用预检分两层：`liveTasks()` 声明在途运行任务（非空即 `409 plugin_has_live_tasks`，不可 force），`inUse()` 声明持久生效资源（非空默认 `409 plugin_in_use`，可显式 force）。

宿主内的子注册表分工：

| 组件 | 职责 |
| :--- | :--- |
| `CapabilityRegistry` | 动作、工具与原始路由的注册、Schema/路径冲突校验与五端映射 |
| `CapabilityServiceRegistry` | `ctx.provide` / `ctx.consume` 类型化能力注册、自动生命周期释放与变更观察（内核 `ModelRegistry` 经此消费 `helmx.model-tiers`） |
| `PluginDocRegistry` | 全局 `ctx.doc` 与按会话分片 `ctx.sessionDoc` 的持久化与发布 |
| `PluginKvRegistry` | `ctx.kv<T>(namespace)` 按键持久存储、边界校验、SecretStash 脱敏与 256 KiB 单条上限 |
| `UiRegistry` | 界面声明校验、跨插件冲突裁决（priority），经注入端口请求客户端构建产物 |
| `RuntimeToolRegistry` | 注册与热更新内核/插件工具；`run_action` 调用与只读 `describe` |
| `HookBridge` | 协调内核每回合 Profile/技能上下文装配（`TurnContextAssembler`），按 scope 裁剪插件工具；钩子链收敛后同步投射 `profile.skills` 与动作目录 |
| `AssetReloader` | 纯文件资产（Profile/技能）的热重载协调 |

插件可通过 `ctx.host.onEvent` / `ctx.host.emitEvent` 观察与发布事件（内建宿主事件经 `@helmx/protocol` 的 `HostEventMap` 提供强类型载荷重载，自定义插件事件保持通用 `string` 回退）。监听器收到经过边界校验与脱敏的事件信封；订阅随插件生命周期解除。

动作与工具的认知入口均由声明驱动：`ctx.action` 默认进入 `<available_actions>` 目录，`exposeAsTool: true` 则使用独立工具声明，`ctx.tool` 提供模型专用工具。`promptSnippet` / `promptGuidelines` 仅在对应能力对当前会话可达时注入。完整参数 Schema 可用 `run_action({ actionId, describe: true })` 按需只读获取，不执行 handler。

## 后端：4 个生命周期 Hook

Hook 覆盖从输入提交到回合终态结算的完整调用链。处理器签名与载荷类型见 `HookPayloadMap`；注册时 `priority` 数值较大者先执行，同优先级按注册顺序（稳定排序）。

```typescript
export type HookName =
  | 'input'        // 每次提交输入（human/agent/trigger 三种 origin；支持 block 拦截）
  | 'before_turn'  // 回合推理前，可原地改写 tools/sections/messages
  | 'agent_spawn'  // 子代理派生（额外支持 around continuation）
  | 'turn_settled' // 回合终态（completed | failed | aborted 统一覆盖）
```

| Hook | 触发时机 | 典型应用 | 允许的控制流 |
| :--- | :--- | :--- | :--- |
| `input` | 输入提交 | 输入审计、斜杠入口门控、上下文预处理 | `continue / transform / handled / block` |
| `before_turn` | 回合推理前 | 注入记忆段落、动态增删工具 | `continue / transform` |
| `agent_spawn` | 子代理派生 | 接管外部运行时或包裹隔离生命周期 | `continue / transform / handled` + around |
| `turn_settled` | 回合终态结算 | 向中枢汇报、级联取消、记忆采集与自愈 | `continue / transform / handled` |

四种控制流的语义：`continue` 放行；`transform` 原地改写载荷交由后续处理器与内核消费；`handled` 短路接管并终止默认行为；`block` 门控拦截并附带显式 reason（仅 `input` 允许）。非法产物——缺 action、未知 action、该钩子不允许的组合、`transform` 缺 value、`block` 缺 reason——在宿主处显式抛 `invalid_hook_result`，绝不静默当 continue。

内核不内置巡检定时器，也不存在 `watchdog_tick` Hook：周期性任务一律由插件自管服务调度。

### agent_spawn 的 around 包装器

`agent_spawn` 额外提供受控 continuation（第二参数 `next`），是编排类插件包裹资源生命周期的关键机制：

- 不调用 `next` 而返回 `handled` = 完全接管派生执行；
- `await next(finalRequest)` = around 包裹：宿主恰好一次执行后续管道与默认原生执行行，插件可在 `next` 前分配资源、在 `next` 后按成败收敛（finally 语义）。`builtin:worktree` 以 priority 200 注册（后于 `builtin:workflow` 深度守卫的 300 = 更内层），在 `next` 前分配 Worktree、在 `next` 后按结果决定保留或清理；
- `next` 仅可调用一次，重复调用或与 `handled/transform` 混用显式拒绝；包裹期间抛错如实上抛，宿主不吞。

`AgentSpawnRequest.isolation`（如 `'worktree'`）是插件层策略 metadata，内核不解释该值：由具备对应能力的插件经 continuation 改写最终请求的 cwd/元数据兑现；无插件兑现而原样到达原生执行行时显式返回 `unsupported_runtime`，绝不静默忽略。

## 前端：全界面扩展点（client.tsx 单轨）

视图类扩展点统一采用 `client.tsx` React 组件单轨：`UiSpecBase` 只接受 `client: ClientComponentRef`（模块相对路径 + 具名导出），不接受声明式 JSON Spec——JSON 渲染能力由 `builtin:json-render` 插件经 `markdownCodeBlock` 提供。组件与宿主共享同一份 React 运行时（`@helmx/ui` 与 `@helmx/plugin-client` 分别虚拟化为宿主全局命名空间，不打包第二份 React）。输入补全（`composerCompleter`）是纯数据声明，不涉及组件。

`ctx.ui` 全部 10 个注册方法（与 `PLUGIN_UI_METHOD_NAMES` 双向锁定）：

| 方法 | surface | 说明 |
| :--- | :--- | :--- |
| `sidebarItem(spec)` | `sidebar.item` | 左栏导航项；`target` 如 `'conversation:1'`、`'screen:builtin:triggers/triggers'`；`quickEntry: true` 且目标为 screen 时，宿主在折叠 Rail / 移动抽屉常驻一键入口（目标 screen 必须实际存在，插件停用后随贡献即时消失） |
| `screen(spec)` | `screen` | 全屏自定义视图，支持左右 Split View 并排展示；可选 `description` / `keywords` 参与 Omnibox 索引 |
| `timelineRenderer(spec)` | `timeline.renderer` | 按 `kinds`（entry kind 列表）与 `matchMeta`（`data.renderer` 匹配，AND 组合）接管时间线条目 |
| `markdownCodeBlock(spec)` | `markdown.codeBlock` | 按围栏语言（`languages` 精确匹配小写化）接管 Markdown 代码块渲染 |
| `toolView(spec)` | `tool.view` | 按 `toolNames` 接管工具调用卡片；`replaceRow: true` 时完全替换外层默认工具行 |
| `composerCompleter(spec)` | `composer.completer` | `@ / # / :` 触发的候选数据源（纯数据，无 client） |
| `workbenchPanel(spec)` | `workbench.panel` | 会话右侧抽屉面板；`badge` 声明 doc 驱动的动态角标 |
| `command(spec)` | `commandPalette` | 全局搜索与命令（Omnibox，⌘K），支持 `actionId` / `client` / 声明式导航 `target`（至少声明其一）；`slash` 仍须绑定 `actionId` 并派生输入框 `/xxx` 菜单 |
| `settingsPanel(spec)` | `settings.panel` | 设置面板（同一插件可声明多个）；可选 `description` / `keywords` 参与 Omnibox 索引 |
| `slot(spec)` | `plugin.slot` | 向 `<ownerPluginId>/<slotName>` 子插槽注入组件 |

### priority 裁决与公共约束

`timelineRenderer`、`toolView`、`markdownCodeBlock` 与 `composerCompleter` 均支持 `priority`：数值较大者优先，缺省 0，同优先级保持贡献顺序。高优先级插件停用后由剩余候选接管。`command.slash` 不得占用宿主保留词（`new / clear / compact`），也不得与其他启用插件重名。所有 `spec.scope`（`ConversationScope`：conversationIds/tags/profileIds/modelProviders 字段间 AND、字段内 OR）同时约束可见性与执行——scope 是会话策略而非用户鉴权，无 conversationId 的人工 HTTP/CLI 调用不受限。

### 工具结果三通道、`ToolViewProps` 与分片时间线订阅

后端工具执行结果严格分离为三个正交通道，杜绝把大对象塞进模型文本或会话持久重放载荷：

- **`ctx.tool`（`PluginToolResultEnvelope`）**：返回裸字符串默认落入 `output`；返回对象时必须是显式信封 `{ output?, structuredOutput?, presentationMeta?, isError?, control? }`（信封携带裸 `details` 显式拒绝）：
  - `output`：交付给模型的文本通道（`string | Array<{ type: 'text', text: string }>`，受 32 KiB 溢出落盘门禁约束）；
  - `structuredOutput`：程序化/嵌套调用方的完整结构化结果（声明 `structuredOutputSchema` 后同步做 SecretStash 脱敏与 Schema 校验；**绝不自动镜像至持久化 `details` 或模型上下文**）；
  - `presentationMeta`：落盘到 `pi.tool-result.model[0].details` 供前端/时间线重放的有界普通 JSON 对象（不进入模型提示词与上下文用量），须声明 `presentationMetaSchema`，并在边界强制执行 SecretStash 脱敏、Schema 校验与硬上限（**64 KiB UTF-8、最大深度 12、最多 2000 节点**；拒绝原型键、不可枚举/Symbol 自有键、循环引用、稀疏数组、`undefined`、非有限数、函数/BigInt）；
  - `control`（`PluginToolControl`）：可选的回合后控制指令 `{ handoff?: string, terminate?: boolean }`（不得与 `isError: true` 同用，显式拒绝 `addTools` 与任何未知/原型键；`handoff` 须为非空非空白字符串，经 SecretStash 脱敏且 UTF-8 上限 **128 KiB / 131,072 字节**，超限直接拒绝 `invalid_tool_result`，绝不静默截断），由内核透传 `pi-durable` 原地写入 `pi.reset` 并在同回合干净上下文中继续或终止。
- **`ctx.action({ exposeAsTool: true })`**：`handler` 仍返回裸业务值并按 `outputSchema` 校验（透传为派生工具的 `structuredOutputSchema`，保持五端映射完全一致）；如需前端展示索引，可选声明 `presentationMetaSchema` 与纯投影函数 `projectPresentationMeta(input, output)`（非 `exposeAsTool` 动作或缺少 Schema 时在注册边界显式拒绝）。
- **前端 `ToolViewProps` 与 `useTimelineToolCalls(toolName)`**：
  - `tool.view` 组件收到 `ToolViewProps`（`callId / toolName / input / status / result / presentationMeta / resultTruncation / isError / startedAt / durationMs / artifactRef / conversationId`）；旧字段 `structuredOutput` 与 `siblingCalls`（及 `ToolViewSiblingCall`）已移除，组件直接消费 `props.presentationMeta` 并在缺失时回落纯文本错误摘要，**严禁 `JSON.parse(props.result)` 兜底**；`replaceRow: true` 的行由宿主在行首统一提供折叠 chevron 展开输入/输出面板，行主体仅在存在跳转目标（子会话抽屉、工作台 run）时作为导航按钮，组件无需也不应再自行渲染 `ToolCallDetails` 折叠入口；
  - 需要感知同时间线同类工具调用（如折叠多次 `subagent` 续接）的组件，通过 `@helmx/plugin-client` 的 `useTimelineToolCalls(toolName)` 订阅由 `ConversationTimeline` 经 `TimelineToolCallsContext` 提供的按 `toolName` 分片外部 store（元素为轻量 `TimelineToolCallSummary`，不含 `result` / `resultTruncation` 大载荷；无关工具或流式正文更新保持数组引用且零通知；脱离 Provider / 空 `toolName` / SSR 返回共享冻结空数组）。

### 参数化视图与输入区受控句柄

Screen 组件接收 `ScreenProps`：`pluginId / screenId / isSplit / params / setParams`。主屏参数在 URL Hash 中编码为 `sp.<key>`，分屏参数编码为 `ssp.<key>`——两边展示同一 Screen 时参数互相独立。`setParams(patch)` 默认替换历史记录，值为 `undefined` 删除对应键，`{ push: true }` 新增历史记录；组件不得直接操作 `history` 或自建路由。

屏内嵌套组件（不接收 slotProps）可从 `@helmx/plugin-client` 的 `useScreenParams()` 读取同一 scope：宿主 `ScreenHost` 在挂载的全屏视图外层建立 `ScreenParamsScope`（`params / setParams / isSplit`，与 `ScreenProps` 同一实现、绑定同一 pane，URL Hash 仍是唯一真相）；不在全屏屏内（如 settings.panel 复用嵌入）时返回 `null`——诚实缺席，绝不伪造 no-op scope。全屏页面壳统一复用 `@helmx/ui` 的布局原语：`Screen`（页面容器+页头；挂载于 `ScreenHost` 时 `actions` 经宿主顶栏动作槽 `headerActionsSlot` 落入 `.pane-actions`，与五大中心页头动作同位）、`ScreenSection`（分节）、`ScreenToolbar`（页头与正文之间的搜索/筛选/动作工具栏行，宿主公共类 `.screen-toolbar` / `.screen-toolbar-actions`）、`DataTable`、`KvGrid`；宿主样式绝不点名插件私有类名（`host-styles-boundary` 门禁锁定）。

输入区组件通过 `ComposerScopeProps.composer` 获得受控句柄：

```typescript
export interface ComposerController {
  readonly draft: string
  readonly attachments: ReadonlyArray<ConversationAttachmentRef>
  readonly sending: boolean
  setDraft(text: string): void
  insertText(text: string): void
  submit(text?: string, options?: { whenBusy?: WhenBusy }): Promise<void>
}
```

省略 `submit` 的文本参数时提交当前草稿及附件；显式提供文本时不消费原草稿；失败必须经 Promise 拒绝并展示诊断，不得视作发送成功。输入区子插槽继承同一控制器。

### 宿主保留插槽

宿主保留七个子插槽常量（单一只读协议目录 `HOST_SLOT_CATALOG` / `HOST_SLOT_TARGETS` 在 `packages/protocol/src/ui.ts`）：`PROFILE_DETAIL_SECTION_SLOT`（`builtin:profile/detail-section`，传 `ProfileDetailSlotProps`：`profileId / isNew / disabled`）、`NODE_DETAIL_SECTION_SLOT`（`builtin:node/detail-section`，仅已有节点挂载，传 `NodeDetailSlotProps`：`nodeId / isLocal / isOnline / isNew: false`）、`COMPOSER_TOOLBAR_SLOT`（`builtin:composer/toolbar`，主输入框左下角工具栏 `.composer-toolbar-left` 模型选择器之后，实会话传 `ComposerScopeProps`（`conversation / composer`），待命草稿传 `ComposerToolbarSlotProps`（`effectiveModel / profileId / draftMeta / setDraftMeta / disabled`，写入不标脏草稿）；用于激活态紧凑模式胶囊等轻控件，如 `builtin:plan` 的激活态退出胶囊）、`COMPOSER_MENU_SLOT`（`builtin:composer/menu`，主输入框左下角统一 `+` 下拉菜单内的模式/操作菜单项，实会话与待命草稿分别透传 `ComposerMenuSlotProps`（继承 `ComposerToolbarSlotProps` 并额外提供 `onCloseMenu`）；贡献 `DropdownMenuItem`，若插件已贡献此插槽则宿主会自动将其从通用插件命令分段去重）、`COMPOSER_STATUS_SLOT`（`builtin:composer/status`，输入框下方状态行上下文用量旁，实会话传 `ComposerScopeProps`，待命草稿传 `ComposerStatusSlotProps`；承载 `builtin:token-speed` 实时解码速率等只读指标与 `builtin:orchestrator` 编排器阶段胶囊、`builtin:magpie` 配额概览等紧凑状态交互）、`COMPOSER_DOCK_SLOT`（`builtin:composer/dock`，Composer 底部在途编排活动区，传 `ComposerScopeProps`）与 `OVERVIEW_CARD_META_SLOT`（`builtin:overview/card-meta`，会话总览卡片元信息区，传 `OverviewCardMetaSlotProps`：`rootConversation / memberIds`；只读徽标/跳转胶囊经 `ctx.ui.slot` 贡献，重操作留在插件自己的 screen/抽屉）。`builtin:profile`、`builtin:node`、`builtin:composer` 与 `builtin:overview` 是宿主保留命名空间，不代表存在同名插件。插槽不传接入令牌，也不隐式借用当前会话。

### 输入补全数据源

`composerCompleter` 是可序列化数据声明（`Omit<UiSpecBase, 'client'>`），不接受 client 回调。`trigger` 为 `'@' | '#' | ':'`（`/` 保留给宿主命令与技能）。`source` 三种：

- `{ kind: 'action', actionId, actionPluginId? }`：绑定声明为 `idempotent: true` 的查询动作，输入 `{ query, conversationId }`，输出 `{ items: ComposerCompletionItem[] }`。目标节点与目录由服务端读取真实会话解析，不信任浏览器自报坐标。
- `{ kind: 'doc', name, itemsField }`：读取贡献插件自己的公开文档顶层数组字段。
- `{ kind: 'sessionDoc', name, itemsField }`：同上，但按会话分片、按需订阅，不进全局广播。

每个候选提供 `id / label / insertText` 与可选 `hint / icon`；选中仅替换光标前的触发词，不提交输入或执行命令。动作源复用既有 Action HTTP 端点，不新增补全专用 RPC。

### 插件间组合

插件视图可从 `@helmx/plugin-client` 导入 `<PluginSlot name="cards" />`，其他插件用 `ctx.ui.slot({ id, target: 'owner-plugin/cards', client: { module, export }, ... })` 注入；`client` 为必填项（`plugin.slot` 在注册边界强制校验目标格式与 `client` 引用，不接受无 `client` 声明）。短名相对当前插件，全限定名显式指定；非法目标名、缺少宿主上下文、环检测与超出最大嵌套深度（16）均展示本地化显式告警并中止继续递归。`mode="list"` 渲染全部命中贡献（`priority` 降序、`order` 升序、注册顺序稳定排列），`mode="single"` 只取第一项；无命中时渲染 `fallback`（未传则返回 `null`，不留空容器）。有命中时容器附带 `data-helmx-slot="<ownerPluginId>/<slotName>"` 锚点：未传 `className` 时默认使用 `display: contents` 避免引入额外布局盒（`inline` 渲染 `<span>`），传入 `className` 时保留调用方 CSS 布局控制；每个子项重新绑定贡献者插件上下文并有独立 `ViewBoundary` 错误边界。

## client.tsx 单轨渲染机制

组件经 `ClientComponentRef { module, export }` 声明：`module` 是相对插件 `clientRoot` 的源文件路径（禁止绝对路径与 `../` 越根），`export` 是具名导出名。编译由宿主注入的插件构建端口（契约在 `@helmx/protocol`；产品在 hub 注入 `@helmx/plugin-build` 默认实现）按源内容 hash（含本地依赖）编译缓存；未注入端口的宿主对带 client 引用的声明在注册边界显式拒绝，不静默丢 UI。插件定义未声明 `clientRoot` 时，一切 client 引用在注册边界拒绝——不存在无法编译的悬空引用。

受控 npm 依赖统一经 `npmDependencies`（说明符 → 解析根）声明：内置插件指向 `@helmx/plugins` 包根；外部插件在清单声明 `clientDependencies`（plugin.json 或 package.json `helmx.clientDependencies`），宿主归一映射到插件自身目录并走同一编译链，编译器逐文件 containment 校验并随依赖 hash 复查——未声明的裸依赖显式拒绝，已声明未安装给出可诊断错误。

插件自有样式的托管链：本地 CSS 及根内 `@import` 由 esbuild 合并，通过保留导出 `__helmxClientCss` 内联为插件 JS 文本数据；宿主确认模块导入成功且加载仍有效后注入 `<style data-helmx-plugin-css>`，停用/卸载或登出时回收。资源 URL 支持 `data:` 与显式 HTTP(S) 地址，本地资源 URL 与远程 `@import` 显式拒绝。编译、导出校验或加载失败时宿主显示明确错误与重试入口，不把空白静默冒充加载成功。

`builtin:json-render` 与 `builtin:mermaid` 是扩展点之上的普通消费者：前者承载 JSON DSL 与界面原语，停用后宿主不再解析插件 JSON Spec；后者经 `ctx.ui.markdownCodeBlock({ id, languages: ['mermaid'], client })` 接管 ```mermaid 围栏，停用后回退普通代码块。两者停用时动作、工具与 UI 贡献即时消失，无宿主内置替代渲染。

**插件是可信代码**：client.tsx 与后端插件同样拥有宿主权限，可以读环境变量与进程内存、发起任意网络请求。宿主对插件做的边界（注册校验、scope 过滤、脱敏、在途任务跟踪）是治理与健壮性机制，不是恶意代码沙箱。安装第三方插件前应像审计依赖包一样审计其代码。

## 公开数据与会话分片投影

`ctx.doc(name, initial, { public: true })` 进入全局 SSE 首帧 `pluginDocs` 与 `plugin.doc.updated` 广播，适合全局设置或紧凑导航摘要（如 `builtin:workflow` 的 `run-badges` 只含计数、色调与底部短文案）。私有文档（缺省）不公开。全局文档单文档上限 2 MiB（超限 `413`）——高频会话级状态写入全局文档会造成首帧与广播写放大，这是引入 sessionDoc 的原因。

`ctx.sessionDoc(name, initial, { public: true })` 按 `conversationId` 持久化分片：不进全局首帧，也不向普通 `/api/events` 发送会话文档事件。读写句柄为 `get/set/update/delete(conversationId, ...)` 加 `listConversationIds()`；会话删除清理其文档。客户端 `usePluginSessionDoc(name)` 使用当前槽位会话，也可显式指定 `{ conversationId, pluginId }`；专用 SSE 首帧提供当前值与水位，后续只传该元组的更新，重连重新取首帧。

句柄的 `get/set/update` 同步镜像，`flush()` 等待底层排队写真正落盘——副作用执行前必须 `await flush()`，防止「未落盘就派生副作用」；flush 失败显式 reject。

HTTP 与 CLI 同权访问会话文档：

```bash
# 一次读取
pnpm helmx plugins doc builtin:workflow runs --conversation 42 --json
pnpm helmx plugins doc builtin:workflow runs --current --json        # 从 HELMX_CONVERSATION_ID 解析

# 持续订阅（专用 SSE：GET /api/plugins/:id/docs/:name/events?conversationId=N）
pnpm helmx plugins doc builtin:workflow runs --current --watch --json
```

`builtin:workflow` 是这一投影模型的基准用例：完整运行摘要放入会话文档 `runs`（每会话只写自己的 run）；全局 `workflow.updated` 事件仅含 `id / conversationId / status` 提示，不旁路广播完整摘要；摘要无变化时不重复发布。这样全局首帧与广播通道免于运行详情的写放大，而 `runs` 明细按需订阅。

停用插件后，其公共文档快照不再进入首帧、订阅随生命周期移除；私有文档与 `ctx.kv` 数据保留在 `state.sqlite`，重新启用后可继续读取，卸载受管包时统一清除（开发阶段不承诺格式兼容）。

## 插件间能力注册、KV 存储与原始 HTTP 路由

### 类型化能力注册表（`ctx.provide` / `ctx.consume` / `ctx.onCapabilityChanged`）

插件通过 `ctx.provide<T>(capabilityId, impl)` 向宿主注册强类型能力实现，返回幂等释放函数；其他插件通过 `ctx.consume<T>(capabilityId)` 读取当前活跃插件提供的实现列表（`ReadonlyArray<{ pluginId: string; impl: T }>`），并可通过 `ctx.onCapabilityChanged(capabilityId, listener)` 订阅活跃提供方变更（返回幂等退订函数，随停用/停止/回滚自动释放）；内核子系统亦可通过只读 `PluginHost.consumeCapability<T>(capabilityId)` 与 `onCapabilityChanged` 消费能力，避免为单个插件在 `ctx.host` 开设专用端口：

- **标识与生命周期边界**：`capabilityId` 在注册、消费与订阅边界均按 `^[a-z0-9][a-z0-9._-]{0,63}$` 强校验；受插件 epoch 守卫约束；插件停用、停止、回滚或卸载时宿主自动释放其提供的全部能力与监听订阅，非活跃（disabled / deactivating / failed）插件的实现即时从 `consume` 视图消失。
- **典型内置契约**：
  - `helmx.dispatch-tools`：`DispatchToolsCapability`（`{ toolNames }`），`builtin:workflow`（`['subagent', 'SubagentWorkflow']`）与 `builtin:swarm`（`['swarm_dispatch_worker']`）声明派工入口工具：`builtin:mentions` 消费 `toolNames` 决定 `<available_profiles>` 协作目录（`mentions.catalog`）注入与 `@` 补全（停用后即时消失），`builtin:workflow` / `builtin:swarm` 的深度守卫按 `toolNames` 剥离派工入口（确保第 1 层 Swarm 成员保留看板通信工具）；
  - `helmx.planning-orchestration-tools`：`PlanningOrchestrationToolsCapability`（`{ toolNames }`），`builtin:workflow`（`['subagent', 'SubagentWorkflow', 'workflow_steer']`）与 `builtin:swarm`（`[...SWARM_TOOL_NAMES]`）声明规划阶段仍允许放行的编排工具，`builtin:orchestrator` 在规划阶段（Planning Phase）动态消费并叠加到只读工具白名单（零硬编码工具名，任意第三方编排插件自动生效）；
  - `helmx.default-child-model`：`DefaultChildModelCapability`（`resolveDefaultChildModel(parentConversationId)`），`builtin:orchestrator` 提供默认子代理/成员模型解析（映射至活跃编排器会话的 `executorModel` 与 `executorThinkingLevel`），由 `builtin:workflow` 与 `builtin:swarm` 在省略显式 `model` 时消费；
  - `helmx.plan-mode-active`：`PlanModeActiveCapability`（`isPlanning(conversationId)`），`builtin:plan` 提供只读计划模式探测，供 `builtin:orchestrator` 等插件避让 `/plan` 规划回合；
  - `helmx.conversation-depth`：`builtin:swarm` 等派工插件提供 `depthOf(conversationId)` 上报 `{ depth, leaf? }`，由 `builtin:workflow` 在单一 `maxSubagentDepth` 策略（默认 `1`）下统一消费，执行 `before_turn` 剥离与 `subagent_depth_exceeded` 守卫；
  - `helmx.model-tiers`：`builtin:tiers`（单模型档位）与 `builtin:orchestrator`（编排器，`preserveRef: true` / `singleTurnEligible: false`）均实现 `{ getTiers, onChanged }`，由内核 `ModelRegistry` 统一聚合冲突校验、目录投影与变更重对齐；
  - `helmx.search`：`PluginSearchProvider`（`search(input, signal)`），内置 `workflow` / `triggers` / `tiers` / `orchestrator` / `port-forward` 等插件按需提供动态资源检索，由组合层 `GET /api/omnibox/search` 与 FTS5 会话检索并行聚合（单插件 200ms 隔离超时、每插件最多 8 条、运行时结构校验、`SecretStash` 脱敏，并经 `failedPlugins` / `messagesUnavailable` 如实回报局部异常；插件停用即时释放）。静态插件配置项检索另走独立端点 `GET /api/plugins/config-catalog`（脱敏且不膨胀 SSE `PluginSummary`）。

### 轻量按键持久存储（`ctx.kv`）

`ctx.kv<T>(namespace)` 返回绑定 `(pluginId, namespace)` 的 `PluginKvHandle<T>`，底层落盘 `state.sqlite` 的 `helmx_plugin_kv(plugin_id, namespace, key, value_json, updated_at)`（内置参考消费者：`builtin:worktree` 的 `worktrees` / `leases` / `agent-bindings` 三命名空间）：

- **接口**：`get(key)`、`set(key, value)`、`delete(key)`、`list({ prefix?, limit?, cursor? })`（按 UTF-16 code-unit 确定性排序与游标分页）、`clear()`、`flush()`；
- **边界与安全**：`namespace`（`^[A-Za-z0-9._-]{1,64}$`）、`key`（1..256 可打印字符）与分页参数在边界强校验；`set` 经 `redactJsonValue` 校验 JSON 合法性并过全局 `SecretStash.redact` 后按单条序列化落盘，单条上限 **256 KiB**（超限显式 `413 plugin_kv_too_large` 且不破坏旧值）；受 epoch 守卫（停用后旧句柄拒绝，受控 `stopWindow` 内允许收尾写回与 `flush()`）；卸载插件时随 `purgePluginPersistentData` 彻底清理。

### 原始 HTTP 路由（`ctx.route`）

`ctx.route({ method, path, public?, handler })` 挂载于 `/api/plugins/<encodeURIComponent(pluginId)>/routes<path>`：

- **方法与参数提取**：支持 `GET | POST | PUT | PATCH | DELETE | HEAD`；`:param` 路径段经严格 percent-decoding 后作为只读 `{ params }` 经第二参数传入 `handler(req, ctx)`（既有单参 `handler(req)` 无缝兼容；静态路径优先于同长度参数化路径）；
- **注册期冲突检测**：同一插件内相同 HTTP 方法与碰撞路径结构（如 `/items/:a` 与 `/items/:b`，或重复参数名）在注册期即显式拒绝（`400 validation_error`），杜绝静默遮蔽；
- **流式在途跟踪与自动脱敏**：非空出站流（如 SSE / chunked）在 EOF、错误、消费方取消或 `request.signal` 中止前计入插件 `liveTasks`（缓冲单块响应即时释放）；`text/*`（含 `text/event-stream`）与 `application/x-ndjson` 直接经流式脱敏输出（零全量缓冲）；`application/json` 与 `*+json` JSON 感知脱敏上限 **4 MiB**，超限时无缝切入流式脱敏而不截断或损坏内容（保留状态码与自定义响应头、清除过时 `content-length`）；二进制流（如 `application/octet-stream`）零缓冲直接透传；
- **前端鉴权调用**：插件视图通过 `usePluginContext().fetchRoute(path, init?)` 调用自身路由——宿主自动注入 Bearer Token（不向插件代码暴露明文令牌）、校验 `path` 以 `/` 开头且不逃逸当前插件路由命名空间，并原样返回浏览器 `Response`。
