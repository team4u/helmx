---
name: plan
description: Use when working in or managing read-only Plan Mode (/plan, Ctrl+.)—covers eligibility, planning tools (read, bash, run_action, ask_user, plan_save, plan_propose), self-contained draft authoring, AskDoc approval/handoff, and builtin:plan actions.
managedByPlugin: builtin:plan
---

# Plan Mode

Use `builtin:plan` for controlled read-only codebase exploration, structured requirement clarification, self-contained plan drafting, human AskDoc approval, artifact archival (`plan-v<N>.md`), and optional fresh-context / execution-model handoff.

## Eligibility & Entrypoints

- **Strict scope**: Plan Mode ONLY supports **top-level human-owned conversations** (`parentConversationId === undefined && (ownedBy ?? 'human') === 'human'`). Subagents and `ownedBy: 'helmx'` conversations reject `toggle`, `set_mode`, and `update_draft` with `400 plan_unsupported_conversation` (`get` returns `{ mode: "normal", awaitingApproval: false }`).
- **User entrypoints**: `/plan` or `/plan <task>` in Composer, `+` menu -> Plan Mode, `Ctrl+.`, or `run_action` with `builtin:plan.toggle` / `builtin:plan.set_mode` in normal mode (CLI for terminals/scripts: `helmx plan toggle --current` / `helmx plan set_mode --current --input '{"mode":"planning"}'`).

## Read-Only Planning Sandbox & Tools

While `mode === "planning"`, `before_turn` enforces a strict tool whitelist of **8 tools only**: `read`, `read_artifact`, `load_skill`, `ask_user`, `bash`, `run_action`, `plan_save`, and `plan_propose` (`update_steps` is NOT included in `/plan` mode). All file-editing and delegation tools (`write`, `edit`, `register_artifact`, `subagent`, `SubagentWorkflow`, `cleanup_worktree`, `update_memory`, `swarm_*`, `switch_model`) are stripped until approval or exit.

1. **`bash` & `run_action` (model-level read-only planning constraints)**:
   - Native `bash` and `run_action` remain available during planning under model-level read-only constraints (no static shell validator).
   - Use `bash` strictly for read-only inspection, builds, typechecks, and tests (e.g. `rg`, `git status`/`log`/`diff`, test/build checks) — never modify workspace files, redirect output into files, create commits, or mutate external/host state.
   - Use `run_action` strictly for read-only queries (`describe: true`, `list`, `get`, and read-only status/inspection actions such as `builtin:plan.get`, `core:models.list`, `builtin:tiers.list`) — never invoke state-mutating actions during planning, and never shell out to `helmx` via `bash`.
2. **`ask_user({ title?, questions })`**:
   - Kernel built-in structured prompt tool (available in both normal and planning modes for top-level human conversations) to ask `1–4` clarifying questions (`single_select`, `multi_select`, `text`, or `confirm`).
   - Resolve blocking ambiguity in requirements, scope, or architecture tradeoffs via `ask_user` before calling `plan_propose` rather than leaving open questions inside the plan; for minor details, state your recommended default clearly under `User Review Required`.
3. **`plan_save({ title, markdown })`**:
   - Save or revise the conversation's plan draft (`title`: `1–120` chars; `markdown`: `1–98,304` UTF-8 bytes; redacted). Saving identical `title` and `markdown` (after redaction) is idempotent and leaves `draft.version` and the diff baseline unchanged; changing either increments `draft.version` and keeps `previousDraft` (anchored to `lastProposedVersion` across multiple pre-proposal edits after a `plan_propose`).
   - **Author self-contained, review-friendly drafts**: if the user approves with fresh-context handoff, prior exploration turns and file reads are cleared and the executor receives ONLY this Markdown. Include exact file paths, key symbol/API names, concrete step-by-step changes, edge cases/constraints, and exact verification commands, and structure clearly (omitting irrelevant sections for small tasks):
     - `## Goal`: concise problem statement, context, and expected outcome.
     - `## User Review Required`: highlight breaking changes, high-risk tradeoffs, or default assumptions using GitHub alerts (`> [!IMPORTANT]`, `> [!WARNING]`, `> [!CAUTION]`).
     - `## Proposed Changes`: group by package/component in dependency order and tag files with `[MODIFY]`, `[NEW]`, or `[DELETE]`. Link existing `[MODIFY]`/`[DELETE]` files as `[basename](repo/relative/path#L10-L20)` (full repo-relative path in the href); for `[NEW]` files that do not exist yet, use inline code with the full repo-relative path (never a file link). Add concise signature/`diff` snippets or a `mermaid` diagram when helpful.
     - `## Verification Plan`: split into `### Automated Tests` and `### Manual Verification` (when applicable).
   - **Do not duplicate the plan in chat**: the saved draft is already visible in the Plan workbench panel and composer tray; only highlight key tradeoffs or decisions needing user attention.
