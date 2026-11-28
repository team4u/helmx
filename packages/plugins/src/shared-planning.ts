/**
 * Shared read-only planning sandbox primitives consumed by both `builtin:plan` and `builtin:duo`.
 * Keeping the base inspection whitelist and bash/run_action read-only guidance in one place prevents drift.
 */

export const READ_ONLY_PLANNING_BASE_TOOLS: ReadonlySet<string> = new Set([
  'read',
  'read_artifact',
  'load_skill',
  'ask_user',
  'bash',
  'run_action',
])

export const READ_ONLY_PLANNING_INSPECTION_RULE =
  '1. Research only: use `read`, `read_artifact`, and `load_skill` to inspect files and artifacts. Use `bash` strictly for read-only observation (code search, builds, typecheck, tests, `git status`/`log`/`diff`) and `run_action` strictly for read-only queries (`list`, `describe`, and read-only status/inspection actions). Never edit files, redirect output into workspace files, create commits, or mutate external/host state.'
