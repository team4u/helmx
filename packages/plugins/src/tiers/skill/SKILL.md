---
name: model-tiers
description: Use when orchestrating multi-model collaboration with configured model tiers (tier/<id>)—covers task-to-tier matching, escalation ladders, cross-model blind review, fork expert consultation, and tier template management.
managedByPlugin: builtin:tiers
---

# Model Tiers Collaboration Playbook

Model tiers decouple **semantic capability tiers** (`tier/<id>`) from **concrete model IDs** (`provider/model`). You can define your own tier names and save multiple switchable preset templates without modifying workflows, profiles, or prompts.

## Core Mechanics

1. **Symbolic in configuration & scripts, frozen on live instances**:
   - Saved workflow scripts, `Profile.model`, global `defaultModel`, and `compactionModel` may store single-model `tier/<id>` references symbolically so switching a tier binding or applying a preset template upgrades future runs immediately. (Dual-phase `orchestrator` tiers are reserved exclusively for top-level human sessions, never appear in `<available_model_tiers>`, and cannot be passed to `subagent`, `workflow`, `swarm`, `compactionModel`, or `switch_model`; subagents and workflows spawned anywhere under an orchestrator-tier conversation automatically route to its concrete `executorModel`, and child conversations inheriting an orchestrator `Profile.model` unwrap cleanly to `executorModel`.)
   - When a conversation, subagent, or worker is created (or explicitly switched to a single tier), Helmx resolves `tier/<id>` once and freezes the concrete `provider/model` + preset `thinkingLevel` onto that instance. This protects Prompt Cache hit rates and guarantees deterministic resume/reattach.
2. **Honest failure (never silent fallback)**:
   - If a referenced tier is missing or its underlying concrete model is disabled, execution fails explicitly (`404 model_tier_not_found` / `409 model_disabled`) instead of silently falling back to an unintended default model.
3. **Native runtimes only**:
   - `tier/<id>` works everywhere a native session model is accepted (subagent dispatch, workflow `agent()`, Swarm worker creation and `switch_worker_model`, `Profile.model`, global defaults, CLI).
   - Always pass `tier/<id>` via the **`model`** parameter—never in `agentType` or `profileId` (which select Profiles or external runtimes, not model tiers).
   - External CLI runtimes (e.g. `herdr:*`) manage their own models—never pass `model` to them.

## Discovering Active Tiers

- When auto-injection is enabled, active usable tiers appear directly in `<available_model_tiers>` with their `tier/<id>`, preset effort, and routing guidance.
- Otherwise (or to inspect saved templates and disabled/unavailable entries), query the live roster via `run_action({ actionId: "builtin:tiers.list", input: {} })` — do not shell out to `helmx` via `bash` (CLI for terminals/scripts: `helmx tiers list --json`).
- Always match tasks against the **actually configured tiers** rather than assuming fixed tier names exist.

## Multi-Tier Orchestration Patterns

Map the generic roles below to whichever configured `tier/<id>` entries best fit them in your active roster:

### 1. Divide & Conquer (Explore -> Decide -> Implement -> Blind Review)
- **Fast / high-quota tier**: Read-only codebase reconnaissance, log scanning, document summarization, and broad search.
- **Strongest reasoning tier**: High-leverage architecture contracts, tricky root-cause diagnosis, and critical design trade-offs (keep prompts focused and output concise).
- **Workhorse implementation tier(s)**: Parallel feature implementation, refactoring, and test authoring inside isolated worktrees.
- **Independent review tier** (ideally a different model family from the implementer): Fresh-context blind review (no `fork`) focused on edge cases, races, and contract gaps before merging.

### 2. Fork Expert Consultation (Cost-Efficient Main Session)
Keep long-running interactive sessions on a responsive workhorse tier; when hitting a deep architectural fork in the road, branch the full completed conversation context once to your strongest reasoning tier:
- `subagent({ fork: true, model: "tier/<architect>", prompt: "Review the context and decide the cleanest architecture contract..." })`
- Bring the concise decision back into the main session for implementation.

### 3. Gate-Driven Escalation Ladder
- **Deterministic workflows**: Start implementation on a fast/workhorse tier backed by a strict shell `gate` (build + typecheck + tests). In a `try/catch`, escalate only failures to a stronger tier with the failure diagnostics.
- **Peer Swarm**: Dispatch workers on the workhorse tier; if a worker stalls on a complex bug, upgrade that worker in place via `switch_worker_model` using a stronger `tier/<id>` while keeping its accumulated context.

### 4. In-Session Model Borrow & Relay (Same Thread)
When a **top-level human conversation** only needs a stronger or specialized model for the current reply — and keeping the full linear thread context is cleaner than spawning a separate child conversation — relay in place with `switch_model` instead of `subagent`:

