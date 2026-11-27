---
name: triggers
description: Use when creating, listing, updating, deleting, or manually triggering periodic cron schedules or managing inbound webhook endpoints via run_action (builtin:triggers actions).
managedByPlugin: builtin:triggers
---

# Triggers (Cron & Webhook)

Use `builtin:triggers` to schedule recurring prompts (`cron_*`) or inspect/update/delete inbound HMAC-signed webhooks (`webhook_*`). Inside Agent turns, always call actions via `run_action({ actionId, input })` (or `run_action({ actionId, describe: true })` to inspect full schemas) — do not shell out to `helmx` via `bash`. Equivalent `helmx cron` / `helmx webhook` CLI commands are strictly for human terminals or external scripts (except `webhook_create`, which is intentionally CLI / HTTP / UI-only).

## Session isolation & delivery modes

By default, triggers run in **automated sessions** (`ownedBy: 'helmx'`, tagged `trigger` + `cron:<id>` / `webhook:<id>`) so scheduled runs never interrupt or clutter human conversations:

- **`mode: "isolated"` (default)**: creates a fresh automated conversation per run under `profileId` (default `assistant`) and automatically prunes older settled runs beyond `keepLast` (default `10`, range `1..100`; active, blocked, and errored runs are never auto-deleted).
- **`mode: "dedicated"`**: reuses one persistent automated conversation dedicated to that trigger (`whenBusy: "followUp"`), ideal for stateful monitoring that remembers prior checks.
- **`targetConversationId: <id>`**: mutually exclusive with `mode` / `profileId` / `keepLast`; delivers into an explicit existing conversation with `whenBusy: "followUp"` (never interrupts an active turn with `steer`; fails loudly if deleted).

Scheduled cron ticks in automated modes (`isolated` / `dedicated`) skip overlapping fires while a previous run for that job is still `working` or `blocked` (recorded in `lastSkippedAt` / `lastSkipReason`).

## Cron actions (`run_action`)

Inside Agent turns, always call these actions via `run_action({ actionId, input })` — never shell out to `helmx cron` via `bash`:

- `builtin:triggers.cron_list` (`{}`) — list all cron jobs with `mode`, `nextRunAt`, `lastRunAt`, `lastError`, and `lastSkippedAt`. (CLI for terminals/scripts: `helmx cron list --json`)
- `builtin:triggers.cron_create` (`{ id, schedule, text, timezone?, description?, enabled?, catchUp?, mode?, profileId?, keepLast?, targetConversationId? }`) — create a periodic cron job. (CLI for terminals/scripts: `helmx cron create`)
- `builtin:triggers.cron_update` (`{ id, description?, schedule?, timezone?, text?, enabled?, catchUp?, mode?, profileId?, keepLast?, targetConversationId? }`) — update an existing cron job (at least one field besides `id` required; `description: ""` clears description; recomputes `nextRunAt` and reschedules timer while preserving run history). (CLI for terminals/scripts: `helmx cron update`)
- `builtin:triggers.cron_delete` (`{ id }`) — delete a cron job. (CLI for terminals/scripts: `helmx cron delete`)
- `builtin:triggers.cron_trigger` (`{ id }`) — manually deliver one trigger immediately (returns `{ triggered, conversationId }`). (CLI for terminals/scripts: `helmx cron trigger`)

### Cron authoring rules

- `schedule` is a standard 5-field periodic cron (`min hour day month weekday`, e.g. `"*/30 * * * *"`), not an arbitrary shell timer: each fire delivers `text` wrapped in `<external_event>`.
- `timezone` takes an IANA timezone name (e.g. `Asia/Shanghai`; defaults to `UTC`).
- `targetConversationId` is mutually exclusive with `mode`, `profileId`, and `keepLast`; `keepLast` is only valid in `isolated` mode.
- Make `text` self-contained (explicit task, paths, and conditions) because isolated runs start with a clean context.

## Webhook actions (`run_action`; `webhook_create` is CLI / HTTP / UI-only)

Inside Agent turns, call `webhook_list`, `webhook_update`, and `webhook_delete` via `run_action({ actionId, input })` — do not shell out to `helmx webhook` via `bash`:

- `builtin:triggers.webhook_list` (`{}`) — list configured webhook endpoints (metadata only, no secrets). (CLI for terminals/scripts: `helmx webhook list --json`)
- `builtin:triggers.webhook_update` (`{ id, description?, mode?, profileId?, keepLast?, targetConversationId? }`) — update webhook metadata or delivery target without touching its stored secret (at least one field besides `id` required; `description: ""` clears description; `secret` cannot be passed; safe to call via `run_action`). (CLI for terminals/scripts: `helmx webhook update`)
- `builtin:triggers.webhook_delete` (`{ id }`) — delete a webhook endpoint and its stored secret. (CLI for terminals/scripts: `helmx webhook delete`)
- **Creating webhooks (`builtin:triggers.webhook_create`) is CLI / HTTP / UI-only**: its scope excludes all conversation contexts (`403`) so HMAC secrets never enter model conversation history. Ask the user to run `helmx webhook create` in their own terminal (or use the Web UI / HTTP API; supports `--mode isolated|dedicated`, `--profile-id`, `--keep-last`, or `--target-conversation-id`), then share the inbound endpoint URL and signing header: `x-helmx-signature: sha256=<hex>` (HMAC-SHA256 over the raw request body bytes).
