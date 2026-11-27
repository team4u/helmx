/**
 * `builtin:changes` actions (`inspect_workspace` / `inspect_workspace_file`).
 *
 * Security & honesty invariants:
 * - Never accepts arbitrary filesystem paths from clients: resolves `(nodeId, cwd)` strictly
 *   from `ctx.host.getConversation(conversationId)`.
 * - Read-only and idempotent (`idempotent: true`, `exposeToPrompt: false`).
 * - Never runs full-repo `git diff` (delegates to shared `git-diff-probe.ts`).
 */
import { HelmxError, type HelmxPluginContext, type PluginActionContext } from '@helmx/protocol'
import type { GitDiffFileResult, WorkspaceDiffScope, WorkspaceInspectResult } from '../contracts.js'
import {
  GIT_DIFF_COMMIT_ENTRY_SCHEMA,
  GIT_DIFF_FILE_ENTRY_SCHEMA,
  GIT_DIFF_FILE_RESULT_SCHEMA,
  GIT_DIFF_SUMMARY_SCHEMA,
} from '../git-diff/git-diff-schemas.js'
import { validateGitCommitSha } from '../git-diff/git-diff-parser.js'
import {
  probeGitFileDiff,
  probeGitSummary,
  probeRepoRoot,
  type GitDiffNodePorts,
} from '../git-diff/git-diff-probe.js'

const VALID_WORKSPACE_SCOPES = new Set<WorkspaceDiffScope>(['working', 'unpushed', 'commit', 'since'])

function normalizeWorkspaceScope(raw: unknown): WorkspaceDiffScope {
  if (raw === undefined) return 'working'
  if (typeof raw !== 'string' || !VALID_WORKSPACE_SCOPES.has(raw as WorkspaceDiffScope)) {
    throw new HelmxError(
      'validation_error',
      `scope must be one of working | unpushed | commit | since (received ${String(raw)})`,
      400,
    )
  }
  return raw as WorkspaceDiffScope
}

function buildDiffPorts(ctx: HelmxPluginContext): GitDiffNodePorts {
  return {
    exec: (nodeId, cwd, args, options) =>
      ctx.host.execEnv(
        {
          command: [...args],
          nodeId,
          cwd,
          ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        },
        options?.signal !== undefined ? { signal: options.signal } : undefined,
      ),
    executionEnv: (nodeId, cwd) => ctx.host.executionEnv(nodeId, cwd),
    redact: (text) => ctx.host.redact(text),
  }
}

function resolveConversationCoords(
  ctx: HelmxPluginContext,
  input: Record<string, unknown>,
  context: PluginActionContext,
): { conversationId: number; nodeId: string; cwd: string } {
  const rawConvId = input['conversationId'] !== undefined ? Number(input['conversationId']) : context.conversationId
  if (rawConvId === undefined || !Number.isSafeInteger(rawConvId) || rawConvId <= 0) {
    throw new HelmxError(
      'validation_error',
      'conversationId is required (pass a positive conversationId or invoke with --current / inside a conversation)',
      400,
    )
  }
  const conv = ctx.host.getConversation(rawConvId)
  const nodeId = conv.nodeId && conv.nodeId !== '' ? conv.nodeId : 'local'
  const cwd = conv.cwd
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    throw new HelmxError(
      'validation_error',
      `Conversation ${rawConvId} has no working directory configured`,
      400,
      { conversationId: rawConvId },
    )
  }
  return { conversationId: rawConvId, nodeId, cwd }
}

