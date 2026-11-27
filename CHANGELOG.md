# Changelog

## v0.6.0 (2026-11-27)

### 升级须知

- **`helmx worktrees inspect` 不再输出 diff**：现在只返回文件清单、增删行数和提交列表，不再跑全量 diff，也不会因为改动太大而超限。想看某个文件的具体改动，用新命令 `helmx worktrees file <worktreeId> --file-path <path>`。
- **工作流时间线里的「清理工作树」按钮已移除**：需要清理时，让智能体调用 `cleanup_worktree`，或执行 `helmx worktrees cleanup`。
- **Swarm 的完工汇报不再等所有人**：成员发 `done` 并要求唤醒主控时，只等它自己这一回合结束就上报，不再等其他还在运行的成员。

### 模型档位：规划与执行自动分工

- **双相编排档位**：一个档位配两个模型——规划模型负责读代码、想方案，执行模型负责动手改。会话默认由规划模型接手，一旦决定要改代码就自动切到执行模型，连续执行若干步后再自动交回规划模型复盘。默认最多连续 30 步，设为 0 表示不限。
- **子代理自动用执行模型**：双相编排会话里派出的子代理（包括多层嵌套的）统一使用执行模型，也看不到档位目录，不会自己乱选模型。
- **「仅下一轮」借用模型**：模型选择器顶部新增「仅下一轮」标签，选一个模型只用一轮，回合结束自动换回原模型。模型也可以用 `switch_model` 在同一对话里临时接力。即使还没配置任何档位，也能直接借用具体模型；双相编排会话同样可用，用完自动回到规划模型。
- **档位管理页重做**：改为卡片网格加右侧详情抽屉，新建、编辑、另存为模板都在抽屉里完成。
- **思考等级显示更准**：选择器和档位行上的思考等级改为显示实际生效的默认值（先看档位预设，再看按模型默认）。

### 两个新插件

- **端口映射（`builtin:port-forward`）**：把 Hub 本机的一个端口转发到某个计算节点上的服务，方便在本机直接访问远端节点里启动的网页、数据库或调试端口。提供管理界面和 `helmx port-forward` 命令。默认只允许本机访问，要监听到外部地址需先在插件设置里开启。
- **改动检视（`builtin:changes`）**：在一个地方查看 Git 改动，无论是直接改在主工作区，还是在受管工作树里。支持未提交、未推送和指定提交等范围，点文件即看 diff，手机上可以逐个翻文件。会话右侧工作台新增「改动」面板，工作流和 Swarm 面板里的工作树入口也会跳到这里。全程只读，不会替你改代码。

### 节点接入更省心

- **接入命令自动选对地址**：`helmx nodes issue` 会自动挑一个远端机器能访问的 Hub 地址来生成接入命令，`helmx nodes endpoints` 可查看全部可用地址（局域网、VPN、公网、主机名等）。Web 节点详情里可以切换地址或填自定义地址；Hub 只监听本机时会明确提示。
- **接入指引拆成两步**：第一步安装节点客户端（只需一次，需要 Node.js 24.12 以上），第二步接入并后台启动。
- **换令牌不用手工停进程**：重新签发令牌后，在节点上执行 `helmx-node restart --token <新令牌>` 即可换上新令牌；新令牌无效时不会停掉正在运行的守护进程。
- **其他**：主机名只有短名时自动发现完整域名；Web 上可以直接删除节点，令牌立即失效、连接立即断开。

### 界面

- **宽屏停靠工作台**：屏幕宽度超过 1280px 且未分屏时，右侧的工作台、子会话和子代理不再盖住主对话，而是停靠在旁边，子会话与主对话各占一半。每个会话记住自己打开的面板，切回来自动恢复。
- **手机体验**：适配刘海和底部手势条的安全区，键盘弹出时输入区自动避让，触控细节多处优化。
- **会话总览**：卡片状态灯和菜单样式统一，卡片加宽、编号靠左；原来的「静默」分组改名为「空闲」，侧栏同步。
- **Swarm**：活动托盘展开多个成员时不再被压扁；看板消息和协同唤醒在时间线里显示为可折叠卡片，点开即看正文，唤醒方式与默认不同的会打上标记。

### 修复

