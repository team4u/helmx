/**
 * Shared JSON Schemas for git-diff summary and file inspection action contracts
 * (shared by `builtin:worktree` and `builtin:changes`; English machine descriptions only).
 */
import type { JsonSchema } from '@helmx/protocol'

export const GIT_DIFF_FILE_ENTRY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    oldPath: { type: 'string' },
    status: { type: 'string', enum: ['M', 'A', 'D', 'R', 'C', 'U'] },
    additions: { type: 'number' },
    deletions: { type: 'number' },
    binary: { type: 'boolean' },
    untracked: { type: 'boolean' },
  },
  required: ['path', 'status', 'additions', 'deletions', 'binary', 'untracked'],
  additionalProperties: false,
}

export const GIT_DIFF_COMMIT_ENTRY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    oid: { type: 'string' },
    shortOid: { type: 'string' },
    subject: { type: 'string' },
    author: { type: 'string' },
    committedAt: { type: 'number' },
    unpushed: { type: 'boolean' },
  },
  required: ['oid', 'shortOid', 'subject', 'author', 'committedAt'],
  additionalProperties: false,
}

export const GIT_DIFF_SUMMARY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    totalFiles: { type: 'number' },
    additions: { type: 'number' },
    deletions: { type: 'number' },
    untrackedCount: { type: 'number' },
    dirtyFileCount: { type: 'number' },
  },
  required: ['totalFiles', 'additions', 'deletions', 'untrackedCount', 'dirtyFileCount'],
  additionalProperties: false,
}

export const GIT_DIFF_HUNK_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    oldStart: { type: 'number' },
    oldLines: { type: 'number' },
    newStart: { type: 'number' },
    newLines: { type: 'number' },
    header: { type: 'string' },
    rows: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['add', 'remove', 'context'] },
          oldLine: { type: 'number' },
          newLine: { type: 'number' },
          text: { type: 'string' },
        },
        required: ['kind', 'text'],
        additionalProperties: false,
      },
    },
  },
  required: ['oldStart', 'oldLines', 'newStart', 'newLines', 'header', 'rows'],
  additionalProperties: false,
}

export const GIT_DIFF_FILE_RESULT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['diff', 'untracked', 'binary', 'too_large', 'special_file', 'unchanged', 'absent'] },
    filePath: { type: 'string' },
    oldPath: { type: 'string' },
    status: { type: 'string', enum: ['M', 'A', 'D', 'R', 'C', 'U'] },
    additions: { type: 'number' },
    deletions: { type: 'number' },
    hunks: { type: 'array', items: GIT_DIFF_HUNK_SCHEMA },
    reason: { type: 'string', enum: ['line_budget_exceeded', 'byte_limit_exceeded'] },
    size: { type: 'number' },
    fileKind: { type: 'string' },
  },
  required: ['kind', 'filePath'],
  additionalProperties: false,
}
