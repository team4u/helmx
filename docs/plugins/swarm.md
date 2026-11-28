# Swarm 插件

Swarm 在会话里提供一张共享顺序黑板。主控会话负责分工，成员把进度、问题和审查意见发给需要处理的人。协作组按需创建，插件启动时不会创建常驻会话。第一次使用可以从一次代码交接开始。 [Swarm 实战](../getting-started/orchestration-guide.md)

## 建组和派工

`builtin:swarm` 默认启用。给顶层人类会话发送 `/skill:swarm` 或 `/skill:swarm <任务>`，会在当前回合建立或复用一个活跃组。也可以让助理调用 `swarm_create_group`。人工从 CLI 建组时，传入目标会话 ID。把示例里的 `42` 换成你的会话 ID。

```bash
helmx swarm create-group --conversation-id 42 --title '检查导出模块' --json
```

主控分配具体任务，协调接口和分支合入。成员在 `createConversation` / `forkConversation` 创建边界即原子写入 `ownedBy: 'helmx'`；可单独指定 Profile、目标计算节点（`nodeId`）、工作目录（`cwd`）、模型和思考档位（省略 `model` 时通过 `helmx.default-child-model` 自动消费 [`builtin:duo`](duo.md) 等插件提供的默认执行模型）；`nodeId` 覆盖 Profile 与主控所在节点（显式传 `local` 可切回 Hub 本机），远端节点必须提供 `cwd` 或匹配的 Profile `cwd`，且节点离线时在创建会话前即返回 `409 node_offline`。并发写代码的成员应各有独立的 Git worktree；注意主控本机的 `git merge` 仅适用于同节点上的工作树，跨节点工作树需在各自节点上处理合入。Swarm 通过 `builtin:worktree` 分配工作树，并在协作期间持有租约，避免被清理。`readonly` 是任务约定，成员仍保有原来的工具权限。 [Git Worktree 的隔离范围](../workflows/worktree-and-gate.md)

带 worktree 的成员每回合都会收到 `builtin:worktree` 在 `before_turn` 单轨注入的 `<worktree_context>` 系统段落（含 `branch`、`path`、`baseCommit`、源工作区是否脏，以及结束回合前 `git commit` 的提醒）；成员据此知道自己在哪条受管分支上工作，清理工作树后自动停止注入。

Swarm 成员通过 `helmx.conversation-depth` 上报 `depth = 1`，统一复用 [`builtin:workflow`](workflow.md) 的 `maxSubagentDepth` 上限（默认 `1`，即成员默认不可再派子代理或工作流，在 `before_turn` 自动剥离派工工具并抑制 `<available_profiles>` 协作目录，并在派生入口拦截 `403 subagent_depth_exceeded`）。本插件同时向 `PluginHost` 提供 `helmx.dispatch-tools`（`['swarm_dispatch_worker']`）与 `helmx.planning-orchestration-tools`（`[...SWARM_TOOL_NAMES]`），供深度守卫与 [`builtin:duo`](duo.md) 规划阶段协同放行。使用 `forkFrom`（`'coordinator'` 或既有成员名）热分叉的成员还会持久化 `forked: true`：每回合经共享 `FORKED_CHILD_CONTEXT_GUIDANCE` 边界助手在 `<active_swarm_group>` 注入上下文边界规则（将分叉点之前的历史视作只读背景，不重复派发继承来的委托指令），且即使全局上限调高仍始终保持叶子收口；人工 `conversations fork` 会话不受影响。

## 看板消息

每个协作组维护一条单线递增序号的共享黑板。`board_post` 的 `to` 决定谁收到消息，可填 `coordinator` 或活跃成员名（可选前导 `@`）；只有主控和人工调用可以用 `all`。找不到或已归档的收件人会使操作失败；剔除发帖者自身后没有任何活跃可唤醒目标（如自寻址或空组 `all`）会返回 `409 swarm_no_active_targets`，防止静默掉棒。

每条消息都有 `seq`。在回复里可以用 `refs: [12]` 和正文里的 `#12` 引用前一条意见。带 worktree 的成员发 `handoff` 或 `done` 时，看板会附上 `worktreeSnapshot`，包含分支、领先提交数和改动文件预览，供接手的人查对应工作树。

