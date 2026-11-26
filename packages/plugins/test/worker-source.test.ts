/**
 * worker-source.test.ts — Thin RPC worker protocol + single-source host validation tests.
 *
 * Covers:
 * - Thin worker wire payloads (`workflowRootPath`, `scopePath`, `scopeCallIndex`, `withMeta`, `goalMode`);
 * - Single-source option validation via `runWorkflow` (cwd, nodeId, effort incl. 'off', timeoutMs, gateTimeoutMs, maxAttempts, mutual exclusions);
 * - `agent.withMeta({ schema })` and `goal({ schema })` structured JSON parsing parity with `agent({ schema })`;
 * - `workflow()` nesting depth cap (`MAX_WORKFLOW_NESTING_DEPTH = 2`), `nestedCap`, `undefined` return support, and sibling `workflowRootPath` isolation.
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { Worker } from 'node:worker_threads'
import {
  MAX_WORKFLOW_NESTING_DEPTH,
  runWorkflow,
  WORKER_SOURCE,
  type AgentWithMetaResult,
  type WorkerAgentCallPayload,
  type WorkflowHost,
  type WorkflowSpawnRequest,
} from '../src/workflow/dsl/index.js'

const timeout = { timeout: 60_000 } as const
const META = 'export const meta = { name: "worker-test", description: "test" }\n'

interface WorkerOutcome {
  status: 'complete' | 'error'
  value?: unknown
  error?: string
  agentCalls: WorkerAgentCallPayload[]
  workflowRefs: Array<{ name?: string; scriptPath?: string }>
}

function runWorkerRaw(
  body: string,
  options: {
    args?: unknown
    nestedCap?: number
    onAgent?: (payload: WorkerAgentCallPayload) => unknown
    workflows?: Record<string, string>
  } = {},
): Promise<WorkerOutcome> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        body,
        argsJson: options.args === undefined ? undefined : JSON.stringify(options.args),
        itemCap: 4096,
        nestedCap: options.nestedCap ?? 256,
      },
    })
    const outcome: WorkerOutcome = { status: 'error', agentCalls: [], workflowRefs: [] }
    let settled = false
    const finish = (final: Partial<WorkerOutcome>): void => {
      if (settled) return
      settled = true
      Object.assign(outcome, final)
      void worker.terminate().then(() => resolve(outcome), () => resolve(outcome))
    }
    worker.on('message', (message: any) => {
      if (message.type === 'progress') return
      if (message.type === 'complete') {
        finish({
          status: 'complete',
          value: message.resultJson === undefined ? undefined : JSON.parse(message.resultJson),
        })
        return
      }
      if (message.type === 'error') {
        finish({ status: 'error', error: String(message.message) })
        return
      }
      if (message.type !== 'call') return
      if (message.method === 'agent') {
        outcome.agentCalls.push(message.payload)
        const value = options.onAgent ? options.onAgent(message.payload) : `ok:${String(message.payload.prompt)}`
        worker.postMessage({ type: 'response', callId: message.callId, ok: true, value })
        return
      }
      if (message.method === 'workflow') {
        outcome.workflowRefs.push(message.payload)
        const source = message.payload?.name !== undefined ? options.workflows?.[message.payload.name] : undefined
        if (source === undefined) {
          worker.postMessage({ type: 'response', callId: message.callId, ok: false, error: `missing '${message.payload?.name}'` })
          return
        }
        worker.postMessage({ type: 'response', callId: message.callId, ok: true, value: { name: message.payload.name, body: source } })
        return
      }
      worker.postMessage({ type: 'response', callId: message.callId, ok: false, error: `unsupported '${message.method}'` })
    })
    worker.on('error', (error) => {
      if (!settled) { settled = true; reject(error) }
    })
    worker.on('exit', (code) => {
      if (!settled) { settled = true; reject(new Error(`worker exited unexpectedly (${code})`)) }
    })
  })
}

function makeHost(
  onSpawn?: (req: WorkflowSpawnRequest) => Promise<{ ok: boolean; text?: string; error?: string }> | { ok: boolean; text?: string; error?: string },
): { host: WorkflowHost; spawns: WorkflowSpawnRequest[] } {
  const spawns: WorkflowSpawnRequest[] = []
  const host: WorkflowHost = {
    async spawnAgent(req) {
      spawns.push(req)
      if (onSpawn) return onSpawn(req)
      return { ok: true, text: `ok:${req.prompt}` }
    },
    async resumeAgent(_id, prompt) {
      return { ok: true, text: `resumed:${prompt}` }
    },
    abortAgent() {},
    async runGate() {
      return { ok: true, output: '' }
    },
    async invokeAction(actionId) {
      return { pluginId: 'test', actionId, result: null }
    },
  }
  return { host, spawns }
}

describe('thin worker RPC protocol & nesting', () => {
  it('exports MAX_WORKFLOW_NESTING_DEPTH = 2', timeout, () => {
    assert.equal(MAX_WORKFLOW_NESTING_DEPTH, 2)
  })

  it('forwards raw prompt/opts and deterministic scope coordinates', timeout, async () => {
    const outcome = await runWorkerRaw('const a = await agent("first"); const b = await agent("second"); return [a, b]')
    assert.equal(outcome.status, 'complete')
    assert.deepEqual(outcome.value, ['ok:first', 'ok:second'])
    assert.equal(outcome.agentCalls.length, 2)
    assert.equal(outcome.agentCalls[0]?.workflowRootPath, 'root')
    assert.equal(outcome.agentCalls[0]?.scopePath, 'root')
    assert.equal(outcome.agentCalls[0]?.scopeCallIndex, 0)
    assert.equal(outcome.agentCalls[1]?.scopeCallIndex, 1)
    assert.equal(outcome.agentCalls[0]?.withMeta, undefined)
  })

  it('allows 2 nested workflow levels, isolates sibling workflowRootPath, and allows returning undefined', timeout, async () => {
    const outcome = await runWorkerRaw('const u = await workflow("noop"); const d = await workflow("a"); return [u === undefined, d]', {
      workflows: {
        noop: 'const x = 1',
        a: 'return await workflow("b")',
        b: 'return await agent("deep")',
      },
    })
    assert.equal(outcome.status, 'complete')
    assert.deepEqual(outcome.value, [true, 'ok:deep'])
    assert.equal(outcome.agentCalls.length, 1)
    assert.equal(outcome.agentCalls[0]?.workflowRootPath, 'root/1/0')
    assert.equal(outcome.agentCalls[0]?.scopePath, 'root/1/0')
    assert.equal(outcome.agentCalls[0]?.scopeCallIndex, 0)
  })

  it('rejects a 3rd nesting level and enforces nestedCap', timeout, async () => {
    const tooDeep = await runWorkerRaw('return await workflow("a")', {
      workflows: { a: 'return await workflow("b")', b: 'return await workflow("c")', c: 'return 1' },
    })
    assert.equal(tooDeep.status, 'error')
    assert.match(tooDeep.error ?? '', /cannot be nested more than 2 levels deep/)

    const capped = await runWorkerRaw('await workflow("a"); await workflow("b"); return await workflow("c")', {
      nestedCap: 2,
      workflows: { a: 'return 1', b: 'return 2', c: 'return 3' },
    })
    assert.equal(capped.status, 'error')
    assert.match(capped.error ?? '', /exceeded its cap of 2 nested workflow\(\) calls/)
  })

  it('single DETERMINISM_PRELUDE wrap does not fail on nested workflows', timeout, async () => {
    const outcome = await runWorkerRaw('return await workflow("a")', {
      workflows: { a: 'return typeof Math.random === "function" && typeof Date.now === "function"' },
    })
    assert.equal(outcome.status, 'complete')
    assert.equal(outcome.value, true)
  })
})

describe('single-source host option validation & withMeta/goal schema parsing', () => {
  it('forwards cwd, nodeId, effort (including off), timeoutMs, gateTimeoutMs, maxAttempts', timeout, async () => {
    const { host, spawns } = makeHost()
    const res = await runWorkflow({
      script:
        META +
        'await agent("work", { cwd: "/repo/a", nodeId: "gpu-1.us_west", effort: "off", isolation: "worktree", timeoutMs: 300000, gate: "pnpm test", gateTimeoutMs: 60000, maxAttempts: 3 })',
      host,
    })
    assert.equal(res.status, 'completed', res.error)
    assert.equal(spawns[0]?.cwd, '/repo/a')
    assert.equal(spawns[0]?.nodeId, 'gpu-1.us_west')
    assert.equal(spawns[0]?.effort, 'off')
    assert.equal(spawns[0]?.isolation, 'worktree')
    assert.equal(spawns[0]?.timeoutMs, 300000)
    assert.equal(spawns[0]?.gateTimeoutMs, 60000)
  })

  it('rejects unknown keys, blank cwd, bad nodeId, bad ranges, and resume mutual exclusions', timeout, async () => {
    const { host } = makeHost()
    const cases: Array<[string, RegExp]> = [
      ['await agent("hi", { nope: 1 })', /opts\.nope is not a recognised option/],
      ['await agent("fix", { resume: "impl", cwd: "/repo" })', /opts\.resume and opts\.cwd are mutually exclusive/],
      ['await agent("fix", { resume: "impl", nodeId: "gpu-1" })', /opts\.resume and opts\.nodeId are mutually exclusive/],
      ['await agent("x", { cwd: "  " })', /opts\.cwd requires a non-empty string/],
      ['await agent("x", { nodeId: "_bad" })', /opts\.nodeId/],
      ['await agent("x", { timeoutMs: 999 })', /opts\.timeoutMs must be an integer between 1000 and 3600000/],
      ['await agent("x", { gateTimeoutMs: 60000 })', /opts\.gateTimeoutMs requires opts\.gate/],
      ['await agent("x", { gate: "true", gateTimeoutMs: 999 })', /opts\.gateTimeoutMs must be an integer between 1000 and 600000/],
      ['await agent("x", { maxAttempts: 11 })', /opts\.maxAttempts must be an integer between 1 and 10/],
      ['await goal("ship it")', /goal\(spec\) expects an options object/],
      ['await goal({ label: "x" })', /goal\(\) spec\.objective requires a non-empty string/],
      ['await goal({ objective: "o", wish: 1 })', /goal\(\) spec\.wish is not a recognised option/],
    ]
    for (const [body, pattern] of cases) {
      const res = await runWorkflow({ script: META + body, host })
      assert.equal(res.status, 'failed', `expected failure for: ${body}`)
      assert.match(res.error ?? '', pattern, `unexpected error for ${body}: ${res.error}`)
    }
  })

  it('agent.withMeta({ schema }) and goal({ schema }) parse validated JSON into objects', timeout, async () => {
    const { host } = makeHost(async () => ({ ok: true, text: '{"done":true,"count":3}' }))
    const res = await runWorkflow({
      script:
        META +
        'const a = await agent.withMeta("q", { schema: { type: "object", required: ["done"] } })\n' +
        'const b = await goal({ objective: "q", schema: { type: "object", required: ["count"] }, maxAttempts: 1 })\n' +
        'return { a, b }',
      host,
    })
    assert.equal(res.status, 'completed', res.error)
    const val = res.value as { a: AgentWithMetaResult; b: AgentWithMetaResult }
    assert.equal(val.a.ok, true)
    assert.deepEqual(val.a.output, { done: true, count: 3 })
    assert.equal(val.b.ok, true)
    assert.deepEqual(val.b.output, { done: true, count: 3 })
  })

  it('aligns worker boundary errors on invalid opts/actions & redacts terminal agent and action failures', timeout, async () => {
    const boundaryRes = await runWorkerRaw('await agent("x", { fn: () => {} }); return 1')
    assert.equal(boundaryRes.status, 'error')
    assert.match(boundaryRes.error ?? '', /Cannot pass a function across the workflow VM boundary \(at agent\(\) opts\.fn\)/)

    const { host } = makeHost(async () => ({ ok: false, error: 'agent boom TOP_SECRET_KEY' }))
    host.prepareAction = async (actionId) => {
      if (actionId === 'prep-fail') throw new Error('prepare failed TOP_SECRET_KEY')
      return { pluginId: 'p', actionId, idempotent: true }
    }
    host.invokeAction = async () => {
      throw new Error('invoke failed TOP_SECRET_KEY')
    }

    const journalEntries: unknown[] = []
    const res = await runWorkflow({
      script:
        META +
        'const a = await agent.withMeta("work");\n' +
        'await action("prep-fail", {});\n' +
        'await action("run-fail", {});\n' +
        'return a',
      host,
      redact: (text) => text.replaceAll('TOP_SECRET_KEY', '[REDACTED]'),
      journal: {
        entries: [],
        append: async (entry) => {
          journalEntries.push(entry)
        },
      },
    })
    assert.equal(res.status, 'completed', res.error)
    const metaOut = res.value as AgentWithMetaResult
    assert.equal(metaOut.ok, false)
    assert.equal(metaOut.error, 'agent boom [REDACTED]')
    assert.equal(res.nodes[0]?.error, 'agent boom [REDACTED]')
    assert.equal(res.nodes[1]?.error, 'prepare failed [REDACTED]')
    assert.equal(res.nodes[2]?.error, 'invoke failed [REDACTED]')
    assert.equal(JSON.stringify(res).includes('TOP_SECRET_KEY'), false)
    assert.equal(JSON.stringify(journalEntries).includes('TOP_SECRET_KEY'), false)
  })
})
