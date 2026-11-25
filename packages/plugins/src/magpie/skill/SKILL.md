---
name: magpie
description: Use when diagnosing Magpie dynamic model gateway connectivity, checking live provider/model quotas, or forcing a Magpie model catalog refresh via builtin:magpie actions and helmx magpie CLI.
managedByPlugin: builtin:magpie
---

# Magpie Dynamic Model Gateway

Use `builtin:magpie` to inspect gateway connectivity, check live provider/model quotas, and refresh the dynamic `magpie/<model>` catalog from a local or remote Magpie gateway.

## Configuration & Model Namespace

- **Provider prefix**: models discovered from the gateway are registered under `magpie/<model>`.
- **Gateway resolution**: defaults to local loopback `http://127.0.0.1:3425` (default token `magpie`), overridable via environment (`MAGPIE_GW_URL` / `MAGPIE_ADDR`) or plugin config:
  - `gatewayUrl`: gateway root URL (e.g. `http://host:3425`; invalid URLs fail explicitly with `400 magpie_invalid_gateway_url`).
  - `apiKey` (secret): Bearer token for remote gateways (stored in `credentials.json`, never exposed in status docs, action outputs, or error messages).
  - `showQuotaStatus` (boolean, default `true`): toggles composer quota status UI and foreground polling.
  - `refreshIntervalSec` (integer `0..3600`, default `5`): foreground auto-refresh cadence while a `magpie/*` model is open (`0` disables).

## Public Actions (`run_action` & CLI)

Call actions via `run_action({ actionId, input })` (or `run_action({ actionId, describe: true })` to inspect schemas) or run `helmx magpie <action>`:

- `builtin:magpie.status` (`{}`) — read the current status snapshot (`gatewayUrl`, `configuredRoot`, `local`, `reachable`, `modelCount`, `lastRefreshedAt`, `lastError`, `quotasRefreshedAt`, `quotasUpdatedAt`, `quotasError`, `summaryText`, `modelOwners`, `quotas`, `diagnostics`). CLI: `helmx magpie status --json`.
- `builtin:magpie.quota` (`{ model?: string }`) — query live quotas from `GET /v1/magpie/quotas` and update the status doc. Pass optional `model` (with or without `magpie/` prefix, e.g. `magpie/group/relay` or `anthropic/claude-sonnet-4.6`) to filter rows to that model's owning provider (resolved via `modelOwners` or direct prefix). Returns `{ quotas, local, note? }`; throws `502 magpie_gateway_unreachable` on failure. CLI: `helmx magpie quota [--model <id>] --json`.
- `builtin:magpie.refresh` (`{ onlyIfChanged?: boolean }`) — force-refresh the model catalog (`/v1/models`) and live quotas (`/v1/magpie/quotas`). Omit `onlyIfChanged` for manual refreshes (`onlyIfChanged: true` skips persisting the catalog and broadcasting `models.changed` when `/v1/models` is unchanged, intended for periodic polling). Returns `{ refreshed, modelCount, reachable, lastError? }`; fails explicitly with `502 magpie_gateway_unreachable` if unreachable or `409 magpie_gateway_changed` if gateway config changed mid-refresh. CLI: `helmx magpie refresh --json`.

## Diagnostics & Honesty Rules

- **Inspect `status` first**: check `reachable`, `lastError`, `quotasError`, and `diagnostics` before assuming a model ID is wrong.
- **Cached vs live counts**: when `reachable` is `false`, `modelCount` is only the cached catalog count, never a live refresh result. After switching `gatewayUrl` or `apiKey`, `status` reports `reachable: false` and `modelCount: 0` for the new root until refreshed.
- **Catalog out of sync**: run `builtin:magpie.refresh` (`{}`) — or `helmx models refresh --providers magpie` — whenever models are added to or removed from the gateway.
- **Remote gateways (`local: false`)**: only quotas reported by that gateway itself are readable (`note` is returned by `quota`), and an explicit matching `apiKey` must be configured in plugin settings. Never echo or paste `apiKey` or Bearer tokens in conversation text.
