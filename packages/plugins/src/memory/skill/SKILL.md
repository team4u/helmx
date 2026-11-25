---
name: memory
description: Use when reading, updating, toggling, or consolidating per-Profile long-term memory (MEMORY.md) or managing daily Dream consolidation via update_memory, builtin:memory actions, and helmx memory CLI.
managedByPlugin: builtin:memory
---

# Long-Term Memory & Daily Dream

Use `builtin:memory` to maintain durable, cross-conversation preferences and external environment facts in each Profile's `MEMORY.md`, and to inspect or schedule automatic daily Dream consolidation.

## Core Mechanics & Guardrails

- **Per-Profile file & hard cap**: stored at `<dataDir>/profiles/<profileId>/MEMORY.md` with a uniform **4,000-character hard cap** enforced atomically inside `withFileLock` on the merged final text (`400 memory_limit_exceeded` if exceeded).
- **Top-level conversations only**: only top-level conversations (`parentConversationId === undefined`) receive `<memory>` prompt injection and the `update_memory` tool. Child sessions (subagents, workflow agents, Swarm workers) have `update_memory` stripped and reject direct calls (`403 memory_session_not_eligible`).
- **Per-Profile toggle**: disabling memory on a Profile suppresses injection and blocks writes/dream (`403 memory_disabled_for_profile`) without deleting `MEMORY.md` or affecting other Profiles.
- **Missing file honesty**: if an already-initialized `MEMORY.md` is deleted externally, Helmx warns explicitly (`<memory_assets_missing>`) instead of silently recreating a blank file; writing via `update_memory` or restoring the file heals it.

## When to Update vs Skip (`update_memory`)

The `update_memory({ text, mode: "append" | "replace" })` tool updates the current top-level conversation Profile's `MEMORY.md`:

- **DO call `update_memory`** when:
  - The user explicitly asks you to remember or forget something.
  - The user corrects a durable preference, communication style, workflow convention, or external environment fact not documented in the repository.
  - `MEMORY.md` approaches or exceeds `4,000` characters — use `mode: "replace"` to consolidate and trim cleanly.
- **DO NOT store**:
  - Ephemeral task logs, pending deploy/commit checklists, or transient debugging status.
  - Facts already documented in repository docs, config files, skills, or git history.
  - Secrets, API keys, tokens, or credentials.
  - Routine conversational details — daily Dream consolidates normal turns automatically.

## Public Actions (`run_action` & CLI)

Call actions via `run_action({ actionId, input })` (or `run_action({ actionId, describe: true })` to inspect schemas) or run `helmx memory <action>`:

- **Target resolution** (`get`, `set`, `configure`, `dream`): explicit `profileId` (`--profile-id`) wins; omitting it resolves the current conversation's Profile (`--current` in CLI); missing both fails with `400 validation_error`; an unknown Profile fails with `404 profile_not_found`.
- `builtin:memory.get` (`{ profileId? }`) — read `{ profileId, enabled, content, initialized }`. CLI: `helmx memory get --current --json`.
- `builtin:memory.set` (`{ profileId?, text, mode?: "replace" | "append" }`) — write `MEMORY.md` (defaults to `mode: "replace"`). Rejects if memory is disabled (`403`) or over `4,000` chars (`400 memory_limit_exceeded`). CLI: `helmx memory set --current --text "<str>" [--mode replace|append]`.
- `builtin:memory.configure` (`{ profileId?, enabled, text? }`) — toggle per-Profile memory on/off, optionally replacing `MEMORY.md` atomically before committing the toggle (enabling lazily initializes an uninitialized file). CLI: `helmx memory configure --current --enabled <true|false> [--text "<str>"]`.
- `builtin:memory.dream` (`{ profileId? }`) — trigger Dream consolidation immediately for one Profile (`cli.timeoutMs: 0`; returns `{ profileId, ran, reason?, applied?, conflict?, candidateCount, beforeChars?, afterChars?, sentCount?, consumed? }`). CLI: `helmx memory dream --current`.
- `builtin:memory.dream_status` (`{ profileId? }`) — inspect global schedule config (`enabled`, `hour`, `timezone`), `nextRunAt`, `running` profiles, and per-Profile `{ profileId, enabled, candidateCount, memoryChars, lastRun }` (optional `profileId` or conversation context focuses on that Profile). CLI: `helmx memory dream_status --json`.
- `builtin:memory.dream_configure` (`{ enabled?, hour?, timezone? }`) — update the global daily Dream schedule (`hour`: integer `0..23`, `timezone`: IANA timezone name; at least one field required; disabling clears `nextRunAt`). CLI: `helmx memory dream_configure --enabled <true|false> --hour <0-23> --timezone <IANA>`.

## Daily Dream Consolidation

- **Candidate collection**: on `turn_settled` (`outcome === "completed"`), collects bounded, redacted human-origin (`origin: "human"`) excerpts from top-level human-owned conversations whose Profile has memory enabled (max 64 candidates per Profile, 14-day TTL, ~20k-char send budget per run).
- **Schedule & model**: defaults to daily `03:00` in the host's local IANA timezone. Runs a single-shot `completeText` call (no tools, no hidden conversations) using plugin config `dreamModel` if set, otherwise the model of the Profile's latest top-level human conversation (skips cleanly with `no_conversation_for_model` if none exists).
- **Budget & atomic CAS write-back**: targets a compact `1,500`-char soft ceiling with anti-ratchet cap `min(4000, max(3000, currentLength))`, requires a strict bare JSON object `{"memory":"..."}` (`502 dream_output_invalid` on invalid output), and commits inside `withFileLock` with hash CAS + enabled-switch guard so concurrent manual edits are never overwritten (`conflict: true`, candidates preserved).
