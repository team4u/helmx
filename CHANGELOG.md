# Changelog

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