- **When to use `switch_model` vs `subagent`**:
  - Use `switch_model` for single-thread reasoning relays (e.g., you already gathered files/diagnostics in the main thread and want a stronger model to synthesize the final design, root cause, or code review directly in the user's thread).
  - Use `subagent` / `SubagentWorkflow` for parallelizable tasks, isolated worktree edits, fresh-context blind review, or long background execution.
- **Target syntax (works with or without configured tiers)**:
  - Accepts `tier/<id>`, bare `<tierId>`, exact concrete `provider/modelId`, or a unique bare `<modelId>`.
  - When no tiers are configured, inspect live available models via `run_action({ actionId: "core:models.list", input: {} })` and pass a concrete `provider/modelId` (CLI for terminals/scripts: `helmx models list --json`).
- **Auto-restore discipline (`restoreAfterTurn`, default `true`)**:
  - After calling `switch_model({ model: "...", effort?: "..." })`, the next reasoning step in the **same turn** immediately runs on the new model.
  - When `restoreAfterTurn` is `true` (default), Helmx automatically restores the conversation's original model and thinking level once the turn settles. **Simply continue and finish your answer — NEVER call `switch_model` a second time just to switch back.**
  - Pass `restoreAfterTurn: false` only when the user explicitly asks to switch the conversation permanently.
- **User-initiated one-turn borrow**:
  - Users can arm a one-turn borrow directly from the bottom model picker's top **"Next turn"** mode tab (or click the armed `[ Next turn: <model> × ]` toolbar pill to re-pick or cancel). Inside Agent turns, inspect or manage borrow state via `run_action` with `builtin:tiers.get_borrow` / `builtin:tiers.set_borrow` / `builtin:tiers.clear_borrow` — do not shell out to `helmx` via `bash` (CLI for terminals/scripts: `helmx tiers set-borrow --current --model <target> [--effort <level>]`).
- **Plan mode boundary**:
  - While a conversation is in read-only `/plan` mode, tool access is restricted to the plan-mode read-only whitelist (`switch_model` is unavailable during planning; pick an execution model in `plan_propose` approval or borrow before/after planning).

## Managing Tiers & Preset Templates (`run_action`)

Inside Agent turns, always call tier management actions via `run_action({ actionId, input })` (or `run_action({ actionId, describe: true })` to inspect full schemas) — do not shell out to `helmx` via `bash`. Equivalent `helmx tiers ...` CLI commands are strictly for human terminals or external scripts:

- `builtin:tiers.list` (`{}`) — list active tiers (with live availability), saved preset templates, and catalog injection state. (CLI for terminals/scripts: `helmx tiers list --json`)
- `builtin:tiers.set` (`{ id, model, kind?, thinkingLevel?, executorModel?, executorThinkingLevel?, maxExecutionSteps?, description? }`) — create or update one tier binding (`model` is a concrete `provider/model`; `kind` is `"single" | "orchestrator"`; `thinkingLevel` / `executorThinkingLevel` accept `"" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"`; `executorModel`, `executorThinkingLevel`, and `maxExecutionSteps` apply to dual-phase `orchestrator` tiers). (CLI for terminals/scripts: `helmx tiers set --id <id> --model <provider/model> [--thinking-level <level>] [--description "..."]`)
- `builtin:tiers.remove` (`{ id, force? }`) — delete a tier binding (blocks with `409 model_tier_in_use` if referenced by defaults/profiles unless `force: true`). (CLI for terminals/scripts: `helmx tiers remove --id <id> [--force]`)
- `builtin:tiers.save_template` (`{ id, name, description?, tiers? }`) — save active tiers as a reusable preset template (omitting `tiers` snapshots the currently active tiers). (CLI for terminals/scripts: `helmx tiers save-template --id <tpl-id> --name "<title>" [--description "..."]`)
- `builtin:tiers.apply_template` (`{ id, force? }`) — switch the entire active tier roster to a saved preset template in one step (pass `force: true` to bypass in-use reference blocks). (CLI for terminals/scripts: `helmx tiers apply-template --id <tpl-id> [--force]`)
- `builtin:tiers.delete_template` (`{ id }`) — delete a saved preset template (does not affect currently active tiers). (CLI for terminals/scripts: `helmx tiers delete-template --id <tpl-id>`)
- `builtin:tiers.get_borrow` (`{ conversationId? }`) — inspect armed or active one-turn model borrow state (`conversationId` defaults to the current conversation). (CLI for terminals/scripts: `helmx tiers get-borrow --current --json`)
- `builtin:tiers.set_borrow` (`{ conversationId?, model, effort? }`) — arm a one-turn model borrow for the next message in a top-level human conversation (`model` accepts `tier/<id>`, `<tierId>`, `provider/modelId`, or unique `<modelId>`). (CLI for terminals/scripts: `helmx tiers set-borrow --current --model <target> [--effort <level>]`)
- `builtin:tiers.clear_borrow` (`{ conversationId? }`) — cancel an armed one-turn borrow or disable auto-restore on an active borrow. (CLI for terminals/scripts: `helmx tiers clear-borrow --current`)