- **Swarm 偶发「没人再催」**：成员回合刚结束的瞬间如果正好赶上主控投递新任务，后续催促可能被吞掉，现已修复。
- **Swarm 唤醒更及时**：显式唤醒主控的消息会立即上报，不再被同一回合里的其他长任务拖住。
- **关闭 Hub 时偶发报错**：后台子代理刚完成时正好关闭 Hub，会抛出 `plugin_host_disposed` 未捕获异常，现已修复。
- **跨进程文件锁更可靠**：清理过期锁之前先确认持有者确实已退出，避免并发时误删别人正在用的锁；锁的恢复没有结论时会给出明确的处理提示。
- **其他界面问题**：宽屏切换会话后停靠面板丢失、停靠工作台宽度跳动、窄屏下页头按钮图标偏位，均已修复。

### 开发与工程

- **接口定义统一**：Hub HTTP 接口、`helmx` 命令行和 Web 现在共用同一份接口定义，路由匹配、参数校验和命令行标志的行为保持一致。
- **`pnpm verify` 更快**：改为并行编排，并去掉了测试里大量多余的子进程和固定等待。
- **CI**：GitHub Actions 升级到 v5，标准 runner 的测试并发设为 3，并修复了几处导致 CI 偶发失败的测试问题。
- **内部重构**：拆分了内核、Web、插件和 CLI 中一批超大的组件与模块，对外行为不变。

## v0.5.0 (2026-11-26)

### 升级须知

- **子代理默认派生层级由 2 调整为 1**：主会话直接派生的 `subagent`、工作流节点与 Swarm 成员默认即为叶子，不再注入 `subagent` / `SubagentWorkflow` 工具与角色目录，再派生返回 `403 subagent_depth_exceeded`。需要嵌套派生时显式传 `maxSubagentDepth`（2..5），或配置插件项 `builtin:workflow.maxSubagentDepth`。Swarm 成员（含非 `forkFrom`）统一上报 `depth=1`，默认不再持有 `swarm_dispatch_worker` 与 `swarm_create_group`；`forkFrom` 成员固定为叶子，调高全局上限也不变。人工 `conversations fork` 与直接创建子会话不受限。
- **移除全局 `/` 单键聚焦页面搜索**（v0.4.0 引入）及快捷键总览中的对应条目；输入框内键入 `/` 调出斜杠命令菜单、`Mod+/` 打开快捷键总览不受影响，搜索框 `Esc` 先清空再失焦的行为保留。
- **`plan_ask` 工具移除**：计划模式的澄清提问改用内核内建工具 `ask_user`，计划模式工具白名单仍为 7 个。
- **插件 `ctx.ui.command` 的废弃别名 `surface: 'command'` 正式移除**：只接受 `surface: 'commandPalette'`，仍声明旧值的命令不会出现在命令面板。

### 提问与审批

- **内核内建工具 `ask_user`**（归属 `core:ask_user`，仅注入顶层人类会话，子代理与 `ownedBy: 'helmx'` 会话自动剥离）：一次提出 1~4 道题，题型 `single_select | multi_select | text | confirm`，选项 2~8 个，可标记 `recommended` 推荐项、`allowCustom` 内联「其他」自由输入；文本题支持 `multiline` 与 `placeholder`，确认题支持自定义 `confirmLabel` / `rejectLabel`；`required` 缺省为真。任何顶层人类会话由此获得结构化澄清能力，不再依赖计划模式。
- **AskDoc 契约通用化**：新增 `kind: 'question' | 'approval'`（缺省 `approval`）；选择题支持多选（答案为字符串数组）、`allowCustom` 与 `recommended`；文本题支持 `multiline` / `placeholder`；确认题支持 `confirmLabel` / `rejectLabel`。`POST /api/asks/:id/answer` 与 `helmx asks answer --answers` 同步接受字符串或字符串数组，`ask.resolved` 事件携带答案，字段放错类型返回 `400 validation_error`。
- **新输入统一结算挂起提问**：人类直接发送新消息（`whenBusy` 不是 `reject`）时，内核在提交后把该会话所有挂起 AskDoc 结算为 `superseded`（此前只有计划插件处理自家审批单）；`superseded` 结果明确告知模型「没有结构化答案，不得视为确认，先读新消息，不要重复提问」。启动时清理残留的 `core:ask_user` 提问单。
- **输入待答卡守卫 `whenPendingAsk`**：`POST /api/conversations/:id/input`、`core:conversations.send`、`helmx send --when-pending-ask <supersede|reject>` 与 `input` Hook 的 `transform` 均可指定。缺省 `supersede`（行为同此前）；`reject` 时存在挂起 AskDoc 则原子返回 `409 ask_pending`（附 `conversationId` 与 `pendingAskIds`），不落条目、不改标题、不推进状态水位，供 IM / 纯文本通道避免误作废提问。配套新增 `docs/architecture/ask-doc-channels.md`（通道接入、字段文本映射、CAS 纪律）。
- **`GET /api/asks` 支持过滤**：`?conversationId=<id>&status=pending|answered|cancelled|superseded`，`core:asks.list` 的同名参数改为下推查询；CLI `helmx asks list [--conversation <id> | --current] [--status <状态>]`。
- **待答卡不再被界面操作误杀**：提问挂起期间，只改 `unread` / `pinned` 的 `PATCH /api/conversations/:id` 不再推进 `stateChangeSeq`；`blocked` 期间并行工具的进度摘要刷新同样不推进。标题、标签、模型、角色、节点、目录等实质变更照旧推进。计划模式在 `whenBusy: 'reject'` 或 `whenPendingAsk: 'reject'` 且有待答审批时不再进入，也不作废挂起卡。