4. **`plan_propose({ summary })`**:
   - Submit the saved draft for human approval via `AskDoc` CAS (`summary`: `1–300` plain-text chars; triple-backtick code fences are rejected). Requires an existing saved draft and no other pending plan ask. Avoid repeating the full plan body in your chat reply.

## Approval Outcomes, Archival & Handoff

The `plan_propose` approval card offers `decision`, optional `executionModel` (+ `executionThinkingLevel`, preselected from plugin config `executionModel` when set), and optional `feedback`:

- **`approve_handoff` (default)**: switches conversation model if `executionModel` is chosen, archives the latest draft as conversation artifact `plan-v<N>.md`, exits to `normal`, and returns `control.handoff` (up to 128 KiB) so the kernel records `pi.reset` and starts execution immediately in a fresh context.
- **`approve`**: switches conversation model if chosen, archives `plan-v<N>.md`, and exits to `normal` in the current context.
- **`revise` / `cancelled` / `superseded`**: stays in `planning` (unless the user explicitly exited plan mode) and creates no artifact. Sending a new human message while an ask is pending automatically supersedes the ask while keeping `planning` active.
- **Honest model-switch failure**: if switching to `executionModel` fails (e.g. `409 model_disabled` or `404 model_tier_not_found`), `plan_propose` returns an error, stays in `planning`, creates no artifact, and never falls back silently.
- **Human draft edits**: users can edit the draft directly in the Plan workbench panel (`update_draft`); approving archives the latest edited version.

## Public Actions (`run_action`)

Inside Agent turns, always call actions via `run_action({ actionId, input })` (or `run_action({ actionId, describe: true })` to inspect schemas) — do not shell out to `helmx` via `bash`. During `planning` mode, `run_action` is reachable for read-only `builtin:plan.get`; state-mutating actions (`toggle`, `set_mode`, `update_draft`) are for `normal` mode, human UI, or external terminals/scripts. `conversationId` defaults to the current conversation (`--current` in CLI); passing a conflicting `conversationId` fails with `400 validation_error`:

- `builtin:plan.get` (`{ conversationId? }`) — read `PlanSessionView` (`mode`, `awaitingApproval`, `draft?`, `previousDraft?`, `approved?`); read-only and safe via `run_action` in both `normal` and `planning` modes. (CLI for terminals/scripts: `helmx plan get --current --json`)
- `builtin:plan.toggle` (`{ conversationId? }`) — toggle between `normal` and `planning` (exiting to `normal` cancels any pending plan ask; normal mode / human UI / external CLI only). (CLI for terminals/scripts: `helmx plan toggle --current`)
- `builtin:plan.set_mode` (`{ conversationId?, mode: "normal" | "planning" }`) — set mode explicitly (normal mode / human UI / external CLI only). (CLI for terminals/scripts: `helmx plan set_mode --current --input '{"mode":"planning"}'`)
- `builtin:plan.update_draft` (`{ conversationId?, title, markdown, expectedVersion? }`) — update draft title and markdown with optional optimistic concurrency check (`expectedVersion`; mismatch fails with `409 plan_draft_conflict`). Requires either `mode === "planning"` or an existing draft (normal mode / human UI / external CLI; inside planning turns use `plan_save`). (CLI for terminals/scripts: `helmx plan update_draft --current --input '{"title":"...","markdown":"..."}'`)