`wake` 决定是否让收件人继续跑一个回合。`comment` 默认只留记录，其他类型默认唤醒。交给审查人时通常需要唤醒，给主控补一条进度说明时可以只留记录。成员多条待处理消息会合成一个唤醒请求，主控收到的汇报也会分级合并：

- `blocker` 与 `stall` 无论是否显式寻址 `coordinator` 或设置 `wake: false`，都会强制立即上报主控（防静默吞错）；
- 寻址包含 `coordinator` 且 `wake: true` 的非 `done` 消息（`handoff` / `review` / `brief` / 显式唤醒的 `comment`）会立即触发主控汇报冲刷，即使发帖成员在同一回合内继续执行或同时寻址其他成员也不阻塞等待；
- `done` 遵循正交的 `to` 与 `wake` 规则：寻址包含 `coordinator` 且 `wake: true` 时仅等待发帖成员自身结束当前回合（防尾声竞态）即上报主控，不再等待其他慢成员，主控可立即着手切片审查或准备工作（若早期汇报时仍有活跃成员且后者随后被动结束，仍由全组空闲兜底补报）；若 `done` 未唤醒主控且全组进入空闲，由静默守卫自动补发 `stall` 兜底。

## 在会话里跟进

- 时间线显示派工、交接、审查以及看板消息/协同唤醒折叠轨迹卡（左侧 chevron 原地展开结构化消息正文与偏离默认的 `wake` 轻标签，右侧 `external-link` 跳工作台）。点成员相关的记录可打开成员会话。
- 主控会话里还有「进行中」区域，有成员正在执行或受阻时才显示。展开后可以查看成员或中止当前回合。
- 右侧「Swarm 协同编组」面板显示任务目标、成员状态、模型、分支和最近的看板消息（含可点击 `#seq` 正文内联与引用芯片速览浮卡——支持浮卡内连续追查与返回、按 `seqs` 精确补拉任意早期记录，以及「定位到列表」后的 `← 返回 #seq` 回跳栈，偏离默认的 `wake` 状态会在帖子头附轻量标识）。带受管工作树的活跃成员行、结单后「保留待合入分支」行与看板快照行通过 `worktree-actions` 插槽直连 [`builtin:changes`](changes.md) 的只读彩色 Diff 检视。主控视角下可直接在面板中止在途成员或发起结单（支持 `keepWorktree` / `abortRunning` 选项）。「查看完整记录」会加载最近 200 条记录，超过 200 条时可通过「加载更早记录」继续向前分页。结单后仍可在工作台回看。
- 输入框支持 `@成员` 补全。切换成员模型需要等它空闲。中止当前回合会保留成员会话与工作树租约。

## 结单和清理

默认结单会先确认成员已停止，再检查工作树。发现未提交改动或未合入提交时，返回 `swarm_worktree_unmerged`。用 `keepWorktree: true` 结单会释放租约，保留有改动或尚未合入的工作树，并在 `retainedWorktrees` 里列出节点（`nodeId`）、路径和分支。通过清理检查的其他工作树仍会被清理；若目标节点不支持进程占用扫描（如 Windows / macOS），且未传 `allowUnverifiedUsage: true`（CLI：`--allow-unverified-usage`），`close_group` 与 `archive_worker` 会安全释放持有锁并正常结单/归档，但保留未删除的干净工作树目录，并在返回的 `uncleanedWorktrees` / `uncleanedWorktree` 与摘要中显式告知，供确认无占用后单独清理或一步带 `--allow-unverified-usage` 清理。`force: true` 结单只放开脏/未合入守卫（放弃未合入内容直接收尾）；占用（租约、在跑成员、进程扫描）、归属与锁定校验依旧拒绝。结单后可以在同一会话开始新组。

需要停止整个协作组时，用 `--abort-running` 中止在跑的成员。把环境变量 `group_id` 设为建组命令返回的 `groupId`。

```bash
helmx swarm close-group --group-id "$group_id" --abort-running --keep-worktree
```

## 动作和命令

