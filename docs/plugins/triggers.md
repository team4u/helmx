# 触发器插件：Cron 与 Webhook 入站连接器

`builtin:triggers` 解决「让外部世界定时或经 HTTP 事件驱动会话」的问题：Cron 定时器与 Webhook 接收器把事件经共享投递 helper 送入内核 `trigger` 管道，统一 `defang` 防逃逸包裹后按会话模式路由到隔离/专用自动化会话或显式目标会话。适合需要定时巡检、接收外部系统回调且不希望自动化任务干扰人类会话列表的使用者。

## 当前状态

默认启用、非 `locked` 可停用。管理界面为 client.tsx React 单轨（`TriggersManagerScreen` 与 `TriggersSettingsPanel`），详情抽屉直接基于实时会话列表展示该触发器的最近运行记录并支持右侧抽屉速览与主屏跳转（零双写）。

## 能力和入口

### 会话隔离与投递模式

Cron 与 Webhook 共享同一套互斥投递契约（`delivery.ts`）：

1. **`mode: 'isolated'`（默认）**：每次触发在指定 `profileId`（缺省 `assistant`）下创建全新的 `ownedBy: 'helmx'` 自动化会话（携带 `tags: ['trigger', 'cron:<id>' | 'webhook:<id>']`），与人类会话列表彻底隔离；完成后通过 `turn_settled` 钩子与内核 `deleteConversationGuarded` 自动按 `keepLast`（默认 `10`，范围 `1..100`）清理超限的旧已结算会话（在途 `working`、待审批 `blocked` 与失败 `error` 会话永不自动删除）。
2. **`mode: 'dedicated'`**：每个触发器固定绑定并复用它专属的 1 个 `ownedBy: 'helmx'` 自动化会话（并发入站单飞去重，原会话被删除时下次自动重建），以 `whenBusy: 'followUp'` 排队投递，适合需要跨次记住上下文的有状态巡检。
3. **`targetConversationId: <id>`（显式注入已有会话）**：与 `mode` / `profileId` / `keepLast` 互斥；直接向指定会话以 `whenBusy: 'followUp'` 投递（不打断人类当前回合），目标不存在显式报 `404 not_found`，绝不静默漂移。

事件文本经内核 `dispatchTrigger` 统一 `defang` 防逃逸包裹，连接器绝不双层包裹。宿主关闭中（`isClosing`）拒绝投递。

### Cron 定时编排

标准五字段 cron（分 时 日 月 周，cron-parser 驱动），IANA 时区（默认 UTC）。任务持久化于公共文档 `crons`。调度语义五条硬保证：

1. **至多一次**：调度点先推进 `nextRunAt` 并 `await doc.flush()` 真实落盘，再投递。持久 claim 与异步输入提交不构成原子事务——claim 落盘后、投递完成前崩溃则该次丢失，如实声明，不承诺 exactly-once；
2. **单飞保护**：同一 job 并发 tick 只允许一个在途；
3. **慢任务防重入跳过**：自动化模式（`isolated` / `dedicated`）的计划 tick 触发前检查该任务是否已有在途（`working` / `blocked`）运行；仍在途则推进 `nextRunAt` 并跳过本次（记录 `lastSkippedAt` 与 `lastSkipReason`），防慢任务雪崩；
4. **重启补跑（`catchUp`）**：`true` 重启后对错过时段合并补跑最近一次；`false` 跳至未来首个时点；
5. **分段防溢出**：定时器间隔超 32 位上限（约 24.8 天）时先以安全窗口触发再续排，timer unref 不阻退出。

写回按 `(id, rev)` 双键校验：delete 后重建同 ID 或经 `cron_update` 修改配置均会换代（`rev` 新 UUID），在途旧 tick 不污染更新后的任务。投递失败如实写 `lastError` 并发 notification；本计划点不重试，下个时点照常。

| 动作 | CLI | 说明 |
| :--- | :--- | :--- |
| `cron_create` | `helmx cron create` | `--id`（1..64 位 `[A-Za-z0-9_-]`，禁点号）/ `--schedule` / `--text` 必填；可选 `--timezone` / `--description` / `--enabled` / `--catch-up` / `--mode isolated\|dedicated` / `--profile-id` / `--keep-last 1..100` / `--target-conversation-id`（与自动化参数互斥） |
| `cron_update` | `helmx cron update` | `--id` 必填，至少提供一个可更新字段（`--description` 传空串清空 / `--schedule` / `--timezone` / `--text` / `--enabled` / `--catch-up` / `--mode` / `--profile-id` / `--keep-last` / `--target-conversation-id`）；换代 `rev`、重算 `nextRunAt` 并重排定时器，保留 `lastRunAt` / `lastError` / `lastSkippedAt` / `lastSkipReason` 运行历史 |
| `cron_delete` | `helmx cron delete <id>` | 删除任务；在途投递自然终止，不复活 |
| `cron_trigger` | `helmx cron trigger <id>` | 手动立即真实投递一次并返回 `{ triggered, conversationId }`（失败抛错，不影响后续计划调度） |
| `cron_list` | `helmx cron list` | 全部任务含 `mode` / `lastRunAt` / `nextRunAt` / `lastError` / `lastSkippedAt` |

