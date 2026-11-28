---
name: duo
description: Use when running or configuring dual-phase Planning/Execution orchestration (builtin:duo)—covers Planner-Executor separation, exit_plan_mode / hand_back_to_planner handoffs, step budgets, Profile and per-conversation configuration, and subagent/Swarm inheritance.
managedByPlugin: builtin:duo
---

# Dual-Phase Planning & Execution (`builtin:duo`)

`builtin:duo` keeps top-level human-owned conversations starting in a **read-only Planning Phase** on the conversation's configured Planner model, then hands execution off in place to a dedicated **Executor model** (`executorModel`, concrete `provider/model` or `tier/<id>`) without mutating persisted conversation overrides.

## Configuration Scopes

1. **Planner Model**: Always equals the conversation's configured model (`modelOverride` -> `Profile.model` -> global `defaultModel`).
2. **Profile-level Duo**: Configure `executorModel` (+ optional `executorThinkingLevel` and `maxExecutionSteps`, default `30`, `0` = unlimited) per Profile in Profile settings or via `builtin:duo.set_profile`. All top-level human conversations under that Profile inherit Duo automatically.
3. **Per-conversation Override**: Enable, change `executorModel` / `maxExecutionSteps`, or explicitly disable Duo (`enabled: false`) for one conversation via Composer controls or `builtin:duo.set_conversation` / `builtin:duo.clear_conversation`.
4. **Model Tiers lockstep**: Using symbolic tier refs such as Planner `tier/architect` + Executor `tier/coder` lets switching a `builtin:tiers` preset template upgrade both roles together automatically.

## Runtime State Machine (`planning` <-> `execution`)

- **Planning Phase (`phase: "planning"`)**: Runs on the Planner model with read-only research tools (`read`, `read_artifact`, `load_skill`, `ask_user`, `bash`, `run_action`), active delegation tools (`subagent`, `SubagentWorkflow`, `swarm_*` when allowed), and `exit_plan_mode`.
- **`exit_plan_mode({ plan })`**: Call alone to transition in place to the Executor model (`phase: "execution"`).
- **Execution Phase (`phase: "execution"`)**: Runs on `executorModel` with full workspace tools, counting tool steps against `maxExecutionSteps`.
- **`hand_back_to_planner({ reason, summary })`**: Call alone when blocked by a flawed plan, missing user clarification, or reaching `maxExecutionSteps` — returns immediately to Planner and Planning Phase.
- **Auto-restore**: Settling any turn (`completed | failed | aborted`), resetting (`/clear`), or disabling `builtin:duo` restores the conversation's baseline Planner model.

## Interop Rules

- **`/plan` precedence**: When `builtin:plan` is active in read-only `/plan` mode, `builtin:duo` yields completely during planning; approving a `/plan` emits `plan.approved` and transitions an active Duo conversation straight into Execution Phase (respecting any explicit execution model selected during approval).
- **Subagents, Workflows & Swarm**: Children never run Duo loops directly and default omitted `model` arguments to the Duo `executorModel`.
- **Swarm Coordinators**: Conversations tagged `swarm-coordinator` remain in planning posture on their Planner model and never enter self-coding execution turns, while still sharing `executorModel` as default child model.

## Actions (`run_action`)

- `builtin:duo.status` (`{ conversationId? }`) — inspect resolved Duo state and configuration for a conversation (read-only).
- `builtin:duo.set_conversation` (`{ conversationId?, enabled, executorModel?, executorThinkingLevel?, maxExecutionSteps? }`) — set or disable per-conversation Duo override.
- `builtin:duo.clear_conversation` (`{ conversationId? }`) — remove per-conversation Duo override and revert to Profile inheritance.
- `builtin:duo.set_profile` (`{ profileId, enabled, executorModel?, executorThinkingLevel?, maxExecutionSteps? }`) — configure Profile-level Duo defaults.
- `builtin:duo.clear_profile` (`{ profileId }`) — remove Profile-level Duo configuration.