| 动作 ID | 模型工具 | CLI | 用途 |
| --- | --- | --- | --- |
| `create_group` | `swarm_create_group` | `helmx swarm create-group` | 在顶层会话建立协作组 |
| `list_groups` | —（经 `run_action` 调用） | `helmx swarm list-groups` | 列出协作组有界摘要（可按 `status` / `coordinatorConversationId` 过滤） |
| `update_group` | `swarm_update_group` | `helmx swarm update-group` | 改标题或目标 |
| `dispatch_worker` | `swarm_dispatch_worker` | `helmx swarm dispatch-worker` | 派工并唤醒成员。可选目标节点（`nodeId`）、工作目录（`cwd`）、worktree、会话分叉和模型 |
| `board_post` | `swarm_board_post` | `helmx swarm board-post` | 发消息，指定收件人和是否唤醒 |
| `board_read` | `swarm_board_read` | `helmx swarm board-read` | 分页读消息 |
| `board_status` | `swarm_board_status` | `helmx swarm board-status` | 查组和成员状态，包括历史编组 |
| `abort_worker` | `swarm_abort_worker` | `helmx swarm abort-worker` | 中止成员当前回合 |
| `switch_worker_model` | `swarm_switch_worker_model` | `helmx swarm switch-model` | 为闲置成员更换模型与思考档位，可选附带 `prompt` 立即续跑 |
| `inspect_worker` | `swarm_inspect_worker` | `helmx swarm inspect-worker` | 查成员的近期记录、产物和工作树 |
| `archive_worker` | `swarm_archive_worker` | `helmx swarm archive-worker` | 归档成员并处理工作树租约 |
| `close_group` | `swarm_close_group` | `helmx swarm close-group` | 结单、清理或保留工作树 |

`complete_board_members` 给输入框提供 `@` 补全候选。模型可用的工具取决于当前会话的组内身份。成员侧用 `swarm_board_read` 和 `swarm_board_post` 交接，派工、换模型和结单由主控处理。 [CLI 参数参考](../cli/reference.md)

## 失败和恢复

成员回合失败后，插件把脱敏错误写成 `blocker` 并报给主控。收到派工、交接或审查后完成回合却没发帖的成员，最多收到一次补发提醒。再没有回应时，插件会记录受阻情况。全组符合空闲条件却没有交付时，`stall` 记录会给出已知线索，例如某条交接没有唤醒收件人。检查由回合结束事件触发。自上次主控介入起连续对等互唤超过 `maxPeerHopsWithoutCoordinator` 次时，插件以 0-Token 事件路径自动暂停对等唤醒并向主控上报 `blocker` 熔断。

协作组保存于 `<dataDir>/groups/<groupId>/`。`board.jsonl` 先追加并同步写盘，再以 `meta.json` 的 `headSeq` 提交。重启会截掉单条未提交尾记录，已提交记录损坏会报 `swarm_doc_corrupt`。启动时会核对会话标签、归属和遗留的工作树租约，再根据已有提交记录补送需要恢复的唤醒和汇报。建组、派工与发帖按会话和工具调用 ID 去重。

停用插件时，在途任务会触发 `plugin_has_live_tasks`。仍有活跃协作组时会触发 `plugin_in_use`。持有受管 worktree 的组员同时占用 [`builtin:worktree`](worktree.md) 插件的工作树资源。

## 配置与实现

| 配置 | 默认 | 范围 |
| --- | --- | --- |
| `maxWorkersPerGroup` | `12` | 每组同时活跃的成员数，`2..32` |
| `boardPreviewLimit` | `80` | 看板投影内近期消息数，`20..200` |
| `maxPeerHopsWithoutCoordinator` | `16` | 自上次主控介入起允许的连续对等互唤次数，`2..100` |

全局 `index` 和 `board-badges` 提供成员索引和界面计数。看板明细通过按主控会话分片的 `board-view` 提供，前端在查看编组时订阅。主控和成员通过 `swarm-coordinator`、`swarm-worker` 及各自的 `-archived` 标签区分。回合提示只包含稳定的组或成员信息，实时状态按需从看板读。

[插件入口](../../packages/plugins/src/swarm.ts) · [Swarm 实现](../../packages/plugins/src/swarm/) · [界面测试](../../packages/web/test/swarm-client-interactions.test.tsx)
