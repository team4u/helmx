---
name: model-tiers
description: Use when orchestrating multi-model collaboration with configured model tiers (tier/<id>)—covers task-to-tier matching, escalation ladders, cross-model blind review, fork expert consultation, and tier template management.
managedByPlugin: builtin:tiers
---

# Model Tiers Collaboration Playbook

Model tiers decouple **cognitive roles** (`tier/<id>`) from **concrete model IDs** (`provider/model`). You can define your own tier names and save multiple switchable preset templates without modifying workflows, profiles, or prompts.

## Core Mechanics

1. **Symbolic in configuration & scripts, frozen on live instances**:
   - Saved workflow scripts, `Profile.model`, global `defaultModel`, and `compactionModel` may store `tier/<id>` symbolically so switching a tier binding or applying a preset template upgrades future runs immediately.
   - When a conversation, subagent, or worker is created (or explicitly switched to a tier), Helmx resolves `tier/<id>` once and freezes the concrete `provider/model` + preset `thinkingLevel` onto that instance. This protects Prompt Cache hit rates and guarantees deterministic resume/reattach.
2. **Honest failure (never silent fallback)**:
   - If a referenced tier is missing or its underlying concrete model is disabled, execution fails explicitly (`404 model_tier_not_found` / `409 model_disabled`) instead of silently falling back to an unintended default model.
3. **Native runtimes only**:
   - `tier/<id>` works everywhere a native session model is accepted (subagent dispatch, workflow `agent()`, Swarm worker creation and `switch_worker_model`, `Profile.model`, global defaults, CLI).
   - External CLI runtimes (e.g. `herdr:*`) manage their own models—never pass `model` to them.

## Discovering Active Tiers

- When auto-injection is enabled, active usable tiers appear directly in `<available_model_tiers>` with their `tier/<id>`, preset effort, and routing guidance.
- Otherwise (or to inspect saved templates and disabled/unavailable entries), query the live roster via `run_action({ actionId: "builtin:tiers.list", input: {} })` (CLI: `helmx tiers list --json`).
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
  - When no tiers are configured, inspect live available models via `core:models.list` (CLI: `helmx models list --json`) and pass a concrete `provider/modelId`.
- **Auto-restore discipline (`restoreAfterTurn`, default `true`)**:
  - After calling `switch_model({ model: "...", effort?: "..." })`, the next reasoning step in the **same turn** immediately runs on the new model.
  - When `restoreAfterTurn` is `true` (default), Helmx automatically restores the conversation's original model and thinking level once the turn settles. **Simply continue and finish your answer — NEVER call `switch_model` a second time just to switch back.**
  - Pass `restoreAfterTurn: false` only when the user explicitly asks to switch the conversation permanently.
- **User-initiated one-turn borrow**:
  - Users can also trigger a one-turn borrow directly via `/model <tier-or-provider/model> <message>` (immediate borrow + clean message without prefix), `/model <target>` (arm next turn), or the Composer `+` menu (`One-turn model` / bare `/model` picker).
- **Plan mode boundary**:
  - While a conversation is in read-only `/plan` mode, tool access is restricted to the plan-mode read-only whitelist (`switch_model` is unavailable during planning; pick an execution model in `plan_propose` approval or borrow before/after planning).

## Managing Tiers & Preset Templates

All management operations are exposed as plugin actions (CLI via `helmx tiers <action>` or `run_action`):

- List active tiers & saved templates: `helmx tiers list --json`
- Add or update one tier: `helmx tiers set --id <id> --model <provider/model> [--thinking-level <level>] [--description "..."]`
- Remove one tier (blocks with `409 model_tier_in_use` if referenced by defaults/profiles unless `--force`): `helmx tiers remove --id <id>`
- Save active tiers as a reusable template: `helmx tiers save-template --id <tpl-id> --name "<title>" [--description "..."]`
- Switch entire tier roster in one step: `helmx tiers apply-template --id <tpl-id>`
- Delete a saved template: `helmx tiers delete-template --id <tpl-id>`
- Inspect / arm / clear one-turn borrow: `helmx tiers get-borrow --current`, `helmx tiers set-borrow --current --model <target> [--effort <level>]`, `helmx tiers clear-borrow --current`