### AskDock 提问界面

- **点选即答与全键盘操作**：单题单选提问点击选项立即提交；多题以 `1/N` 步进器呈现，点选后跳到下一未答题，末题按 `Enter` 或点「确认」提交。卡片出现时若焦点在中性位置或空输入框则自动聚焦首个控件；焦点不在输入类控件时由窗口层接管 `↑` `↓`、数字键 `1`~`9`、`Enter`、`[` `]`、`PageUp` / `PageDown`，多题支持 `←` `→` 切题；`Esc` 先把焦点移到「跳过 / 取消」，再按才走全局中止；输入法组合中的按键不触发提交。结算最后一张卡后焦点回到输入框，多卡堆叠时自动聚焦下一张。
- **问答按时间线原位展示**：`ask_user` 提问行不参与折叠，按时间顺序独立展示，行内给出「问题 → 回答」摘要与已回答 / 已跳过 / 已取代 / 失败徽章，展开只显示问答内容（不再附带 Raw JSON）。
- **界面精简**：去掉头部状态灯、归属插件与 CAS 水位信息弹层、第二行步骤胶囊；通用标题「问题确认」时把题干提升为卡片标题；「推荐」改为纯文字徽标；窄屏隐藏快捷键提示。选中项由强调色底改为中性灰底，单选仅在选中项显示对勾。

### 会话时间线

- **按轮次加载**：会话详情新增 `turns` 分页（`GET /api/conversations/:id?turns=1..50`、`core:conversations.get`、插件 `ctx.host.getConversationDetail`、CLI `helmx conversations get --turns <n>`），每页为最新 N 个完整回合，`nextCursor` 精确落在回合边界；与按条目数的 `limit`（1..500，服务端缺省 100）互斥，同传返回 `400 validation_error`。单个超长回合单页最多收集 200 条、硬上限 500 条，不会为凑满一页无限向前扫描。Web 端默认改按轮次拉取：桌面 10 回合、窄屏（≤680px）5 回合，长回合不再被条目数从中间截断。
- **向上翻页不跳动**：加载更早内容导致回合容器重新挂载时按底部坐标恢复阅读位置；流式输出在尾部增长时不再误把阅读位置往下推；只插入更早条目时不误触「贴底」。首页落在长回合中段时「加载更早」最多自动补拉一页，补拉失败保留已加载内容并记入加载错误。
- **时间线卡片折叠入口统一**：默认工具行、`ask_user` 行与过程组的折叠箭头统一在行首，行尾只保留状态、耗时与徽章；子代理、工作流、Swarm、计划等卡片（`replaceRow`）的入参 / 输出开关挪到行首同一位置，宿主 IO 面板成为唯一展开入口；没有跳转目标的行不再可点击，有目标的行以 `external-link` 图标提示。
- **后台活动期间信息完整**：后台子代理仍在运行时，已结算回合下方的时间、耗时与模型标签照常显示（耗时沿用父回合自身数据），「复制」与「分叉」可用，仅收起会回退历史的「重新生成」；活动结束后恢复。
- **Markdown 渲染统一**：上下文分割线（精简摘要 / 重置交接）的展开内容由纯文本改为 Markdown；工作流执行节点的 prompt 与字符串输出按 Markdown 渲染；计划、Swarm 帖子、工作流结果与后台汇报统一使用宿主 `MarkdownView`，排版一致并支持文件与产物链接预览。助手正文标题字号收敛为 1.35 / 1.2 / 1.08 / 1em，裸代码块补底色与边框；`#` 锚点链接不再新开标签页，大纲与滚动定位只索引回合正文的标题，忽略工具卡片内嵌套的标题。
- **跨 worktree 文件链接预览**：Markdown 中的绝对路径与 `file://` 链接此前只有落在当前会话工作目录内才可预览，现在回退到「同一会话树、同一节点」内其它会话的工作目录去匹配（最长前缀优先），在主会话或评审会话里可直接点击子代理 worktree 的文件链接并定位行号；相对路径、其它会话树、其它节点与树外路径仍不解析。
- **触屏点按不再粘滞高亮**：全部 `:hover` 规则（Web 与内置插件共 27 个样式文件）只在 `@media (hover: hover)` 内生效，并在 `html` 全局关闭系统原生点按高亮，按压反馈统一走 `:active`；`check:hygiene` 新增 `hover-media-gate` 红线，未门禁的 `:hover` 规则直接失败。

