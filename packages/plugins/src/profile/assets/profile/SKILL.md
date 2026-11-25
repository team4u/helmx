---
name: {{SKILL_ID}}
description: "跨角色历史会话检索、上下文回溯与会话生命周期管理，以及角色（Profile）配置与管理；优先通过结构化 core:conversations.* 与 core:profiles.* Action（而非 shell CLI）完成搜索、读取、发送、分叉、压缩与角色维护。Use when searching past conversations across roles, recalling cross-profile history, managing conversation lifecycle, or configuring Profiles."
managedByPlugin: {{MANAGED_BY}}
---

# Cross-Role Conversation Recall & Profile Management

Use this skill whenever the user asks to search past conversations, recall prior context across roles (Profiles), manage existing conversations, or inspect and configure Profiles.

## Golden Rule: Prefer Structured `run_action` Over Shell CLI

Inside Agent turns, call structured internal actions via `run_action` instead of shelling out to `helmx` in `bash`:
- `run_action` enforces strict JSON Schema validation, returns structured JSON directly, and applies built-in ownership and self-mutation safety guards.
- Discover all reachable core actions live: `run_action({ list: true, pluginId: "core:" })` (and built-in plugin actions via `pluginId: "builtin:"`).
- Inspect the exact `inputSchema` / `outputSchema` of any action without side effects: `run_action({ actionId: "core:conversations.<id>", describe: true })` or `run_action({ actionId: "core:profiles.<id>", describe: true })`.

## Recommended Conversation Recall Workflow (`search -> get -> entry`)

Follow a progressive funnel so you retrieve exact evidence without flooding context:

1. **Full-text search (`core:conversations.search`)**
   - Input: `{ q, limit?, maxPerConversation?, profileId?, ownedBy?, topLevelOnly? }`
   - Searches across conversations via FTS5.
   - Use `maxPerConversation` (`1..20`) to keep a single long thread from drowning out hits from other roles or conversations, and `limit` (`1..100`) to bound total hits.
   - Narrow scope when known with `profileId`, `ownedBy` (`"human" | "helmx"`), or `topLevelOnly: true`.
2. **Browse or filter roster (`core:conversations.list`)**
   - Input: `{ profileId?, status?, tag?, ownedBy?, parentConversationId?, topLevelOnly?, all? }`
   - Enumerates conversations when you need to find recent threads by role, status (`working | blocked | done | idle | error`), tag, ownership, or parent conversation.
   - Mirrors `GET /api/conversations` defaults (top-level human conversations unless `all`, `parentConversationId`, `tag`, or `ownedBy` is specified).
3. **Inspect conversation timeline (`core:conversations.get`)**
   - Input: `{ conversationId, limit?, cursor? }`
   - Fetches conversation metadata plus paginated recent timeline entries (`limit` `1..500`; pass the returned opaque `nextCursor` as `cursor` to walk older history). Long plain-text tool outputs may be head/tail truncated in detail pages.
4. **Read full hit entry (`core:conversations.entry`)**
   - Input: `{ conversationId, entryId }`
   - Fetches the complete, untruncated content of a specific timeline entry returned by `search` or `get`.

## Conversation Lifecycle Actions (`core:conversations.*`)

All lifecycle operations run via `run_action({ actionId: "core:conversations.<id>", input })`:

- **`core:conversations.create`**: `{ title?, profileId?, nodeId?, cwd?, model?, tags?, parentConversationId? }` — create a new conversation bound to a Profile/node/workspace.
- **`core:conversations.update`**: `{ conversationId, title?, profileId?, nodeId?, cwd?, model?, thinkingLevel?, tags?, unread?, pinned? }` — patch conversation metadata or overrides (pass `model: ""` or `thinkingLevel: ""` to clear an explicit override and inherit from Profile/global defaults).
- **`core:conversations.send`**: `{ conversationId, text, whenBusy?, wait?, origin?, meta?, attachments?, replaceFromEntryId? }` — submit input to a target conversation (`whenBusy`: `"steer" | "followUp" | "reject"`, default `"steer"`; set `wait: true` to await the reply). Inside any conversation context, `origin` is always forced to `"agent"`.
- **`core:conversations.withdraw`**: `{ conversationId, submissionId }` — withdraw a queued submission (honestly reports if execution already started or settled).
- **`core:conversations.abort`**: `{ conversationId }` — abort the target conversation's in-flight turn.
- **`core:conversations.reset`**: `{ conversationId, handoff? }` — reset context cleanly with optional `handoff` as the first message.
- **`core:conversations.compact`**: `{ conversationId, instructions? }` — trigger context compaction with optional custom `instructions`.
- **`core:conversations.fork`**: `{ conversationId, entryId?, title? }` — branch a conversation from an optional `entryId` (defaults to latest clean anchor).
- **`core:conversations.delete`**: `{ conversationId }` — delete a conversation (cascades derived child conversations; plugin-managed conversations are protected).

## Profile Management Actions (`core:profiles.*`)

Manage roles (Profiles) via `run_action({ actionId: "core:profiles.<id>", input })`:

- **`core:profiles.list`**: `{}` — list all configured Profiles.
- **`core:profiles.get`**: `{ id }` — retrieve one Profile including its `SYSTEM.md` (`system`).
- **`core:profiles.create`**: `{ id, name?, model?, thinkingLevel?, nodeId?, cwd?, restrictToCwd?, tags?, skills?, starters?, system? }` — create a new Profile (`managedByPlugin` is rejected on create; `restrictToCwd: true` constrains file tools and subagent `cwd` to the conversation working directory as a model guardrail).
- **`core:profiles.update`**: `{ id, name?, model?, thinkingLevel?, nodeId?, cwd?, restrictToCwd?, tags?, skills?, starters?, system? }` — partial merge preserving untouched fields; `managedByPlugin` is immutable and cannot be modified or stripped.
- **`core:profiles.delete`**: `{ id }` — delete an unused, non-managed Profile (fails if still bound to any conversation, or if plugin-managed / default `assistant`).

## Safety Boundaries (Enforced by the Kernel)

- **Watchdog Ownership Red Line**: `helmx`-owned background/automated sessions MAY read human conversations (`search`, `list`, `get`, `entry`) for recall and diagnostics, but CANNOT mutate human-owned conversations (`update`, `send`, `withdraw`, `abort`, `reset`, `compact`, `delete`) — rejected with `403 ownership_violation`.
- **Self-Mutation Forbidden**: Inside a conversation, calling `core:conversations.abort`, `core:conversations.reset`, or `core:conversations.delete` against your own `conversationId` is rejected with `409 self_mutation_forbidden`.
- **Honest `origin` Enforcement**: Calling `core:conversations.send` inside any conversation context always records `origin: "agent"`.
- **Scope-Blocked Core Actions**: Never call `core:skills.*` (`list`/`read`) or `core:asks.answer` from inside a conversation — both carry `scope: { conversationIds: [] }` and fail with `403` before reaching handlers. Use `load_skill` for skills, and let humans answer approval asks.
- **Host-Governance Mutations**: Host-level mutations (`core:nodes.{remove,upgrade,forward_stop}`, `core:plugins.{config_set,enable,disable,reload,rescan}`, `core:asks.cancel`) require a top-level `ownedBy: "human"` conversation and are rejected from subagent or automated sessions.
