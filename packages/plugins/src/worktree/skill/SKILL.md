---
name: worktree
description: Use when working inside or managing isolated Git worktrees (isolation: "worktree")—covers inspection, merging, safe cleanup via run_action and the cleanup_worktree tool, and durable lease/hold guardrails.
managedByPlugin: builtin:worktree
---

# Managed Git Worktrees

Use `builtin:worktree` to inspect and safely clean up Helmx-managed isolated Git worktrees created by `isolation: "worktree"` (or by sibling plugins such as `builtin:swarm`).

## Golden Rule

- **NEVER delete a Helmx-managed worktree with `rm -rf` or raw `git worktree remove`.** Bypassing the plugin leaves orphaned lease/registration entries (`409 worktree_missing`) and skips occupancy and unmerged-commit checks.
- Always inspect and merge (or intentionally discard) changes first, then clean up inside Agent turns via the direct `cleanup_worktree` tool or `run_action({ actionId: "builtin:worktree.cleanup_worktree", ... })` — do not shell out to `helmx` via `bash` (CLI for terminals/scripts: `helmx worktrees cleanup`).

## Layout, Context & Resume Rules

- **Directory & branch**: allocated under a sibling `.helmx-worktrees/` directory beside the target repo's main worktree (never nested inside another worktree), on branch `helmx/spawn-<shortId>`.
- **Base commit**: created from the source repo's current `HEAD` — uncommitted edits in the source working tree are NOT copied (`dirtySource: true` flags a dirty source).
- **Inside a worktree session**: `<worktree_context>` provides `worktreeId`, `path`, `branch`, `baseCommit`, and `baseBranch`. Run `git add` and `git commit` before finishing your turn so the branch captures all edits cleanly.
- **Resuming an isolated sub-session**: reuses the original node and worktree. Passing `nodeId` on resume fails with `400 validation_error`; passing a conflicting `cwd` fails with `409 resume_cwd_conflict`; resuming after cleanup fails with `409 worktree_missing`.

## Public Actions (`run_action` & `cleanup_worktree` Tool)

Inside Agent turns, always use the direct `cleanup_worktree` tool (exposed whenever active managed worktrees exist) and `run_action({ actionId, input })` (or `run_action({ actionId, describe: true })` to inspect full schemas) — do not shell out to `helmx` via `bash`. Equivalent `helmx worktrees <subcommand>` CLI commands are strictly for human terminals or external scripts:

- `builtin:worktree.list_worktrees` (`{}`) — list all managed worktree registrations, including `status: "removed"` audit records and active `hold` metadata. (CLI for terminals/scripts: `helmx worktrees list --json`)
- `builtin:worktree.inspect_worktree` (`{ worktreeId? | conversationId? | path?, nodeId?, scope?, commit? }`) — read-only metadata plus a lightweight git summary probe on the target node (`exists`, `currentBranch`, `currentHead`, `branchChanged`, `commitsAhead`, `unmergedCommits`, `diffBase`, `scope`, `commits`, `summary`, `files`). `scope` defaults to `'all'` (`'all' | 'committed' | 'uncommitted'`). Never runs full-repo diff. (CLI for terminals/scripts: `helmx worktrees inspect <worktreeId> --json`)
- `builtin:worktree.inspect_worktree_file` (`{ worktreeId? | conversationId? | path?, nodeId?, filePath, oldPath?, scope?, commit?, contextLines? }`) — read-only single-file diff or bounded untracked preview (`diff | untracked | binary | too_large | special_file | unchanged | absent`). (CLI for terminals/scripts: `helmx worktrees file <worktreeId> --file-path <path> --json`)
- `builtin:worktree.cleanup_worktree` / `cleanup_worktree` tool (`{ worktreeId? | conversationId? | path?, nodeId?, deleteBranch?, mergedInto?, force?, allowUnverifiedUsage? }`) — safely remove a registered worktree and update the ledger. (CLI for terminals/scripts: `helmx worktrees cleanup`)

### Selector Rules

- Provide **at most one** primary selector: `worktreeId` (`<nodeId>:<path>`), `conversationId`, or `path`.
- `nodeId` may ONLY be combined with `path` to disambiguate identical paths on different nodes.
- In `cleanup_worktree`, omitting all selectors defaults to the current conversation (`--current` in CLI).
- Only Helmx-registered worktrees are inspected or cleaned (`404 not_found` for unregistered paths).

## Cleanup Guardrails & Recommended Flow

1. **Discover**: call `run_action({ actionId: "builtin:worktree.list_worktrees", input: {} })` or use the `worktreeId` from execution metadata.
2. **Inspect**: call `run_action({ actionId: "builtin:worktree.inspect_worktree", input: { worktreeId } })` to verify `summary`, `files`, `commits`, and `unmergedCommits`; then call `run_action({ actionId: "builtin:worktree.inspect_worktree_file", input: { worktreeId, filePath } })` on individual files you need to review.
3. **Merge & verify**: merge the `helmx/spawn-*` branch into your target branch in the main or integration worktree and run verification.
4. **Clean up**: call `cleanup_worktree({ worktreeId, mergedInto: "<target-branch>", deleteBranch: true })` (or `run_action({ actionId: "builtin:worktree.cleanup_worktree", input: ... })`).

Key safety flags and error semantics:

- **Dirty / unmerged protection (`409 worktree_dirty`)**: default cleanup refuses uncommitted changes, untracked files, or commits not merged into `mergedInto` (defaults to recorded `baseBranch`, falling back to main worktree `HEAD`).
- **`deleteBranch`**: branches are kept by default; pass `deleteBranch: true` to remove the `helmx/spawn-*` branch. If branch deletion fails after worktree removal (`502 branch_delete_failed`), the record stays `removed` and you can safely retry cleanup with `deleteBranch: true`.
- **`force: true` scope**: ONLY bypasses `worktree_dirty` and missing-directory recovery (`409 worktree_missing`, where `force: true` re-verifies absence, runs `git worktree prune`, and clears the registration). `force: true` NEVER bypasses:
  - active sub-sessions or durable plugin holds (`409 worktree_in_use`),
  - running processes holding the directory (`409 worktree_process_in_use`),
  - `git worktree lock` (`409 worktree_locked`),
  - ownership/branch/symlink/main-worktree mismatches,
  - process-scan failures (`502 worktree_process_check_failed`).
- **`allowUnverifiedUsage`**: omit by default. Pass `allowUnverifiedUsage: true` (CLI for terminals/scripts: `--allow-unverified-usage`) ONLY after receiving `501 worktree_usage_unverifiable` on non-Linux nodes once you have confirmed no sub-session, terminal, IDE, or background process still occupies the directory.
- **Durable plugin holds**: sibling plugins (such as `builtin:swarm`) attach `ManagedWorktreeHold` via internal plugin-only actions (`acquire_worktree` / `release_worktree_hold`, not callable via `run_action` or HTTP). Release or close the owning group (e.g. `swarm_close_group`) before cleaning up a held worktree.