### 通知、表单与界面一致性

- **悬浮通知统一**：Toast 改为右上角的 Quiet Surface 卡片（最新在最上，最多显示 4 条，层级置于抽屉与模态之上），弹窗或抽屉打开时操作 Toast 不再连带关闭弹窗。模型与全局默认面板、插件配置、档位管理页、长期记忆等处的行内「已保存」文字改为悬浮通知；插件安装、配置项重置与密钥清除、长期记忆保存、每日整理暂停 / 恢复、立即触发 cron、删除 cron / webhook、删除档位模板、Magpie 手动刷新目录等此前没有反馈的操作补上成功通知，失败仍走行内错误。
- **表单不再被后台刷新冲掉**：模型中心网关详情抽屉只在打开、切换网关或切换新建模式时重置表单，SSE 刷新不再清掉未保存的 API Key、地址与模型开关，过期的测试连接 / 刷新 / 保存结果被丢弃；角色详情抽屉同理，详情拉取返回时保留已改字段。
- **输入框在途操作隔离**：切换会话后，上一会话的附件上传失败提示、清空上下文完成提示、斜杠命令失败后的草稿恢复不再作用到新会话。
- **键盘聚焦与悬停同款**：按钮、导航行、工具行、页签、下拉项、分段控件的 `:focus-visible` 不再画亮色外圈，改为与 `:hover` 相同的底色与字色。
- **角色技能白名单支持搜索**：候选技能 6 项起显示搜索框，按名称 / ID / 描述大小写不敏感过滤，被过滤隐藏的已选技能保持选中；有技能但无匹配时提示「没有匹配的技能」；焦点在搜索框时 `Esc` 先清空关键词，输入法组合中不关闭抽屉。

### 子代理、工作流与 Swarm

- **防重复派工**：同一父会话在途的「完全同参」`subagent` 调用（规范化签名含 prompt、label、agentType、节点、cwd、隔离方式、fork / resume、模型与思考等级、gate、schema、附件，忽略 callId 与 background）第二个返回 `duplicate_subagent_call`；`label` 不同、同 callId 重放可放行，终态后解除。
- **中止后可清理 worktree**：同步子代理（`background: false` + `isolation: 'worktree'`）被中止时，结果保留 `status: 'aborted'`、执行会话 ID 与 worktree 的 id / path / branch，worktree 不自动删除，可凭 `worktreeId` 调 `cleanup_worktree`；时间线该行直接提供清理按钮。新增插件 API `setAbortFallback`，仅在工具任务因中止结算时合入最终结果（脱敏并按 schema 校验）。
- **`agentType` 前置校验**：只接受空串、原生 Profile ID 或外部运行时 `<namespace>:<kind>`；误填模型档位 `tier/<id>` 提示改走 `model`，误加 `@` 前缀提示去掉，均在分配 worktree 之前返回 `400 validation_error`，不再留下孤儿工作树。入口覆盖内核 `agent_spawn`、`subagent` 参数与 DSL `agent()` / `goal()` 的 `opts.agentType`。
- **计划模式只读守卫加固**：`plan_bash` 修复三类绕过——算术展开 `$(( ))` 内嵌套命令替换、子命令前置参数（如 `pnpm --dir <目录> install`、`npm --prefix`、`docker -H … rm`、`git stash -m list push`，未知前置 flag 一律拒绝）、未加引号 heredoc 正文中的命令替换与未闭合 heredoc。审批落盘失败时回滚内存状态（保持 `planning`、保留待答卡）；计划与运行角标各限 200 条，超限淘汰最早的终态条目。
- **Swarm 与触发器并发修复**：同一协调会话并发建组按会话串行，重复建组返回 `swarm_group_already_active`（同 `createKey` 幂等）；`cron_delete` 等待在途 claim 释放写锁后再删，落盘失败回滚任务并恢复定时器；`webhook_delete` 落盘失败回滚元数据并保留 secret，不再误报 `webhook_delete_secret_failed`；cron 投递失败的错误信息与通知正文先脱敏再记录。
- **其它内置插件修复**：`token-speed` 已见条目超限改为淘汰最旧一条（此前整表清空可能重复计数）；`json-render` 声明式输入本地编辑后，远端值变化时重新同步（此前永久忽略后续更新）；删除角色时 `memory` 即时清理该角色的禁用与初始化记录；Swarm 面板卸载或切换会话后迟到的 `abort_worker` / `close_group` 回调不再执行；KV 分页遇到重复或环回的 `nextCursor` 立即终止（此前可能死循环）。

