# 会话标题插件（`builtin:title`）

`builtin:title` 负责将“首轮硬截断前 36 字”的兜底标题静默提炼为清晰的会话标题，并提供 `/title` 快捷命令随时按当前对话内容重新整理。全部策略位于插件层，不往会话时间线写入消息，也不占用主对话上下文。

## 当前状态

默认启用、非 `locked` 可停用。注册一个旁路动作 `generate`（`exposeToPrompt: false`，不进入系统提示词 `<available_actions>`）与一条作用域限真实会话的命令 `/title`（`scope: {}`）。

## 能力和入口

### 1. 首轮静默自动命名

监听 `turn_settled` Hook；仅当全部条件成立时在后台非阻塞触发一次 `completeText` 单次旁路补全：

- 插件配置 `autoTitle !== false`；
- 回合终态 `outcome === 'completed'`；
- 顶层会话（`parentConversationId === undefined`）且人类归属（`(ownedBy ?? 'human') === 'human'`）；
- 本轮包含非空 `origin === 'human'` 输入，且当前标题为空或仍等于内核首句截断产物 `deriveConversationTitle(firstHumanInput)`（通过 `@helmx/protocol` 单一事实源判断，不覆盖显式命名、Fork 继承标题或人类手工改名）；
- 读取最近有效对话（严格从最后一条 `pi.reset` 之后截取，忽略 `pi.tool-result` / `pi.system` / `pi.compaction`），且再次确认人类输入数未超出首轮计数。

**写回守卫**：模型返回并经单行清洗校验后，重读最新会话摘要，仅当同时满足以下条件时才调用 `updateConversation(id, { title })`：

1. 标题仍等于触发时的快照标题（期间未被人工重命名）；
2. `pendingAskCount === 0`（无待处理 `AskDoc` 审批，避免推进 `stateChangeSeq` 触发审批 CAS 冲突）；
3. `status` 不是 `working` 或 `blocked`；
4. `completionSeq` 与 `lastEntryId` 均未推进（期间无新一轮、重放或重置；允许 Web 标记已读把 `done` 置为 `idle` 而不误拒）。

自动整理过程中的超时、模型失败或脏输出只静默放弃，不弹窗打扰聊天。

### 2. 手动按需整理（`/title`）

| 入口 | 用法 | 说明 |
| :--- | :--- | :--- |
| 输入框斜杠 / `⌘K` | `/title` | 在真实已持久化会话中选中即后台执行（待命草稿页 `#/a/...` 与全局视图经 `scope: {}` 自动隐藏），不把指令发进聊天历史 |
| CLI | `helmx title generate --current` / `--conversation-id <id>` | 返回 `{ conversationId, previousTitle, title, changed }`；对话为空报错 `400 title_empty_conversation` |
| HTTP | `POST /api/actions/builtin:title/generate` | 入参 `{ conversationId?: number }`（与上下文 `conversationId` 冲突时拒绝 `400 validation_error`） |

手动执行会立即中止同一会话上在途的自动整理任务，并对同会话并发手动请求做去重。

## 配置项

| 配置 | 类型 | 缺省 | 说明 |
| :--- | :--- | :--- | :--- |
| `autoTitle` | boolean | `true` | 是否在人类顶层会话首轮完成后静默整理标题 |
| `model` | string (`format: 'model'`) | `""` | 可选专用模型或档位（如 `tier/fast`）；留空则沿用会话当前生效模型 |

为兼容思考/推理模型（避免思维链耗尽小额预算导致 `stopReason !== 'stop'` 报错 `502`），内部补全 `maxTokens` 设为 `2048` 配合默认 `15s` 超时控制，再通过 Prompt 约束与本地单行清洗截断至最多 60 字符。

## 停用与失败语义

- **停用后即时消失**：`/title` 命令与 `generate` 动作立即下线，不再监听 `turn_settled`；
- **在途任务收口**：通过 `ctx.service({ liveTasks, stop })` 与 `conversation.deleted` 事件中止并等待在途请求收敛，不向已停用周期写入状态。

## 源码与测试入口

| 内容 | 位置 |
| :--- | :--- |
| 插件入口（配置 / 钩子 / 动作 / 命令 / 生命周期） | `packages/plugins/src/title.ts` |
| 契约与事件守卫 | `packages/plugins/src/title/contracts.ts` |
| 摘要抽取、Prompt 与输出清洗 | `packages/plugins/src/title/generator.ts` |
| 共享首句兜底标题原语 | `packages/protocol/src/conversation.ts`（`deriveConversationTitle`） |
| 单测与集成测试 | `packages/plugins/test/title-plugin.test.ts`、`packages/plugins/test/title-plugin.integration.test.ts` |

## 相关文档

- [插件系统设计与契约](overview.md)
- [微内核架构总览](../architecture/overview.md)
