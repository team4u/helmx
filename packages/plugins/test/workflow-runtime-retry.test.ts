/**
 * workflow-runtime-retry.test.ts — runtime 失败句柄登记、scopeId 命名空间与
 * gate 结果扩展（exitCode/timedOut）回归。
 *
 * 覆盖《20261115-多级工作流与失败自动重试设计文档》§2.3 / §4.1 的 runtime 侧：
 * ① 失败调用只要拿到 conversationId/executionId（onResolved 回报或失败分支
 *   executionInfo 回传）即登记 resume 句柄——同 run 内后续
 *   agent({ resume: label }) 经 host.resumeAgent 续接同一子会话，不再 fatal；
 * ② 失败且无任何执行环境元数据时不登记（旧语义：失败不等于可续接）；
 * ③ 手动 control.retry 复用同一 attempt 环重跑（maxAttempts 自动触发依赖
 *   worker 侧载荷接线，由后续套件覆盖；此处锁定环本身不回归）；
 * ④ WorkflowGateResult.exitCode/timedOut 透传：宿主回报与 runGate fallback
 *   两条路径的失败文案都携带结构化原因。
 *
 * 全部用真实 runWorkflow（真 worker_threads）+ 可控 fake host。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import type { WorkflowNodeState } from '../src/contracts.js'
import {
  agentJournalKey,
  agentRetryPrompt,
  MAX_AGENT_ATTEMPTS,
  runWorkflow,
  scopedResumeKey,
  ScriptCallOptionError,
  validateAgentCallOptions,
  type WorkflowHost,
} from '../src/workflow/dsl/index.js'

const timeout = { timeout: 60_000 } as const

const META = (name: string) => `export const meta = { name: "${name}", description: "test" }\n`

function baseHost(overrides: Partial<WorkflowHost> = {}): WorkflowHost {
  return {
    async spawnAgent() {
      return { ok: true, text: 'ok' }
    },
    abortAgent() {},
    async invokeAction(actionId) {
      return { pluginId: 'p', actionId, result: null }
    },
    loadWorkflow() {
      return { ok: false, message: 'no nested workflows in retry host' }
    },
    ...overrides,
  }
}

function agentEntriesOf(nodes: readonly WorkflowNodeState[]): WorkflowNodeState[] {
  return nodes.filter((e) => e.kind === 'agent')
}

// ---------------------------------------------------------------------------
// ① 失败句柄登记：拿到执行环境即可 resume
// ---------------------------------------------------------------------------

describe('workflow runtime failure handle registration', () => {
  it('registers a resume handle when a failed attempt observed conversationId/executionId via onResolved', timeout, async () => {
    const calls: string[] = []
    const host = baseHost({
      async spawnAgent(request) {
        calls.push(`spawn:${request.agentId}:${request.prompt}`)
        request.onResolved?.({ conversationId: 42, executionId: 'exec-9' })
        return { ok: false, error: '[agent_timeout] turn timed out' }
      },
    })
    host.resumeAgent = async (agentId, prompt) => {
      calls.push(`resume:${agentId}:${prompt}`)
      return { ok: true, text: `fixed:${prompt}` }
    }
    const result = await runWorkflow({
      script:
        META('failure-handle') +
        'const first = await agent("build it", { label: "unit" })\n' +
        'const second = await agent("fix the failure", { resume: "unit" })\n' +
        'return [first, second]',
      host,
    })
    assert.equal(result.status, 'completed')
    assert.deepEqual(result.value, [null, 'fixed:fix the failure'])
    // 续接的是同一 agentId（同一子会话），不是重新 spawn。
    assert.deepEqual(calls, ['spawn:wf-agent-0:build it', 'resume:wf-agent-0:fix the failure'])
    const errorEntry = agentEntriesOf(result.nodes).find((e) => e.status === 'failed')
    assert.ok(errorEntry, 'failed attempt still records a failed node')
    assert.equal(errorEntry.conversationId, 42)
    assert.equal(errorEntry.executionId, 'exec-9')
  })

  it('registers a resume handle from executionInfo returned on the failure branch', timeout, async () => {
    // §2.3.1：service 失败分支把 executionInfo 放进失败结果回传（不丢弃
    // conversationId）。runtime 必须在失败分支吸收它并登记句柄。
    const host = baseHost({
      async spawnAgent() {
        return {
          ok: false,
          error: 'schema validation failed',
          executionInfo: { conversationId: 99 },
        }
      },
    })
    host.resumeAgent = async () => ({ ok: true, text: 'recovered' })
    const result = await runWorkflow({
      script:
        META('failure-exec-info') +
        'await agent("make json", { label: "j" })\n' +
        'return await agent("repair it", { resume: "j" })',
      host,
    })
    assert.equal(result.status, 'completed')
    assert.equal(result.value, 'recovered')
  })

  it('does not register a handle when the failure carries no execution metadata (old semantics)', timeout, async () => {
    const host = baseHost({
      async spawnAgent() {
        return { ok: false, error: 'boom' }
      },
    })
    // 提供 resumeAgent 能力，确保 fatal 来自“label 未登记”而非宿主能力缺失。
    host.resumeAgent = async () => ({ ok: true, text: 'never' })
    const result = await runWorkflow({
      script:
        META('failure-no-handle') +
        'await agent("x", { label: "solo" })\n' +
        'await agent("y", { resume: "solo" })',
      host,
    })
    assert.equal(result.status, 'failed')
    assert.ok(
      result.error!.includes('no agent has completed under the label "solo"'),
      `unexpected error: ${result.error}`,
    )
  })
})

// ---------------------------------------------------------------------------
// ③ 自动重试尝试级账本与跨重启恢复
// ---------------------------------------------------------------------------

describe('workflow runtime attempt journal replay', () => {
  it('journals each attempt and resumes from a persisted conversation handle', timeout, async () => {
    const writes: Array<Record<string, unknown>> = []
    const calls: string[] = []
    const host = baseHost({
      async spawnAgent(request) {
        calls.push(`spawn:${request.index}`)
        request.onResolved?.({ conversationId: 77 })
        return { ok: false, error: 'gate failed' }
      },
      async resumeAgent(agentId, prompt, options) {
        calls.push(`resume:${agentId}:${options?.resumeRef ?? 'mapped'}:${prompt.includes('[attempt 1 failed]')}`)
        return { ok: true, text: 'fixed' }
      },
    })
    const first = await runWorkflow({
      script: META('attempt-journal') + 'return await agent.withMeta("job", { label: "worker", maxAttempts: 2 })',
      host,
      journal: { append(entry) { writes.push({ ...entry }) } },
    })
    assert.equal(first.status, 'completed', first.error)
    assert.deepEqual(first.value, { ok: true, output: 'fixed', attempts: 2, execution: { conversationId: 77 } })
    assert.deepEqual(calls, ['spawn:0', 'resume:wf-agent-0:77:true'])
    assert.equal(writes.length, 2)
    assert.equal(writes[0]!.type, 'agent')
    assert.equal(writes[0]!.ok, false)
    assert.equal(writes[0]!.attempt, 1)
    assert.equal(writes[0]!.index, 0)
    assert.equal(writes[1]!.ok, true)
    assert.equal(writes[1]!.attempt, 2)
    assert.equal(writes[1]!.index, 1)

    const replayCalls: string[] = []
    const replayWrites: Array<Record<string, unknown>> = []
    const replayHost = baseHost({
      async spawnAgent() {
        replayCalls.push('spawn')
        throw new Error('replay must not spawn')
      },
      async resumeAgent(agentId, _prompt, options) {
        replayCalls.push(`resume:${agentId}:${options?.resumeRef ?? 'missing'}`)
        throw new Error('completed attempt must be reused')
      },
    })
    const resumed = await runWorkflow({
      script: META('attempt-journal') + 'return await agent.withMeta("job", { label: "worker", maxAttempts: 2 })',
      host: replayHost,
      journal: {
        entries: writes as never,
        append(entry) { replayWrites.push({ ...entry }) },
      },
    })
    assert.equal(resumed.status, 'completed')
    assert.deepEqual(resumed.value, { ok: true, output: 'fixed', attempts: 2, execution: { conversationId: 77 } }, JSON.stringify({ writes, replayCalls, replayWrites, nodes: resumed.nodes, error: resumed.error }))
    assert.deepEqual(replayCalls, [])
    assert.deepEqual(replayWrites.map((entry) => [entry.index, entry.attempt, entry.ok]), [[0, 1, false], [1, 2, true]])
  })
})

// ---------------------------------------------------------------------------
// ④ gate 结果扩展：exitCode / timedOut
// ---------------------------------------------------------------------------

describe('workflow gate result exitCode/timedOut', () => {
  it('host-reported gate failure mentions the exit code and is not re-run', timeout, async () => {
    const host = baseHost({
      async spawnAgent() {
        return { ok: true, text: 't', gate: { ok: false, output: '', exitCode: 2, timedOut: false } }
      },
    })
    let gateRuns = 0
    host.runGate = async () => {
      gateRuns++
      return { ok: true, output: '' }
    }
    const result = await runWorkflow({
      script: META('gate-exit') + 'const v = await agent("g", { gate: "exit 2" })\nreturn v',
      host,
    })
    assert.equal(result.status, 'completed')
    assert.equal(result.value, null)
    assert.equal(gateRuns, 0, 'host-reported gate must not be re-run by the fallback')
    const errorEntry = agentEntriesOf(result.nodes).find((e) => e.status === 'failed')
    assert.ok(errorEntry)
    assert.ok(
      errorEntry.error!.includes('exit code 2'),
      `error mentions exit code: ${errorEntry.error}`,
    )
    const gate = errorEntry.gate as { ok: boolean; output: string; exitCode?: number | null; timedOut?: boolean } | undefined
    assert.ok(gate)
    assert.equal(gate.exitCode, 2)
    assert.equal(gate.timedOut, false)
  })

  it('runGate fallback timeout failure reports a timeout reason', timeout, async () => {
    const host = baseHost()
    host.runGate = async () => ({ ok: false, output: '', exitCode: null, timedOut: true })
    const result = await runWorkflow({
      script: META('gate-timeout') + 'const v = await agent("g2", { gate: "sleep 999" })\nreturn v',
      host,
    })
    assert.equal(result.status, 'completed')
    assert.equal(result.value, null)
    const errorEntry = agentEntriesOf(result.nodes).find((e) => e.status === 'failed')
    assert.ok(errorEntry)
    assert.ok(
      errorEntry.error!.includes('timed out'),
      `error mentions timeout: ${errorEntry.error}`,
    )
  })
})

describe('scoped resume keys and retry prompt helpers', () => {
  it('namespaces labels by workflowRootPath', timeout, () => {
    assert.equal(scopedResumeKey('root', 'a'), 'root:a')
    assert.equal(scopedResumeKey('root/w0', 'a'), 'root/w0:a')
    assert.notEqual(scopedResumeKey('root/w0', 'a'), scopedResumeKey('root/w1', 'a'))
  })

  it('appends an incremental failure block to the original prompt', timeout, () => {
    const prompt = agentRetryPrompt('do the task', 1, 'gate failed')
    assert.ok(prompt.startsWith('do the task\n\n[attempt 1 failed]\ngate failed\n'))
    assert.ok(prompt.endsWith('Fix the problem above and complete the original task.'))
    assert.equal(MAX_AGENT_ATTEMPTS, 10)
  })
})

describe('workflow runtime dynamic nodeId pass-through, replay key & host-boundary validation', () => {
  it('forwards nodeId across agent(), agent.withMeta(), and goal(), and distinguishes replay keys by nodeId', timeout, async () => {
    const seen: Array<{ prompt: string; nodeId?: string; cwd?: string }> = []
    const writes: Array<Record<string, unknown>> = []
    const host = baseHost({
      async spawnAgent(request) {
        seen.push({ prompt: request.prompt, nodeId: request.nodeId, cwd: request.cwd })
        request.onResolved?.({ nodeId: request.nodeId ?? 'local', conversationId: seen.length + 10 })
        return { ok: true, text: `ran:${request.nodeId ?? 'default'}:${request.prompt}` }
      },
    })

    const script =
      META('dyn-node-dsl') +
      'const a = await agent("step1", { label: "s1", nodeId: "gpu-1", cwd: "/srv/repo" })\n' +
      'const b = await agent.withMeta("step2", { label: "s2", nodeId: "local" })\n' +
      'const c = await goal({ objective: "step3", label: "s3", nodeId: "win-build", cwd: "C:\\\\repo", maxAttempts: 1 })\n' +
      'return { a, b, c }'

    const first = await runWorkflow({
      script,
      host,
      journal: {
        append(entry) {
          writes.push({ ...entry })
        },
      },
    })
    assert.equal(first.status, 'completed', first.error)
    assert.deepEqual(seen, [
      { prompt: 'step1', nodeId: 'gpu-1', cwd: '/srv/repo' },
      { prompt: 'step2', nodeId: 'local', cwd: undefined },
      { prompt: 'step3', nodeId: 'win-build', cwd: 'C:\\repo' },
    ])
    const val = first.value as { a: string; b: { ok: boolean; execution?: { nodeId?: string } }; c: { ok: boolean; execution?: { nodeId?: string } } }
    assert.equal(val.a, 'ran:gpu-1:step1')
    assert.equal(val.b.execution?.nodeId, 'local')
    assert.equal(val.c.execution?.nodeId, 'win-build')

    // 相同 nodeId 重放：全部命中缓存（0 次 spawn）
    const replaySameSeen: string[] = []
    const replaySame = await runWorkflow({
      script,
      host: baseHost({
        async spawnAgent(request) {
          replaySameSeen.push(request.prompt)
          return { ok: true, text: 'should-not-run' }
        },
      }),
      journal: { entries: writes as never },
    })
    assert.equal(replaySame.status, 'completed', replaySame.error)
    assert.deepEqual(replaySameSeen, [])
    assert.equal(replaySame.replayedCount, 3)

    // 修改 step1 的 nodeId：v4 指纹必须失配并重新执行，不得复用旧节点缓存
    const changedScript = script.replace('nodeId: "gpu-1"', 'nodeId: "gpu-2"')
    const replayDiffSeen: Array<{ prompt: string; nodeId?: string }> = []
    const replayDiff = await runWorkflow({
      script: changedScript,
      host: baseHost({
        async spawnAgent(request) {
          replayDiffSeen.push({ prompt: request.prompt, nodeId: request.nodeId })
          return { ok: true, text: `rerun:${request.nodeId}` }
        },
      }),
      journal: { entries: writes as never },
    })
    assert.equal(replayDiff.status, 'completed', replayDiff.error)
    assert.equal(replayDiff.replayedCount, 0)
    assert.equal(replayDiffSeen[0]?.nodeId, 'gpu-2')
  })

  it('host boundary rejects invalid nodeId and resume + nodeId', timeout, () => {
    assert.throws(() => validateAgentCallOptions('hi', { nodeId: '_bad/node' }), /opts\.nodeId/)
    assert.throws(() => validateAgentCallOptions('hi', { nodeId: 123 }), /opts\.nodeId/)
    assert.throws(
      () => validateAgentCallOptions('hi', { resume: 'prev', nodeId: 'gpu-1' }),
      /opts\.resume and opts\.nodeId are mutually exclusive/,
    )
  })

  it('host boundary rejects invalid agentType (tier/*, @prefix) while allowing Profile ID and <ns>:<kind> external runtime', timeout, async () => {
    assert.throws(
      () => validateAgentCallOptions('hi', { agentType: 'tier/reviewer' }),
      (err: unknown) =>
        err instanceof ScriptCallOptionError &&
        err.message.includes('agent() opts.agentType') &&
        err.message.includes('tier/reviewer') &&
        err.message.includes('model'),
    )
    assert.throws(
      () => validateAgentCallOptions(undefined, { objective: 'hi', agentType: 'tier/reviewer' }, true),
      (err: unknown) =>
        err instanceof ScriptCallOptionError &&
        err.message.includes('agent() opts.agentType') &&
        err.message.includes('tier/reviewer') &&
        err.message.includes('model'),
    )
    assert.throws(
      () => validateAgentCallOptions('hi', { agentType: '@lx' }),
      (err: unknown) =>
        err instanceof ScriptCallOptionError &&
        err.message.includes('agent() opts.agentType') &&
        err.message.includes("'lx'"),
    )
    assert.equal(validateAgentCallOptions('hi', { agentType: 'herdr:agy' }).agentType, 'herdr:agy')
    assert.equal(validateAgentCallOptions('hi', { agentType: 'assistant' }).agentType, 'assistant')

    // End-to-end DSL script runtime boundary: agent() and goal() reject tier/reviewer with model guidance.
    const seen: Array<string | undefined> = []
    const host = baseHost({
      async spawnAgent(request) {
        seen.push(request.agentType)
        return { ok: true, text: `ok:${request.agentType ?? 'default'}` }
      },
    })
    const badAgent = await runWorkflow({
      script: META('bad-agent-type') + 'return await agent("review", { agentType: "tier/reviewer" })',
      host,
    })
    assert.equal(badAgent.status, 'failed')
    assert.match(badAgent.error ?? '', /opts\.agentType.*tier\/reviewer.*model/s)

    const badGoal = await runWorkflow({
      script: META('bad-goal-agent-type') + 'return await goal({ objective: "review", agentType: "tier/reviewer" })',
      host,
    })
    assert.equal(badGoal.status, 'failed')
    assert.match(badGoal.error ?? '', /opts\.agentType.*tier\/reviewer.*model/s)
    assert.deepEqual(seen, [])
  })

  it('in-place reattach omits nodeId for native conversationId', timeout, async () => {
    const seen: Array<{ prompt: string; nodeId?: string; reattach?: unknown }> = []
    const host = baseHost({
      async spawnAgent(request) {
        seen.push({ prompt: request.prompt, nodeId: request.nodeId, reattach: request.reattach })
        request.onResolved?.({
          nodeId: request.nodeId ?? 'gpu-2',
          ...(request.reattach?.conversationId !== undefined ? { conversationId: request.reattach.conversationId } : {}),
        })
        return { ok: true, text: `reattached:${request.prompt}` }
      },
    })

    const nativeKey = agentJournalKey({ prompt: 'native-step', label: 'nat', nodeId: 'gpu-2', cwd: '/srv/work' })
    const script =
      META('reattach-nodeid') +
      'const b = await agent("native-step", { label: "nat", nodeId: "gpu-2", cwd: "/srv/work" })\n' +
      'return [b]'

    const res = await runWorkflow({
      runId: 'wf_reattach_node',
      script,
      host,
      journal: {
        inPlaceResume: true,
        entries: [
          {
            v: 1,
            seq: 0,
            type: 'agent_started',
            index: 0,
            key: nativeKey,
            attempt: 1,
            scopePath: 'root',
            scopeCallIndex: 0,
            requestId: 'helmx:spawn:wf_reattach_node:root:0:1',
            execution: { nodeId: 'gpu-2', conversationId: 42, effectiveCwd: '/srv/work' },
          },
        ],
      },
    })

    assert.equal(res.status, 'completed', res.error)
    assert.deepEqual(res.value, ['reattached:native-step'])
    assert.equal(seen.length, 1)
    assert.deepEqual(seen[0], {
      prompt: 'native-step',
      nodeId: undefined,
      reattach: { conversationId: 42, effectiveCwd: '/srv/work' },
    })
  })
})