### Hub、节点与 CLI 稳定性

- **CLI 如实报错**：`helmx models filter --provider <id>` 不带 `--disable` / `--clear` 时误入写分支、清空该提供商禁用模型列表的问题已修复，现为纯只读；读响应体失败不再被吞成空结果，按超时 / 中止 / `invalid_response` 报错，SSE 响应非 `text/event-stream` 或含非法 UTF-8 同样报错；`--tags` 非法 JSON 返回 `invalid_flag_value`；`plugins install --enable` 启用失败退出码为 1 并带 `enableError`；约 30 个命令的多余位置参数显式拒绝（`unexpected_positional`），不再静默忽略；`profiles --system-file` 与插件动作的文件位置参数按会话 `cwd` 解析而非进程目录；`plugins types` 支持 JSONC 形式的 tsconfig，同步前备份 `.helmx/types`、失败回滚。
- **Hub 关闭与升级**：关闭步骤按序执行并逐项记录错误，不再相互掩盖；`/api/hub-update/apply` 的 `force` 不再因 Content-Type 大小写被忽略；损坏的 `hub-control.json` / `update-ready.json` 显式报错，不再伪装成「无记录 / 无更新」；适配器 500 兜底日志先脱敏再输出；`helmx stop` / `helmx update` 遇损坏控制记录同样显式报错。
- **节点守护进程**：环境 LRU 不再逐出仍有活跃命令的环境（此前被逐出后清理不到进程，留下孤儿进程）；心跳排队串行发送，升级提交确认后不再每次心跳重发；隧道客户端在已中止的 signal 上不再建连，收到 `ok` 时复核连接代次（不再交付孤儿流）；节点隧道 hello 首帧兼容分片 `Buffer[]` / `ArrayBuffer`；env-io 过期锁清理改为原子隔离，shell 探测超时后立即结算且输出限 64 KiB（此前可能被脱离的孙进程挂死）。
- **模型配置**：全局 `defaults.thinkingLevel` 此前在构造时被丢弃，现已生效；非法思考等级精确报出出错字段（`compactionThinkingLevel` / `modelThinkingLevels['<模型>']`）；清除已禁用模型的思考默认不再被 `409 model_disabled` 拒绝（设置仍拒）。
- **工作目录护栏**：`restrictToCwd` 会话以 `agentType` 指向其它节点上的角色时，`spawnAgent` 入口即返回 `403 path_outside_workspace`（此前因无显式 `nodeId` / `cwd` 被放行）。
- **协议与插件构建边界**：`meta` 含 `__proto__`、symbol 键、accessor 或不可枚举属性返回 `meta_invalid`；`moduleRef` 拒绝 `.tsx` 与 `sub/./x` 形态；插件配置字段 schema 拒绝未知属性与 secret 字段带 format，`PUT` 插件配置值新增接受字符串数组；`auth setup` / `login` 请求多余字段返回 `400`。`plugin-build` 严格校验 `npm:` 依赖规格，tarball 剔除符号链接、`.git` 与 `node_modules`，本地重装失败回滚；前端构建缓存补齐包含性校验与上限；插件 CSS 作用域化不再误删字符串字面量中的 `/* */`。
- **其它**：首次创建的默认角色名改为 `Personal Assistant`（已存在的角色不受影响）。

### 发版脚本

- `pnpm release --dry-run` 只预览变更明细与计划动作，不再运行本地门禁；自动汇总的变更明细按 `--no-merges` 结构性排除 merge 提交（覆盖中文 `merge(x):` 等标题）。

## v0.4.0 (2026-11-26)

### 计划模式