export function registerChangesActions(ctx: HelmxPluginContext): void {
  const ports = buildDiffPorts(ctx)

  ctx.action<Record<string, unknown>, WorkspaceInspectResult>({
    id: 'inspect_workspace',
    description:
      'Read-only structured Git change summary for a conversation workspace (uncommitted working tree, unpushed commits, commit history, or diff since a selected commit)',
    exposeToPrompt: false,
    idempotent: true,
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: {
          type: 'integer',
          minimum: 1,
          description: 'Conversation ID whose (nodeId, cwd) workspace will be inspected (defaults to current conversation context)',
        },
        scope: {
          type: 'string',
          enum: ['working', 'unpushed', 'commit', 'since'],
          description: 'Diff scope: working (uncommitted vs HEAD), unpushed (@{upstream}..HEAD), commit (single commit), or since (baseCommit vs working tree)',
        },
        commit: {
          type: 'string',
          description: '7-64 char commit SHA to inspect when scope is commit',
        },
        baseCommit: {
          type: 'string',
          description: '7-64 char baseline commit SHA required when scope is since',
        },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        isGitRepo: { type: 'boolean' },
        nodeId: { type: 'string' },
        cwd: { type: 'string' },
        nonGitReason: { type: 'string', enum: ['not_a_git_repo', 'bare_repository'] },
        repoRoot: { type: 'string' },
        currentBranch: { type: 'string' },
        currentHead: { type: 'string' },
        upstream: { type: 'string' },
        commitsAheadOfUpstream: { type: 'number' },
        commitsBehindUpstream: { type: 'number' },
        scope: { type: 'string', enum: ['working', 'unpushed', 'commit', 'since'] },
        diffBase: { type: 'string', enum: ['HEAD', 'upstream', 'commit', 'baseCommit'] },
        selectedCommit: { type: 'string' },
        baseCommit: { type: 'string' },
        commits: { type: 'array', items: GIT_DIFF_COMMIT_ENTRY_SCHEMA },
        commitsTruncated: { type: 'boolean' },
        summary: GIT_DIFF_SUMMARY_SCHEMA,
        files: { type: 'array', items: GIT_DIFF_FILE_ENTRY_SCHEMA },
        filesTruncated: { type: 'boolean' },
      },
      required: ['isGitRepo', 'nodeId', 'cwd'],
      additionalProperties: false,
    },
    cli: {
      command: ['changes', 'inspect'],
      description: 'Read-only Git change summary for a conversation workspace',
    },
    async handler(input, context) {
      const scope = normalizeWorkspaceScope(input['scope'])
      const commit = input['commit'] !== undefined ? validateGitCommitSha(input['commit'], 'commit') : undefined
      const baseCommit = input['baseCommit'] !== undefined ? validateGitCommitSha(input['baseCommit'], 'baseCommit') : undefined
      if (scope === 'since' && baseCommit === undefined) {
        throw new HelmxError('validation_error', 'baseCommit is required when scope is "since"', 400)
      }

      const { nodeId, cwd } = resolveConversationCoords(ctx, input, context)
      const repoProbe = await probeRepoRoot(ports, nodeId, cwd, context.signal)
      if (!repoProbe.isGitRepo) {
        return {
          isGitRepo: false,
          nodeId,
          cwd: ctx.host.redact(cwd),
          nonGitReason: repoProbe.nonGitReason,
        }
      }

      const res = await probeGitSummary(ports, {
        mode: 'workspace',
        nodeId,
        repoRoot: repoProbe.repoRoot,
        scope,
        ...(commit !== undefined ? { commit } : {}),
        ...(baseCommit !== undefined ? { baseCommit } : {}),
        signal: context.signal,
      })

      return {
        isGitRepo: true,
        nodeId,
        cwd: ctx.host.redact(cwd),
        repoRoot: ctx.host.redact(repoProbe.repoRoot),
        currentBranch: res.currentBranch,
        ...(res.currentHead !== undefined ? { currentHead: res.currentHead } : {}),
        ...(res.upstream !== undefined ? { upstream: res.upstream } : {}),
        ...(res.commitsAheadOfUpstream !== undefined ? { commitsAheadOfUpstream: res.commitsAheadOfUpstream } : {}),
        ...(res.commitsBehindUpstream !== undefined ? { commitsBehindUpstream: res.commitsBehindUpstream } : {}),
        scope,
        diffBase: res.diffBase as 'HEAD' | 'upstream' | 'commit' | 'baseCommit',
        ...(res.selectedCommit !== undefined ? { selectedCommit: res.selectedCommit } : {}),
        ...(res.baseCommit !== undefined ? { baseCommit: res.baseCommit } : {}),
        commits: res.commits,
        commitsTruncated: res.commitsTruncated,
        summary: res.summary,
        files: res.files,
        filesTruncated: res.filesTruncated,
      }
    },
  })

  ctx.action<Record<string, unknown>, GitDiffFileResult>({
    id: 'inspect_workspace_file',
    description:
      'Read-only single-file Git diff or bounded untracked file preview for a conversation workspace',
    exposeToPrompt: false,
    idempotent: true,
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: {
          type: 'integer',
          minimum: 1,
          description: 'Conversation ID whose (nodeId, cwd) workspace will be inspected (defaults to current conversation context)',
        },
        filePath: {
          type: 'string',
          minLength: 1,
          description: 'Repo-relative POSIX path of the changed or untracked file to inspect',
        },
        oldPath: {
          type: 'string',
          description: 'Optional original repo-relative path for renamed or copied files',
        },
        scope: {
          type: 'string',
          enum: ['working', 'unpushed', 'commit', 'since'],
          description: 'Diff scope matching the summary query',
        },
        commit: {
          type: 'string',
          description: '7-64 char commit SHA when scope is commit',
        },
        baseCommit: {
          type: 'string',
          description: '7-64 char baseline commit SHA required when scope is since',
        },
        contextLines: {
          type: 'integer',
          minimum: 0,
          maximum: 20,
          description: 'Unified diff context lines (0-20; defaults to 3)',
        },
      },
      required: ['filePath'],
      additionalProperties: false,
    },
    outputSchema: GIT_DIFF_FILE_RESULT_SCHEMA,
    cli: {
      command: ['changes', 'file'],
      description: 'Read-only single-file Git diff or bounded untracked preview for a conversation workspace',
    },
    async handler(input, context) {
      const scope = normalizeWorkspaceScope(input['scope'])
      const commit = input['commit'] !== undefined ? validateGitCommitSha(input['commit'], 'commit') : undefined
      const baseCommit = input['baseCommit'] !== undefined ? validateGitCommitSha(input['baseCommit'], 'baseCommit') : undefined
      if (scope === 'since' && baseCommit === undefined) {
        throw new HelmxError('validation_error', 'baseCommit is required when scope is "since"', 400)
      }

      const { nodeId, cwd } = resolveConversationCoords(ctx, input, context)
      const repoProbe = await probeRepoRoot(ports, nodeId, cwd, context.signal)
      if (!repoProbe.isGitRepo) {
        throw new HelmxError(
          'not_a_git_repo',
          `Directory '${ctx.host.redact(cwd)}' on node ${nodeId} is not a Git repository (${repoProbe.nonGitReason})`,
          400,
          { nodeId, cwd: ctx.host.redact(cwd), reason: repoProbe.nonGitReason },
        )
      }

      return probeGitFileDiff(ports, {
        mode: 'workspace',
        nodeId,
        repoRoot: repoProbe.repoRoot,
        filePath: String(input['filePath'] ?? ''),
        ...(input['oldPath'] !== undefined ? { oldPath: String(input['oldPath']) } : {}),
        scope,
        ...(commit !== undefined ? { commit } : {}),
        ...(baseCommit !== undefined ? { baseCommit } : {}),
        ...(input['contextLines'] !== undefined ? { contextLines: Number(input['contextLines']) } : {}),
        signal: context.signal,
      })
    },
  })
}
