---
name: duo
description: Use when running or configuring Dual-Phase Orchestration Recipes (builtin:duo)—covers Planner-Executor recipes mounted as tier/<id>, exit_plan_mode / hand_back_to_planner handoffs, step budgets, temporary conversation overrides, and subagent/Swarm inheritance.
managedByPlugin: builtin:duo
---

# Dual-Phase Orchestration Recipes (`builtin:duo`)

`builtin:duo` mounts **Duo Recipes** (`tier/<recipeId>`) into the model catalog so top-level human conversations (or Profiles) can pair a **Planner** model with an **Executor** model in one selection.

## 1. Duo Recipes & Phase Alternation
- **Manage Recipes**: Use `helmx duo list|get|set|remove` (or open **Duo Recipes** in the Web sidebar).
  - Each recipe binds `plannerModel` + `executorModel` (either concrete `provider/modelId` or a single-model `tier/<id>` from `builtin:tiers`, never another Duo recipe) and `maxExecutionSteps` (default `30`, `0` = unlimited).
  - Duo recipes carry `singleTurnEligible: false` and `preserveRef: true`, so they appear under **Dual-phase recipes** in the primary Model Picker while remaining hidden from single-turn subagent `<available_model_tiers>`.
- **Planning Phase (`phase: "planning"`)**: Runs on the Planner model with read-only research tools (`read`, `read_artifact`, `load_skill`, `ask_user`, `bash`, `run_action`), active delegation tools (`subagent`, `SubagentWorkflow`, `swarm_*` when allowed), and `exit_plan_mode`.
- **`exit_plan_mode({ plan })`**: Call alone to transition in place to the Executor model (`phase: "execution"`).
- **Execution Phase (`phase: "execution"`)**: Full workspace toolset runs on the Executor model up to `maxExecutionSteps` turns; when the turn settles, the conversation automatically restores to Planning Phase and the Planner model.
- **`hand_back_to_planner({ reason, summary })`**: Call alone when blocked by a flawed plan, missing user clarification, or reaching `maxExecutionSteps` — returns immediately to Planner and Planning Phase.

## 2. Subagent, Swarm & `/plan` Interop
- Subagents/Workflows/Swarm workers spawned without an explicit `model` under an active Duo conversation (or targeting a Profile bound to a Duo recipe) automatically inherit the **Executor** model (`helmx.default-child-model` + `agent_spawn`), reserving the Planner model for planning and orchestration.
- Active `/plan` mode (`builtin:plan`) takes precedence while planning; once `/plan` approves into execution, `builtin:duo` hands off to its Execution Phase budget unless the user explicitly chose a different model at approval time.
- Active `swarm-coordinator` conversations stay on the Planner model (`exit_plan_mode` / `hand_back_to_planner` suppressed) while workers continue inheriting the Executor.
- Use `helmx duo override-executor` / `clear-override` (or the composer Duo pill) for temporary per-conversation Executor tuning without editing the underlying recipe.
