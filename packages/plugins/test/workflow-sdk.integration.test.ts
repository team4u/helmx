/**
 * 工作流引擎真 SDK 组合层集成测试（faux provider + KernelRuntime / createHelmx）：
 * - 默认 agentType 走 assistant profile 端到端派生；
 * - 真实 env.exec 子进程在脚本提前返回与抛错时立即中止，绝不泄漏延时副作用；
 * - 真实 KernelRuntime 内 env.exec 零 token 消耗直接执行命令。
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { HelmxError } from '@helmx/protocol'
import { createPluginBuildProvider } from '@helmx/plugin-build'
import { waitFor } from '@helmx/test-kit'
import { KernelRuntime } from '@helmx/kernel'
import { createHelmx } from '../../hub/src/app.js'
import { createMemoryKvStore, WorkflowService } from '../src/workflow/runs/index.js'
import { makeFauxProvider } from './helpers/plugin-test-env.js'

const timeout = { timeout: 60_000 } as const
const META = (name: string) => `export const meta = { name: "${name}", description: "test" }\n`

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

describe('workflow real-SDK integration (faux provider)', () => {
  it('agent() without explicit agentType spawns via default assistant profile end to end', timeout, async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'wf-sdk-'))
    const faux = makeFauxProvider()

    const runtime = await KernelRuntime.open({
      buildProvider: createPluginBuildProvider(),
      dataDir,
      cwd: dataDir,
      model: 'faux/faux-1',
      providers: [faux.provider],
      autoResume: false,
    })
    try {
      const service = new WorkflowService({
        dataDir,
        kv: createMemoryKvStore(),
        host: {
          spawnAgent: (request) => runtime.agentSpawn.spawnAgent(request),
          invokeAction: async (pluginId, actionId) => {
            throw new HelmxError('unknown_action', `测试宿主无动作：${pluginId}.${actionId}`, 404)
          },
          listActions: () => [],
          getConversation: (id) => runtime.conversations.getConversation(id),
          abortConversationGuarded: (id) => runtime.conversations.abortConversationGuarded(id, {}),
          emitEvent: () => {},
        },
      })
      await service.init()

      // faux 脚本：子会话回答固定文本。
      faux.setResponses([fauxAssistantMessage('child says hi')])

      // 不显式指定 agentType：默认必须经 assistant profile（ensureDefault 保证存在）。
      const summary = await service.run({
        conversationId: runtime.conversations.listConversations()[0]!.id,
        script: META('sdk-default') + 'const a = await agent("ping")\nreturn a',
      })
      const result = await service.wait(summary.id)
      assert.equal(service.getRun(summary.id).status, 'completed', service.getRun(summary.id).error)
      assert.equal(result, 'child says hi')
      await service.close()
    } finally {
      await runtime.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('real env.exec child processes are cancelled on early return and script failure', timeout, async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'wf-exec-cleanup-'))
    const faux = makeFauxProvider()
    const app = await createHelmx({
      buildProvider: createPluginBuildProvider(),
      dataDir,
      cwd: dataDir,
      model: 'faux/faux-1',
      providers: [faux.provider],
    })
    // 插件化后编排引擎仅经 builtin:workflow 动作总线驱动（不再暴露 app.workflows）。
    const workflows = app.kernel.plugins!
    const runWorkflow = (request: Record<string, unknown>) =>
      workflows.invokeAction('builtin:workflow', 'run', request, {
        conversationId: app.kernel.conversations.listConversations()[0]!.id,
      }) as Promise<import('../src/contracts.js').WorkflowRunSummary>
    try {
      const sentinels: Array<{ sentinel: string; pid: number }> = []
      for (const [index, ending] of ['return "early"', 'throw new Error("early failure")'].entries()) {
        const ready = join(dataDir, `ready-${index}`)
        const sentinel = join(dataDir, `sentinel-${index}`)
        const slowCommand = [
          process.execPath,
          '-e',
          `const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid)); ` +
            `setTimeout(() => fs.writeFileSync(${JSON.stringify(sentinel)}, "leaked"), 1500);`,
        ]
        const readyCommand = [
          process.execPath,
          '-e',
          `const fs = require("node:fs"); const deadline = setTimeout(() => process.exit(2), 5000); ` +
            `const poll = setInterval(() => { if (fs.existsSync(${JSON.stringify(ready)})) { clearTimeout(deadline); clearInterval(poll); } }, 5);`,
        ]
        // wait:true 在终态 failed 时按动作契约显式抛出（不伪造成功）；抛出后经 runs 取真实终态。
        await assert.rejects(
          runWorkflow({
            script:
              META(`real-exec-cleanup-${index}`) +
              `action("env.exec", { command: ${JSON.stringify(slowCommand)}, timeoutMs: 10000 });\n` +
              `const ready = await action("env.exec", { command: ${JSON.stringify(readyCommand)}, timeoutMs: 10000 });\n` +
              `if (!ready?.ok) throw new Error("child readiness check failed");\n${ending}`,
            wait: true,
          }),
          (error: unknown) => error instanceof HelmxError && error.code === 'workflow_failed',
        )
        const listed = (await workflows.invokeAction('builtin:workflow', 'runs', {})) as unknown as {
          runs: Array<import('../src/contracts.js').WorkflowRunSummary>
        }
        // 取本脚本名下终态 failed 的那一条。
        const failedRuns = listed.runs.filter((r) => r.name === `real-exec-cleanup-${index}`)
        assert.ok(failedRuns.length >= 1, 'run 应出现在 runs 清单')
        const failedRun = failedRuns[0]!
        assert.equal(failedRun.status, 'failed', failedRun.error)
        assert.match(failedRun.error ?? '', index === 0 ? /unawaited launch/ : /early failure/)
        assert.ok(existsSync(ready), 'the actual child must have started before the workflow ends')
        const childPid = Number(readFileSync(ready, 'utf8').trim())
        assert.ok(Number.isSafeInteger(childPid) && childPid > 0, `expected numeric child pid in ${ready}`)
        sentinels.push({ sentinel, pid: childPid })
      }
      // 确定性确认被取消的子进程已真实退出（比盲等 1.7s 更严格且免空等），且哨兵文件从未写入。
      for (const { sentinel, pid } of sentinels) {
        await waitFor(() => !isProcessAlive(pid), {
          timeoutMs: 5_000,
          intervalMs: 10,
          message: `cancelled env.exec child pid ${pid} must exit`,
        })
        assert.equal(existsSync(sentinel), false, 'a cancelled child process must never write the delayed sentinel')
      }
    } finally {
      await app.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('env.exec in real KernelRuntime executes command without consuming tokens', timeout, async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'wf-env-exec-real-'))
    const faux = makeFauxProvider()

    const runtime = await KernelRuntime.open({
      buildProvider: createPluginBuildProvider(),
      dataDir,
      cwd: dataDir,
      model: 'faux/faux-1',
      providers: [faux.provider],
      autoResume: false,
    })
    try {
      const service = new WorkflowService({
        dataDir,
        kv: createMemoryKvStore(),
        host: {
          spawnAgent: (request) => runtime.agentSpawn.spawnAgent(request),
          invokeAction: async (pluginId, actionId, input, context) => {
            return runtime.plugins.invokeAction(pluginId, actionId, input, context)
          },
          prepareAction: (pluginId, actionId, input, context) => {
            return runtime.plugins.prepareAction(pluginId, actionId, input, context)
          },
          execEnv: async (req, signal) => {
            const res = await runtime.nodes.execEnv(req, undefined, signal)
            return {
              ...res,
              output: runtime.stash.redact(res.output),
            }
          },
          listActions: () => runtime.plugins.listActions(),
          getConversation: (id) => runtime.conversations.getConversation(id),
          abortConversationGuarded: (id) => runtime.conversations.abortConversationGuarded(id, {}),
          emitEvent: () => {},
        },
      })
      await service.init()

      const summary = await service.run({
        conversationId: runtime.conversations.listConversations()[0]!.id,
        script:
          META('real-exec') +
          `
          const res = await action("env.exec", { command: ["node", "-e", "process.stdout.write('hello-from-node')"] }, { idempotent: true, label: "run-node" })
          return res
        `,
      })
      const result = (await service.wait(summary.id)) as {
        ok: boolean
        exitCode: number
        output: string
        timedOut: boolean
      }
      assert.equal(service.getRun(summary.id).status, 'completed', service.getRun(summary.id).error)
      assert.equal(result.ok, true)
      assert.equal(result.exitCode, 0)
      assert.equal(result.output, 'hello-from-node')
      assert.equal(result.timedOut, false)

      const run = service.getRun(summary.id)
      const actionNode = run.nodes?.find((n) => n.id === 'action-0')
      assert.equal(actionNode?.label, 'run-node')

      await service.close()
    } finally {
      await runtime.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