- **新增内置插件 `builtin:plan`（第 13 个内置插件，默认启用）**：顶层人类会话可进入只读调研与计划审批闭环。入口为输入框 `+` 菜单「计划模式」、`Ctrl+.`、`/plan` 或 `/plan <任务>`（CLI：`helmx plan toggle --current`）；待命页可预先开启，首条消息发出时才真正进入。进入后本回合工具收紧为七个：`read`、`read_artifact`、`load_skill`、`plan_bash`、`plan_ask`、`plan_save`、`plan_propose`；`plan_bash` 经只读 Shell 守卫校验后才执行（拦截写重定向、变更命令与命令替换，对 `helmx` CLI 只放行有界只读查询，`env` / `exec` / `xargs` 合并短参数无法绕过）。
- **澄清、草拟、审批与交接**：`plan_ask` 发起 1~4 题的单选澄清卡；`plan_save` 多轮草拟自包含计划，可在右侧「执行计划」面板直接编辑（带版本冲突校验）；`plan_propose` 生成审批卡，可选「批准并在新上下文执行」「批准并在当前上下文继续」「退回修改」，并指定执行模型与思考等级。批准后计划归档为会话产物 `plan-v<N>.md`；选新上下文执行时内核在同回合重置上下文继续生成，切换执行模型失败则停留在计划模式并显式报错。审批或澄清挂起期间直接发送新消息，会以 `superseded` 结算挂起单，输入不再被卡住。

### 模型档位

- **单轮模型借用**：模型选择器新增「仅下一轮」模式，或执行 `helmx tiers set-borrow --current --model <目标> [--effort <等级>]`，临时切到任意档位或具体模型完成当前回合；回合结算且空闲后无损恢复原模型（含继承 Profile / 全局默认的状态）。期间人工改选或清空模型则以人工操作为准，只清理借用记录、不覆盖。未配置任何档位时也可直接借用具体模型。目标不可用返回 `409 model_unavailable`，不静默回退。
- **同会话模型接力 `switch_model`**：顶层会话的模型可调用 `switch_model({ model, effort?, restoreAfterTurn? })` 在同一线程切换下一推理步的模型，默认回合结束后自动恢复，`restoreAfterTurn: false` 则永久切换。仅顶层人类会话可用，子代理与后台会话不注册该工具与「仅下一轮」模式。
- **思考等级如实显示**：选中 `tier/<id>` 时，选择器按钮显示档位自带的预设等级；等级钳制与内核同序（不支持的等级先向上找最近支持档再向下，显式 `off` 透传）。修正默认模型思考等级解析链，模型中心「当前生效」与角色卡片按同一规则展示。

### 输入框与快捷键

- **输入框命令统一接管**：插件命令统一接管斜杠菜单与 `+` 菜单的交互式执行，并可声明会话作用域（如仅顶层人类会话）；激活态以紧凑胶囊显示在工具栏，可一键退出；斜杠排序与审批模型思考等级选择一并调整。
- **`+` 菜单只留输入相关项**：保留附件、模式与插件动作；「精简上下文」「清空上下文」「新建话题」等会话管理统一归顶栏菜单（此前 `+` 菜单版的清空上下文没有二次确认）。直接键入 `/compact`、`/clear`、`/new` 不受影响。
- **统一快捷键目录与总览**：`Mod+/` 打开快捷键总览；全局新话题 `Mod+Shift+O`（待命页连按可切换角色）；`Mod+I` 聚焦输入框；`/` 单键聚焦搜索，`Esc` 清空并失焦；`Ctrl+;` 全局开关 `+` 菜单；`Ctrl+O` 开合过程步骤。修复中文输入法下搜索快捷键误触，以及新建话题后输入框未自动聚焦（含移动端）。
- **忙时发送控件统一**：`Enter` 发送，会话忙时转为 steer；`Mod+Enter` 排队为 follow-up。

### 会话界面

- **过程与工具行**：工具行摘要不再按 60 字符截断，改由 CSS 按屏宽省略；工具行 action 名称不再被 flex 收缩截断；对话框状态栏去掉累计时间，只保留等待审批秒表。
- **侧栏与总览**：状态指示移到共用操作位并统一运行中旋转图标；运行中与后台在途恢复蓝色状态灯；修复点击子会话后同级子行重排跳顶。会话总览不再在侧栏顶栏常驻，改由对话工作集底部「查看全部」、已归档入口、搜索结果或命令面板进入；全局会话态势收敛为状态圆点（桌面侧栏折叠时挂在对话空间图标、移动端挂在菜单按钮，明细计数见提示）。
- **模型选择器与弹窗**：模型选择器重构为单行贴顶搜索栏加固定底栏；弹窗初始焦点收敛，全局亮蓝聚焦外框改为中性反馈。
- **AskDoc 审批卡片双语**：审批卡标题、选项与提示支持 `LocalizedText`，按界面语言渲染。

### 内核能力透视与 CLI

