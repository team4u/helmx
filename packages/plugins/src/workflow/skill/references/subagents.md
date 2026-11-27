# Subagent and Runtime Reference

## `subagent`

Use the `subagent` tool for one delegated task. Required input is `prompt`; useful options include `label`, `agentType`, `fork`, `nodeId`, `cwd`, `isolation: "worktree"`, `model`, `effort`, `gate`, `schema`, `attachments`, `maxSubagentDepth`, `resume`, and `background`.

- Use a short `label` so the task card and child conversation are identifiable.
- Human-owned conversations default to background. Keep working and wait for the automatic steer report; do not poll or sleep.
- Automation-owned conversations default to synchronous. Explicit `background: true` is rejected for those callers.
- In human-owned conversations, omit `background` for all `isolation: "worktree"` edits, gates, and multi-step research even when the parent will later review, merge, or summarize the result (completion automatically steers results back); reserve `background: false` strictly for seconds-long lightweight read-only calls.
- Concurrent identical `subagent` calls within the same parent conversation are rejected (`duplicate_subagent_call`); pass distinct `label` values when intentionally launching multiple independent parallel attempts.
- `agentType` selects the child runtime: either a native Profile ID (lowercase `a-z`, `0-9`, hyphen from `<available_profiles>`, defaulting to `assistant` or inheriting the parent on `fork: true`) or a plugin-claimed external runtime `<namespace>:<kind>` (e.g. `herdr:agy`). Never pass a model tier (`tier/<id>`) or `provider/model` in `agentType`.
- `model` and `effort` override the native session model and reasoning effort: `model` accepts a configured semantic tier `tier/<id>` (see `<available_model_tiers>`) or a concrete `provider/model`; omit `effort` when passing `tier/<id>` to inherit the tier's preset thinking level, or pass an explicit `effort` (`off | minimal | low | medium | high | xhigh | max`) to override it. External CLI runtimes manage their own models—do not pass `model` to them.
- `fork: true` creates a native child from the parent's completed context. It cannot be combined with `resume` and is unsupported for external runtimes. By default, a forked child runs as a leaf (`maxSubagentDepth` equals its own child depth, stripping dispatch tools and injecting a `<forked_subagent_context>` boundary so inherited parent delegation instructions are not repeated); pass an explicit `maxSubagentDepth` within the inherited ceiling only when further nesting is intentionally needed.
- `maxSubagentDepth`: subtree spawn-depth ceiling (`1..5`, defaults to `1` so level-1 subagents are leaves by default and cannot spawn further subagents or workflows unless plugin config or explicit `maxSubagentDepth` `2..5` grants deeper nesting; subagents cannot raise their inherited ceiling).
- `nodeId` targets a specific compute node (overrides Profile/parent node; explicit `"local"` switches back to the Hub host; remote nodes require `cwd` or a compatible Profile `cwd`; mutually exclusive with `resume`).
- `isolation: "worktree"` allocates a managed Git worktree, injects `<worktree_context>`, and keeps the child branch and worktree after the run for inspection and merge before cleanup. Always use this for isolated code edits instead of manually running `git worktree add` and passing `cwd`.
- `resume` continues an existing execution context. It is not the same as workflow ledger replay.

The business result and execution metadata are separate. Preserve `conversationId`, `effectiveCwd`, and `worktree` when later inspection or cleanup needs them.

## Background control

Use the dynamic `workflow_steer` model tool (exposed automatically while the current task tree has running background subagents), `run_action({ actionId: "builtin:workflow.steer", input: { runId, text } })`, or `helmx workflows steer <runId> --text <guidance>` only for a running background subagent that belongs to the current task tree. The operation is guarded by ownership and the current execution watermark. A successful delivery means the guidance was sent, not that it has already been executed.

## Worktree inspection & cleanup

List or inspect registered managed worktrees read-only via `run_action({ actionId: "builtin:worktree.list_worktrees", input: {} })`, `run_action({ actionId: "builtin:worktree.inspect_worktree", input: { worktreeId } })`, and single-file `run_action({ actionId: "builtin:worktree.inspect_worktree_file", input: { worktreeId, filePath } })` (CLI: `helmx worktrees list --json`, `helmx worktrees inspect <worktreeId> --json`, `helmx worktrees file <worktreeId> --file-path <relPath> --json`). For ordinary conversation workspaces, `builtin:changes.inspect_workspace` / `builtin:changes.inspect_workspace_file` (`helmx changes inspect` / `helmx changes file`) follow the same two-step read-only pattern.

After inspecting or merging a child worktree, call the model tool `cleanup_worktree({ worktreeId: execution.worktree.id })` with the real execution metadata. This is a conversation tool (registered by `builtin:worktree`, active whenever managed worktrees exist), not a DSL function.

The equivalent CLI is `helmx worktrees cleanup --worktree-id <id> --json`. Cleanup refuses dirty, unmerged, occupied, locked, or uncertain worktrees by default. `force` only addresses the dirty/unmerged protection and never bypasses the other safety checks. On nodes without process-occupancy scanning (such as Windows or macOS), cleanup returns `worktree_usage_unverifiable` unless `allowUnverifiedUsage: true` (`--allow-unverified-usage`) is explicitly passed after confirming no process occupies the directory.
