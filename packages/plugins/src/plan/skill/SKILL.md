---
name: plan
description: Use when working in or managing read-only Plan Mode (/plan, Ctrl+.)—covers eligibility, read-only tools (plan_bash, ask_user, plan_save, plan_propose), self-contained draft authoring, AskDoc approval/handoff, and builtin:plan actions.
managedByPlugin: builtin:plan
---

# Plan Mode

Use `builtin:plan` for controlled read-only codebase exploration, structured requirement clarification, self-contained plan drafting, human AskDoc approval, artifact archival (`plan-v<N>.md`), and optional fresh-context / execution-model handoff.

## Eligibility & Entrypoints

- **Strict scope**: Plan Mode ONLY supports **top-level human-owned conversations** (`parentConversationId === undefined && (ownedBy ?? 'human') === 'human'`). Subagents and `ownedBy: 'helmx'` conversations reject `toggle`, `set_mode`, and `update_draft` with `400 plan_unsupported_conversation` (`get` returns `{ mode: "normal", awaitingApproval: false }`).
- **User entrypoints**: `/plan` or `/plan <task>` in Composer, `+` menu -> Plan Mode, `Ctrl+.`, or CLI (`helmx plan toggle --current` / `set_mode`).

## Read-Only Planning Sandbox & Tools

While `mode === "planning"`, `before_turn` enforces a strict tool whitelist of **7 tools only**: `read`, `read_artifact`, `load_skill`, `ask_user`, `plan_bash`, `plan_save`, and `plan_propose`. All mutating or dispatch tools (`bash`, `write`, `edit`, `register_artifact`, `run_action`, `subagent`, `SubagentWorkflow`, `cleanup_worktree`, `update_memory`, `swarm_*`) are stripped until approval or exit.

1. **`plan_bash({ command, timeoutMs? })`**:
   - Read-only shell inspection on the conversation node (default `60_000` ms, max `120_000` ms).
   - Validated before execution: blocks mutating commands, file write redirections, command substitution, mutating `helmx` flags or unknown plugins, `helmx-hub`, and `helmx-node`.
2. **`ask_user({ title?, questions })`**:
   - Kernel built-in structured prompt tool (available in both normal and planning modes for top-level human conversations) to ask `1–4` clarifying questions (`single_select`, `multi_select`, `text`, or `confirm`).
3. **`plan_save({ title, markdown })`**:
   - Save or revise the conversation's plan draft (`title`: `1–120` chars; `markdown`: `1–98,304` UTF-8 bytes; redacted; increments `draft.version`).
   - **Author self-contained drafts**: if the user approves with fresh-context handoff, prior exploration turns and file reads are cleared and the executor receives ONLY this Markdown. Always include exact file paths, key symbol/API names, concrete step-by-step changes, edge cases/constraints, and exact verification commands.
4. **`plan_propose({ summary })`**:
   - Submit the saved draft for human approval via `AskDoc` CAS (`summary`: `1–300` plain-text chars; triple-backtick code fences are rejected). Requires an existing saved draft and no other pending plan ask.

## Approval Outcomes, Archival & Handoff

The `plan_propose` approval card offers `decision`, optional `executionModel` (+ `executionThinkingLevel`, preselected from plugin config `executionModel` when set), and optional `feedback`:

- **`approve_handoff` (default)**: switches conversation model if `executionModel` is chosen, archives the latest draft as conversation artifact `plan-v<N>.md`, exits to `normal`, and returns `control.handoff` (up to 128 KiB) so the kernel records `pi.reset` and starts execution immediately in a fresh context.
- **`approve`**: switches conversation model if chosen, archives `plan-v<N>.md`, and exits to `normal` in the current context.
- **`revise` / `cancelled` / `superseded`**: stays in `planning` (unless the user explicitly exited plan mode) and creates no artifact. Sending a new human message while an ask is pending automatically supersedes the ask while keeping `planning` active.
- **Honest model-switch failure**: if switching to `executionModel` fails (e.g. `409 model_disabled` or `404 model_tier_not_found`), `plan_propose` returns an error, stays in `planning`, creates no artifact, and never falls back silently.
- **Human draft edits**: users can edit the draft directly in the Plan workbench panel (`update_draft`); approving archives the latest edited version.

## Public Actions (`run_action` Outside Planning Mode & CLI)

Note: `run_action` is stripped while inside `planning` mode; call these actions from `normal` mode, HTTP, or CLI (`helmx plan <action>`). `conversationId` defaults to the current conversation (`--current` in CLI); passing a conflicting `conversationId` fails with `400 validation_error`:

- `builtin:plan.get` (`{ conversationId? }`) — read `PlanSessionView` (`mode`, `awaitingApproval`, `draft?`, `approved?`). CLI: `helmx plan get --current --json`.
- `builtin:plan.toggle` (`{ conversationId? }`) — toggle between `normal` and `planning` (exiting to `normal` cancels any pending plan ask). CLI: `helmx plan toggle --current`.
- `builtin:plan.set_mode` (`{ conversationId?, mode: "normal" | "planning" }`) — set mode explicitly. CLI: `helmx plan set_mode --current --input '{"mode":"planning"}'`.
- `builtin:plan.update_draft` (`{ conversationId?, title, markdown, expectedVersion? }`) — update draft title and markdown with optional optimistic concurrency check (`expectedVersion`; mismatch fails with `409 plan_draft_conflict`). Requires either `mode === "planning"` or an existing draft. CLI: `helmx plan update_draft --current --input '{"title":"...","markdown":"..."}'`.