- **`core:*` 内核动作命名空间**：会话、角色、插件、模型、审批、技能、节点、宿主八类内核能力统一为 `core:<domain>` 归属（`core:conversations`、`core:profiles`、`core:plugins`、`core:models`、`core:asks`、`core:skills`、`core:nodes`、`core:host`）。插件中心新增内核能力页签，支持只读详情抽屉深链（`#/settings/plugins/core/<owner>/<action>`）与受管技能双向导航，分屏下只替换分屏目标。
- **检索与参数平权**：会话搜索支持元数据过滤与 `--max-per-conversation`；`models refresh` 新增 `--providers` 与 `--force`；`conversations create` 新增 `--parent-conversation-id`，`conversations update` 补齐 `--tags`；`run_action` 可不带参数列出可调用动作。新增请求 Schema 与 CLI 参数的双向契约门禁，`helmx-cli` 技能文档由测试双向锁定。
- **受管技能归属**：内核核心技能（`helmx-cli`、`conversations`、`profiles`、`app-builder`）迁至 `core:*` 归属；`worktree`、`memory`、`magpie`、`plan`、`tiers`、`triggers` 等插件自举各自的受管技能，停用插件后即时从技能目录消失。

### 触发器与稳定性

- **触发器可更新**：新增 `cron_update` 与 `webhook_update`（`helmx cron update` / `helmx webhook update`），保留运行历史并换代 `rev`，在途旧 tick 不污染更新后的任务；`webhook_update` 不触碰已存 secret，可在会话上下文安全调用。
- **稳定性修复**：修复 fork 子代理与 Swarm 成员继承上文导致的递归派生；闭合自动化会话归属权竞态；修复非 Linux 节点受管 worktree 清理阻塞与 Swarm 结单持锁泄漏；修复全局默认模型保存后按钮持续转圈。

### 插件开发与工程

- **工具结果控制信封**：`ctx.tool` 返回信封新增 `control: { handoff?, terminate? }`，由内核写入 `pi.reset` 后在干净上下文继续或终止（`handoff` 经脱敏，UTF-8 上限 128 KiB，超限显式拒绝）。
- **新增输入框子插槽**：`COMPOSER_TOOLBAR_SLOT`（`builtin:composer/toolbar`）与 `COMPOSER_MENU_SLOT`（`builtin:composer/menu`）。
- **构建与测试**：统一 `tsc -b` 并行构建流水线，插件前端增加增量缓存；测试调度、缓存与慢用例优化。`@earendil-works/pi-*` 与 `chord` 升级至 1.6.1（节点制品的外部精确版本依赖同步更新）。

## v0.3.1 (2026-11-25)

### 修复

- **节点 npm 自升级路径拼接错误**：修复 `@helmx/env-io` 中 `stageViaNpm` 将 `resolveLayoutEntries` 返回的绝对路径直接当相对路径返回给 `stageRelease` 的问题——此前所有平台首次经 npm 暂存节点版本时都会二次拼接路径并失败（Windows 上尤为明显）。现统一转换为相对于暂存根目录的相对路径，并在边界处以 `resolveInside` 校验；补充覆盖真实 `tar` 打包与离线 `npm install` 全链路的回归测试。

## v0.3.0 (2026-11-25)

### 节点与升级

- **节点自动跟随 Hub 版本升级（默认开启）**：npm 全局安装的 `@helmx/node` 节点在版本落后于 Hub 时自动升级到与 Hub 一致，等待 Hub 就绪且节点空闲（无进行中的会话、隧道与远程执行）后执行，失败按指数退避重试；状态见节点信息 `autoUpgrade` 字段与通知，`HELMX_AUTO_UPGRADE_NODES=0` 可关闭。**旧版节点（≤ v0.2.0）不上报安装模式，Hub 不做猜测，需在本版发布后对每台节点手动执行一次 `helmx nodes upgrade <node>`，之后即自动跟随**；源码 / link 方式运行的节点始终不自动升级。
- **工作流运行账本分片性能**：`runs` 分片改为按单条 run 的字节账本增量裁剪，超界时不再反复整体序列化（原 1.5 MiB 预算用例 28s → 0.5s）。

### 界面

- **全屏舞台统一为单层滚动**：模型、节点、插件、角色、技能五大系统中心与全屏视图共用 `ScreenHost` 单一滚动容器，页头去重；标签页新增 `pills` 胶囊样式，空状态 `EmptyState` 与搜索框 `SearchBox` 统一为全站原语（搜索框带清除按钮，空状态支持紧凑 / 突出两种密度）。
- **Web 与内置插件前端迁移至 plugin-client 原语**：会话、工作台、大纲、预览、Shell、总览页与弹窗改用 SDK 的 `Button` / `IconButton` / `Badge` / `Stack` / `Card` 等原语；修复徽章、连接状态灯与触发器按钮忙态的评审遗留问题，以及 Tabs 点击裁决与工具栏 `aria-controls` 绑定。

