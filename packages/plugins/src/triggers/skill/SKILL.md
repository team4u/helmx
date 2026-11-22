---
name: triggers
description: Use when creating, listing, deleting, or manually triggering periodic cron schedules or managing inbound webhook endpoints via builtin:triggers actions and CLI.
managedByPlugin: builtin:triggers
---

# Triggers (Cron & Webhook)

Use `builtin:triggers` to schedule recurring prompts (`cron_*`) or inspect/delete inbound HMAC-signed webhooks (`webhook_*`). Call actions with `run_action({ actionId, input })` (or `run_action({ actionId, describe: true })` to inspect full schemas), or run the equivalent `helmx cron` / `helmx webhook` CLI commands.

## Cron actions (`run_action`)

- `builtin:triggers.cron_list` (`{}`) — list all cron jobs with `nextRunAt` / `lastRunAt` / `lastError`. CLI: `helmx cron list --json`.
- `builtin:triggers.cron_create` (`{ id, schedule, text, timezone?, description?, enabled?, catchUp?, targetConversationId?, targetProfileId? }`) — create a periodic cron job. CLI: `helmx cron create`.
- `builtin:triggers.cron_delete` (`{ id }`) — delete a cron job. CLI: `helmx cron delete`.
- `builtin:triggers.cron_trigger` (`{ id }`) — manually deliver one trigger immediately. CLI: `helmx cron trigger`.

### Cron authoring rules

- `schedule` is a standard 5-field periodic cron (`min hour day month weekday`, e.g. `"*/30 * * * *"`), not an arbitrary shell timer: each fire delivers `text` into the target conversation wrapped in `<external_event>`.
- `timezone` takes an IANA timezone name (e.g. `Asia/Shanghai`; defaults to `UTC`).
- `targetConversationId` and `targetProfileId` are mutually exclusive; omit both to let default trigger routing select the target conversation.
- Make `text` self-contained (explicit task, paths, and conditions) because it executes in a future turn without current conversational context.

## Webhook actions (`run_action` & CLI)

- `builtin:triggers.webhook_list` (`{}`) — list configured webhook endpoints (metadata only, no secrets). CLI: `helmx webhook list --json`.
- `builtin:triggers.webhook_delete` (`{ id }`) — delete a webhook endpoint and its stored secret. CLI: `helmx webhook delete`.
- **Creating webhooks (`builtin:triggers.webhook_create`) is CLI / HTTP / UI-only**: its scope excludes all conversation contexts (`403`) so HMAC secrets never enter model conversation history. Ask the user to run `helmx webhook create` (or create it in the Trigger Manager UI), then share the inbound endpoint URL and signing header: `x-helmx-signature: sha256=<hex>` (HMAC-SHA256 over the raw request body bytes).
