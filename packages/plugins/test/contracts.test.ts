/**
 * 内置插件共享契约（@helmx/plugins contracts.ts）边界校验测试：
 * - extractWorktreeExecutionMeta：worktree 业务形状（绝对路径 / 非空分支 /
 *   可选登记字段、未知键拒绝、克隆）与 envelope 复验；
 * - worktreeExecutionMeta：合并语义（保留其他命名空间与防御性克隆/校验）；
 * - parseWorkflowSpawnMeta / withWorkflowSpawnMeta：spawn meta 业务值
 *   schema 校验与合并写入。
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { HelmxError, type AgentExecutionInfo } from '@helmx/protocol'
import {
  extractWorktreeExecutionMeta,
  parseWorkflowSpawnMeta,
  worktreeExecutionMeta,
  withWorkflowSpawnMeta,
  WORKFLOW_META_NAMESPACE,
  WORKTREE_META_NAMESPACE,
} from '../src/contracts.js'

const timeout = { timeout: 60_000 } as const

describe('extractWorktreeExecutionMeta（worktree 命名空间业务形状）', () => {
  it('合法 worktree 通过并深克隆；缺失命名空间返回空对象', timeout, () => {
    assert.deepEqual(extractWorktreeExecutionMeta({ conversationId: 5 }), {})
    assert.deepEqual(extractWorktreeExecutionMeta({}), {})
    const ok = extractWorktreeExecutionMeta({
      nodeId: 'local',
      executionId: 'e',
      meta: {
        [WORKTREE_META_NAMESPACE]: {
          worktree: {
            path: '/wt',
            branch: 'b',
            id: 'local:/wt',
            repoRoot: '/repo',
            baseCommit: 'c1',
            baseBranch: 'helmx/spawn-12ab34cd',
            parentWorktreeId: 'local:/repo/../.helmx-worktrees/repo-12ab34cd',
            dirtySource: true,
          },
        },
      },
    })
    assert.deepEqual(ok.worktree, {
      path: '/wt',
      branch: 'b',
      id: 'local:/wt',
      repoRoot: '/repo',
      baseCommit: 'c1',
      baseBranch: 'helmx/spawn-12ab34cd',
      parentWorktreeId: 'local:/repo/../.helmx-worktrees/repo-12ab34cd',
      dirtySource: true,
    })
    // 与其他命名空间正交
    const both = extractWorktreeExecutionMeta({
      nodeId: 'local',
      executionId: 'e',
      meta: {
        'other-plugin': { key: 'val' },
        [WORKTREE_META_NAMESPACE]: { worktree: { path: '/wt2', branch: 'b2' } },
      },
    })
    assert.deepEqual(both.worktree, { path: '/wt2', branch: 'b2' })
  })

  it('坏 worktree 形状与未知字段拒绝', timeout, () => {
    const bad = (slot: unknown) =>
      assert.throws(
        () => extractWorktreeExecutionMeta({ nodeId: 'local', executionId: 'e', meta: { [WORKTREE_META_NAMESPACE]: slot } as never }),
        (error: unknown) => error instanceof HelmxError,
      )
    bad({ worktree: null })
    bad({ worktree: [] })
    bad({ worktree: { path: 'rel/path', branch: 'b' } })
    bad({ worktree: { path: '/wt', branch: '' } })
    bad({ worktree: { path: '/wt', branch: 'b', repoRoot: 'rel' } })
    bad({ worktree: { path: '/wt', branch: 'b', dirtySource: 'yes' } })
    bad({ worktree: { path: '/wt', branch: 'b', baseBranch: '' } })
    bad({ worktree: { path: '/wt', branch: 'b', baseBranch: 7 } })
    bad({ worktree: { path: '/wt', branch: 'b', parentWorktreeId: '' } })
    bad({ worktree: { path: '/wt', branch: 'b', parentWorktreeId: false } })
    bad({ worktree: { path: '/wt', branch: 'b' }, lease: 'x' })
  })

  it('envelope 复验：坏 JSON-safe meta 在业务消费前显式拒绝', timeout, () => {
    assert.throws(
      () =>
        extractWorktreeExecutionMeta({
          nodeId: 'local',
          executionId: 'e',
          meta: { [WORKTREE_META_NAMESPACE]: { worktree: { path: '/wt', branch: 'b' }, fn: () => 1 } } as never,
        }),
      (error: unknown) => error instanceof HelmxError && error.code === 'meta_invalid',
    )
  })
})

describe('worktreeExecutionMeta（合并语义）', () => {
  it('合并保留其他命名空间，防御性克隆并拒绝坏基底', timeout, () => {
    const existing = { 'other-plugin': { keep: [1, { a: 'b' }] } }
    const merged = worktreeExecutionMeta({ worktree: { path: '/wt', branch: 'helmx/wf-1', id: 'local:/wt' } }, existing)
    assert.deepEqual(merged['other-plugin'], { keep: [1, { a: 'b' }] })
    assert.deepEqual(
      merged[WORKTREE_META_NAMESPACE],
      { worktree: { path: '/wt', branch: 'helmx/wf-1', id: 'local:/wt' } },
    )
    const info: AgentExecutionInfo = { nodeId: 'local', executionId: 'e', meta: merged }
    assert.equal(extractWorktreeExecutionMeta(info).worktree?.id, 'local:/wt')

    const mutable = { 'other-plugin': { v: 1 } } as Record<string, { v: number }>
    const cloned = worktreeExecutionMeta({ worktree: { path: '/wt', branch: 'b' } }, mutable)
    mutable['other-plugin']!['v'] = 2
    assert.deepEqual(cloned['other-plugin'], { v: 1 })
    assert.throws(
      () => worktreeExecutionMeta({ worktree: { path: '/wt', branch: 'b' } }, { bad: { fn: () => 1 } } as never),
      (error: unknown) => error instanceof HelmxError && error.code === 'meta_invalid',
    )
    const wtMeta = worktreeExecutionMeta({ worktree: { path: '/wt', branch: 'b' } })
    assert.deepEqual(Object.keys(wtMeta), [WORKTREE_META_NAMESPACE])
  })
})

describe('parseWorkflowSpawnMeta / withWorkflowSpawnMeta（spawn meta 业务值）', () => {
  it('缺失命名空间返回空对象；合法值通过', timeout, () => {
    assert.deepEqual(parseWorkflowSpawnMeta(undefined), {})
    assert.deepEqual(parseWorkflowSpawnMeta({}), {})
    assert.deepEqual(parseWorkflowSpawnMeta({ [WORKFLOW_META_NAMESPACE]: {} }), {})
    assert.deepEqual(
      parseWorkflowSpawnMeta({ [WORKFLOW_META_NAMESPACE]: { runId: 'r1', maxSubagentDepth: 3 } }),
      { runId: 'r1', maxSubagentDepth: 3 },
    )
  })

  it('非法业务值显式拒绝（未知字段 / 越界深度 / 空 runId）', timeout, () => {
    const bad = (slot: unknown) =>
      assert.throws(
        () => parseWorkflowSpawnMeta({ [WORKFLOW_META_NAMESPACE]: slot } as never),
        (error: unknown) => error instanceof HelmxError && error.code === 'validation_error',
      )
    bad({ unknown: 1 })
    bad({ runId: '' })
    bad({ maxSubagentDepth: 0 })
    bad({ maxSubagentDepth: 6 })
    bad({ maxSubagentDepth: 2.5 })
  })

  it('withWorkflowSpawnMeta 合并保留其他命名空间与既有业务键；undefined 键不写入', timeout, () => {
    const base = { 'other-plugin': { a: 1 }, [WORKFLOW_META_NAMESPACE]: { runId: 'r1' } }
    const merged = withWorkflowSpawnMeta(base, { maxSubagentDepth: 3 })
    assert.deepEqual(merged, { 'other-plugin': { a: 1 }, [WORKFLOW_META_NAMESPACE]: { runId: 'r1', maxSubagentDepth: 3 } })
    assert.deepEqual(withWorkflowSpawnMeta(undefined, { runId: 'x' }), { [WORKFLOW_META_NAMESPACE]: { runId: 'x' } })
    // undefined 值不写入（不改写既有 runId）。
    const untouched = withWorkflowSpawnMeta(base, { runId: undefined })
    assert.deepEqual(untouched[WORKFLOW_META_NAMESPACE], { runId: 'r1' })
  })
})