### 插件开发

- **plugin-client 新增表单与展示原语**：`Button` / `IconButton` / `Input` / `Textarea` / `Field` / `HelperText` / `ErrorText`，以及映射到 `--space-*` 令牌的间距分级（`none | xs | sm | md | lg | xl`）。

### 工程质量

- **测试钩子超时门禁**：`check:hygiene` 新增 `hook-timeout-missing` 规则，`before / after` 等钩子中的清理调用必须显式声明 `{ timeout: 60_000 }`（本次为 140 处钩子补齐）；挂起的清理转为可见失败，不再静默拖死测试分片。
- **测试分片可观测性**：`shard-worker` 逐文件输出进度，仅在静默满窗口时发出停滞告警；工作流注册时序测试以门闩信号替代固定 `sleep`。

## v0.2.0 (2026-11-24)

### 工作台与对话体验

- **会话总览主舞台（`#/overview`）**：新增全局并发总览视图，支持按状态分层分组、来源筛选、卡片直达对应会话，以及卡面归档/删除与批量管理。
- **侧边栏与全局搜索**：侧边栏支持工作集分组切换、批量选择/归档/删除及子会话树收敛展示；`Command+K` 升级中文分词检索（FTS5 trigram）并按实时活跃度排序；移动端优化抽屉手势并将总览角标整合至菜单按钮。
- **模型选择与实时遥测**：模型选择器支持一次打开连续切换模型与思考档位；输入框下方新增独立状态行，展示实时解码速率、上下文用量、工具运行秒表与累计回合耗时；工具卡片统一支持输入/输出展开查看。

### 智能体与内置能力

- **语义模型档位（`builtin:tiers`）**：支持定义 `tier/<id>` 语义档位与可复用编制模板，子代理、Workflow 与 Swarm 可直接按档位调度不同模型。
- **每日记忆整理（`builtin:memory`）**：新增低峰期 Dream 自动整理，脱敏提炼近期对话并维护 `MEMORY.md`；支持自定义整理模型，可在角色详情抽屉查看状态或立即触发整理。
- **会话自动命名（`builtin:title`）**：首轮人类对话完成后在后台静默生成简洁标题，并提供 `/title` 命令随时按当前内容重新整理。
- **Swarm 协同与隔离工作树**：Swarm 收敛为单黑板架构，支持跨节点派工（动态 `nodeId`）、原地换模型续跑与引用速览浮卡；`builtin:worktree` 独立拆出并自动为受管会话注入工作树上下文。
- **跨节点技能发现（`builtin:profile`）**：技能中心支持按节点与工作区切换查看（自动合并 `~/.agents/skills` 与 `<cwd>/.helmx/skills` 只读技能），斜杠技能菜单同步显示摘要说明。
- **触发器与网关配额**：定时与 Webhook 触发的自动化会话与人类直连会话隔离展示；Magpie 网关支持在状态栏展示模型配额并可配置前台刷新频率。

### 插件生态与升级体验

- **插件中心与一键升级**：统一全栈微应用为标准插件形态，受管外部插件支持一键更新与换源升级。
- **Hub 备包切换与离线更新日志**：支持后台静默拉取新版备包并在 Web 端一键切换升级；内置版本 Changelog 弹窗，升级后自动提示本次变更内容。

### CLI 与节点运维

- **生命周期与系统自启**：`helmx` 收敛 `start / stop / restart` 控制命令，新增 `helmx service install | uninstall | status` 注册系统开机自启；新增 `helmx conversations watch` 支持阻塞等待指定会话回合完成。
- **跨节点稳定性**：Hub 启动期增加节点回连等待屏障，避免重启恢复任务时因节点尚未重连而误判离线；`subagent`、Workflow 与 Swarm 全面支持跨节点隔离派工。

## v0.1.0 (2026-11-19)

-（首次发布：微内核持久会话 + EnvFabric 节点 + 插件宿主 + Web 控制台 + npm 三制品）

## v0.1.1 (2026-11-19)

- ci(release): npm 三制品发布切换为 Trusted Publishing 免令牌（OIDC）
- feat(node): 解耦 helmx-node 与 CLI，移除强依赖与双包升级绑定
- docs(repo): 更新项目 Git 远端地址至 team4u/helmx