### Webhook 签名入站

宿主挂载公开路由 `POST /api/plugins/builtin:triggers/routes/webhook/:id`（`public: true` 跳过 Token 鉴权，插件自行验签）。握手链：请求体流式限制 256 KiB（超限 `413 payload_too_large`）→ HMAC-SHA256 验签（`x-helmx-signature: sha256=<hex>` 覆盖原始 body 字节，`timingSafeEqual` 常时比较；无签名/错签名 401，ID 不存在 404，坏 UTF-8 显式 400）→ 配置一致性复核（读 body 期间端点被删、重建或经 `webhook_update` 换代 `rev` 返回 `409 webhook_changed`）→ 投递（`202 {accepted: true}`；失败显式 `500 webhook_dispatch_failed`）。

| 动作 | CLI | 说明 |
| :--- | :--- | :--- |
| `webhook_create` | `helmx webhook create` | `--id` / `--secret` 必填；可选 `--description` 与 `--mode` / `--profile-id` / `--keep-last` / `--target-conversation-id`。**secret 仅允许人工 HTTP/CLI 配置**：检测到会话调用上下文（`run_action` / workflow）显式 `403 webhook_secret_context_forbidden` |
| `webhook_update` | `helmx webhook update` | `--id` 必填，至少提供一个可更新字段（`--description` 传空串清空 / `--mode` / `--profile-id` / `--keep-last` / `--target-conversation-id`）；换代 `rev` 且不触碰已存 secret（传入 `secret` 显式 `400` 拒绝），可在会话上下文（`run_action`）中安全调用 |
| `webhook_list` | `helmx webhook list` | 端点元数据（不含 secret） |
| `webhook_delete` | `helmx webhook delete <id>` | 先删 doc（下线入口）再删 secret；secret 删除失败显式报错 |

### 管理界面

左栏「触发器管理」入口 + `manager` 全屏 Screen（订阅 `crons` / `webhooks` 公共 doc + `useConversations()` 实时关联运行记录；行内实时异常/运行灯位、「立即触发」「删除」经 `ctx.callAction` 调真实动作端点；详情抽屉展示最近运行列表并支持抽屉速览与主屏打开）+ 设置面板概览。

## 配置与数据边界

插件自身无 `ctx.configSchema` 配置项；任务与端点定义即配置，持久化于公共文档 `crons` / `webhooks`。**验签密钥只持久化于 `credentials.json` 的 `pluginSecrets['builtin:triggers']['webhook:<id>']`**（恒 0600，经 `ctx.host.secrets` 绑定命名空间）并注册全局脱敏；公共文档只存元数据（`hasSecret` 布尔协作契约），绝不包含原始密钥，也不双写运行历史列表。

## 停用与失败语义

已启用的 cron 任务与已配置 webhook 端点是 `inUse()` 停用占用项：`helmx plugins disable builtin:triggers` 默认 `409 plugin_in_use` 并列出占用清单，`--force` 可知情越过（磁盘配置保留，重新启用后恢复）。停用后动态命令、管理界面、调度器与 `turn_settled` 清理钩子即时消失。cron/webhook 文档损坏显式抛 `cron_doc_corrupt` / `triggers_doc_corrupt`，绝不静默重置。

## 源码与测试入口

| 内容 | 位置 |
| :--- | :--- |
| 插件入口 | `packages/plugins/src/triggers.ts` |
| Cron 调度 / Webhook / 投递与清理 | `packages/plugins/src/triggers/cron.ts`（门面再导出；实现按职责位于 `triggers/cron/`：解析 `parse.ts`、输入契约 `inputs.ts`、存储 `store.ts`、动作 `actions.ts`、调度 `scheduler.ts` 与 `tick.ts`）、`webhook.ts`、`delivery.ts` |
| 前端管理界面 | `packages/plugins/src/triggers/client/` |
| 测试 | `packages/plugins/test/triggers.test.ts`、`triggers-cron.test.ts`、`triggers-webhook.test.ts` |

## 相关文档

- [插件系统设计与契约](overview.md)：`ctx.route` 公开路由与 `inUse` 停用预检
- [CLI 命令参考](../cli/reference.md)：`helmx cron` / `helmx webhook` 动态命令
