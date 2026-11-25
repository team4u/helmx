---
name: worktree
description: Use when working inside or managing isolated Git worktrees (isolation: "worktree")—covers inspection, merging, safe cleanup via cleanup_worktree / helmx worktrees, and durable lease/hold guardrails.
managedByPlugin: builtin:worktree
---

# Managed Git Worktrees

Use `builtin:worktree` to inspect and safely clean up Helmx-managed isolated Git worktrees created by `isolation: "worktree"` (or by sibling plugins such as `builtin:swarm`).

## Golden Rule

- **NEVER delete a Helmx-managed worktree with `rm -rf` or raw `git worktree remove`.** Bypassing the plugin leaves orphaned lease/registration entries (`409 worktree_missing`) and skips occupancy and unmerged-commit checks.
- Always inspect and merge (or intentionally discard) changes first, then clean up via the `cleanup_worktree` tool, `builtin:worktree.cleanup_worktree`, or `helmx worktrees cleanup`.

## Layout, Context & Resume Rules

- **Directory & branch**: allocated under a sibling `.helmx-worktrees/` directory beside the target repo's main worktree (never nested inside another worktree), on branch `helmx/spawn-<shortId>`.
- **Base commit**: created from the source repo's current `HEAD` — uncommitted edits in the source working tree are NOT copied (`dirtySource: true` flags a dirty source).
- **Inside a worktree session**: `<worktree_context>` provides `worktreeId`, `path`, `branch`, `baseCommit`, and `baseBranch`. Run `git add` and `git commit` before finishing your turn so the branch captures all edits cleanly.
- **Resuming an isolated sub-session**: reuses the original node and worktree. Passing `nodeId` on resume fails with `400 validation_error`; passing a conflicting `cwd` fails with `409 resume_cwd_conflict`; resuming after cleanup fails with `409 worktree_missing`.

## Public Actions & CLI

Call actions via `run_action({ actionId, input })` (or `run_action({ actionId, describe: true })` to inspect full schemas), use the direct `cleanup_worktree` tool (exposed whenever active managed worktrees exist), or run `helmx worktrees <subcommand>`:

- `builtin:worktree.list_worktrees` (`{}`) — list all managed worktree registrations, including `status: "removed"` audit records and active `hold` metadata. CLI: `helmx worktrees list --json`.
- `builtin:worktree.inspect_worktree` (`{ worktreeId? | conversationId? | path?, nodeId?, diff? }`) — read-only metadata plus a real git probe on the target node (`exists`, `currentBranch`, `currentHead`, `branchChanged`, `dirtyFiles`, `dirtyFileCount`, `commitsAhead`, `unmergedCommits`, `diffStat`, `diffPreview`, `diffBase`). `diff` defaults to `true`. CLI: `helmx worktrees inspect <worktreeId> --json`.
- `builtin:worktree.cleanup_worktree` / `cleanup_worktree` tool (`{ worktreeId? | conversationId? | path?, nodeId?, deleteBranch?, mergedInto?, force?, allowUnverifiedUsage? }`) — safely remove a registered worktree and update the ledger. CLI: `helmx worktrees cleanup`.

### Selector Rules

- Provide **at most one** primary selector: `worktreeId` (`<nodeId>:<path>`), `conversationId`, or `path`.
- `nodeId` may ONLY be combined with `path` to disambiguate identical paths on different nodes.
- In `cleanup_worktree`, omitting all selectors defaults to the current conversation (`--current` in CLI).
- Only Helmx-registered worktrees are inspected or cleaned (`404 not_found` for unregistered paths).

## Cleanup Guardrails & Recommended Flow

1. **Discover**: call `builtin:worktree.list_worktrees` (`{}`) or use the `worktreeId` from execution metadata.
2. **Inspect**: call `builtin:worktree.inspect_worktree` (`{ worktreeId }`) to verify `dirtyFiles`, `unmergedCommits`, and diff.
3. **Merge & verify**: merge the `helmx/spawn-*` branch into your target branch in the main or integration worktree and run verification.
4. **Clean up**: call `cleanup_worktree({ worktreeId, mergedInto: "<target-branch>", deleteBranch: true })`.

Key safety flags and error semantics:

- **Dirty / unmerged protection (`409 worktree_dirty`)**: default cleanup refuses uncommitted changes, untracked files, or commits not merged into `mergedInto` (defaults to recorded `baseBranch`, falling back to main worktree `HEAD`).
- **`deleteBranch`**: branches are kept by default; pass `deleteBranch: true` to remove the `helmx/spawn-*` branch. If branch deletion fails after worktree removal (`502 branch_delete_failed`), the record stays `removed` and you can safely retry cleanup with `deleteBranch: true`.
- **`force: true` scope**: ONLY bypasses `worktree_dirty` and missing-directory recovery (`409 worktree_missing`, where `force: true` re-verifies absence, runs `git worktree prune`, and clears the registration). `force: true` NEVER bypasses:
  - active sub-sessions or durable plugin holds (`409 worktree_in_use`),
  - running processes holding the directory (`409 worktree_process_in_use`),
  - `git worktree lock` (`409 worktree_locked`),
  - ownership/branch/symlink/main-worktree mismatches,
  - process-scan failures (`502 worktree_process_check_failed`).
- **`allowUnverifiedUsage`**: omit by default. Pass `allowUnverifiedUsage: true` (CLI `--allow-unverified-usage`) ONLY after receiving `501 worktree_usage_unverifiable` on non-Linux nodes once you have confirmed no sub-session, terminal, IDE, or background process still occupies the directory.
- **Durable plugin holds**: sibling plugins (such as `builtin:swarm`) attach `ManagedWorktreeHold` via internal plugin-only actions (`acquire_worktree` / `release_worktree_hold`, not callable via `run_action` or HTTP). Release or close the owning group (e.g. `swarm_close_group`) before cleaning up a held worktree.
