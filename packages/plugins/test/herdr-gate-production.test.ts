import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  ArtifactService,
  InMemoryArtifactRepository,
  SecretStash,
  ensureDataDir,
} from '../../kernel/src/services/index.js'
import { runGate } from '../../kernel/src/runtime/tools.js'
import type { HelmxHostApi } from '@helmx/protocol'
import { assembleHerdrDepsFromHost } from '../src/herdr/host-ports.js'
import { createHerdrTransport } from '../src/herdr/transport.js'
import { pollUntil } from './herdr-node-fixture.js'

/**
 * Herdr Gate 统一委托回归：
 * - `HerdrTransport` 不再自建第二套 `runGate` 执行实现；
 * - 本机与远端 Gate 统一通过 `ctx.host.runGate` 委托内核 `runGate`（显式透传 `nodeId` / `cwd` / `env` / `signal`）；
 * - 经真实内核 `runGate` 验证：abort 后整组进程死亡、1MiB 限额显式失败、关闭输出后等待正常退出、宿主 `HELMX_TOKEN` 不泄漏。
 */

function sentinelScript(root: string): string {
  return `mkdir -p '${root}/.helmx'; (sleep 300) & echo $! > '${root}/.helmx/sentinel.pid'; wait`
}

async function makeGateToolDeps(root: string): Promise<Parameters<typeof runGate>[0]> {
  const dataDir = join(root, '.data')
  await ensureDataDir(dataDir)
  const stash = new SecretStash()
  const artifacts = new ArtifactService(dataDir, new InMemoryArtifactRepository(), stash)
  return {
    dataDir,
    defaultCwd: root,
    hubUrl: 'http://127.0.0.1:3202',
    stashEnvFor: (id: number) => stash.envFor(id),
    redact: (t: string) => stash.redact(t),
    artifacts,
  }
}

test('HerdrTransport 不暴露独立 runGate，assembleHerdrDepsFromHost 直接委托 ctx.host.runGate（含 nodeId）', { timeout: 60_000 }, async () => {
  const transport = createHerdrTransport()
  assert.equal('runGate' in transport, false, 'HerdrTransport 不应重复实现 runGate')

  const calls: Array<{ command: string; options?: Record<string, unknown> }> = []
  const fakeHost = {
    profiles: { get: async () => undefined },
    buildSpawnEnv: () => ({}),
    redact: (t: string) => t,
    runGate: async (command: string, options?: Record<string, unknown>) => {
      calls.push({ command, options })
      return { ok: true, output: 'delegated' }
    },
    getArtifact: async () => { throw new Error('unused') },
    completeText: async () => '',
    nodeIpc: { isOnline: () => true, call: async () => ({ ok: false, error: { code: 'unknown', message: '' } }), subscribe: async () => () => {} },
    openTunnel: async () => { throw new Error('unused') },
    executionEnv: () => { throw new Error('unused') },
  } as unknown as HelmxHostApi

  const deps = assembleHerdrDepsFromHost(fakeHost)
  const controller = new AbortController()
  const localRes = await deps.runGate('echo local', { cwd: '/work/a', nodeId: 'local', env: { K: '1' }, signal: controller.signal })
  const remoteRes = await deps.runGate('echo remote', { cwd: '/work/b', nodeId: 'gate-node', env: { K: '2' }, signal: controller.signal })

  assert.deepEqual(localRes, { ok: true, output: 'delegated' })
  assert.deepEqual(remoteRes, { ok: true, output: 'delegated' })
  assert.equal(calls.length, 2)
  assert.equal(calls[0]!.command, 'echo local')
  assert.equal(calls[0]!.options?.['nodeId'], 'local')
  assert.equal(calls[0]!.options?.['cwd'], '/work/a')
  assert.equal(calls[1]!.command, 'echo remote')
  assert.equal(calls[1]!.options?.['nodeId'], 'gate-node')
  assert.equal(calls[1]!.options?.['cwd'], '/work/b')
  assert.deepEqual(calls[1]!.options?.['env'], { K: '2' })
})

test('内核 runGate abort 后哨兵进程组被清理', { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'helmx-gate-abort-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const toolDeps = await makeGateToolDeps(root)
  const controller = new AbortController()
  const pending = runGate(toolDeps, sentinelScript(root), {
    cwd: root,
    nodeId: 'local',
    signal: controller.signal,
    env: { GATE_ROOT: root },
  })
  const sentinelPidFile = join(root, '.helmx', 'sentinel.pid')
  await pollUntil(
    async () => {
      try {
        const text = (await readFile(sentinelPidFile, 'utf8')).trim()
        return text.length > 0
      } catch {
        return false
      }
    },
    20_000,
    '哨兵 pid 文件出现',
  )
  const pid = Number.parseInt((await readFile(sentinelPidFile, 'utf8')).trim(), 10)
  controller.abort()
  const res = await pending
  assert.equal(res.ok, false)
  await pollUntil(
    async () => {
      try {
        process.kill(pid, 0)
        return false
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'ESRCH'
      }
    },
    30_000,
    '哨兵进程退出（abort 后整组清理）',
  )
})

test('内核 runGate 无限输出在 1MiB 限额处显式失败且不泄漏宿主 HELMX_TOKEN', { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'helmx-gate-overflow-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const toolDeps = await makeGateToolDeps(root)

  const prevToken = process.env.HELMX_TOKEN
  process.env.HELMX_TOKEN = 'host-secret-must-not-leak'
  try {
    const clean = await runGate(
      toolDeps,
      'if [ -n "$HELMX_TOKEN" ]; then echo "HOST:$HELMX_TOKEN"; else echo CLEAN; fi',
      { cwd: root, nodeId: 'local' },
    )
    assert.equal(clean.ok, true)
    assert.equal(clean.output.trim(), 'CLEAN', '宿主 HELMX_TOKEN 绝不进入 gate 子进程')

    const injected = await runGate(
      toolDeps,
      'echo "CUSTOM:$GATE_SECRET"',
      { cwd: root, nodeId: 'local', env: { GATE_SECRET: 'managed-secret' } },
    )
    assert.equal(injected.ok, true)
    assert.equal(injected.output.trim(), 'CUSTOM:managed-secret', '显式 env 提供的变量正常注入')
  } finally {
    if (prevToken === undefined) delete process.env.HELMX_TOKEN
    else process.env.HELMX_TOKEN = prevToken
  }

  const overflow = await runGate(
    toolDeps,
    'head -c 1150000 /dev/zero | tr "\\0" "x"',
    { cwd: root, nodeId: 'local' },
  )
  assert.equal(overflow.ok, false)
  assert.ok(overflow.output.length > 0 && overflow.output.length < 500, '超限应返回明确诊断信息而非巨量截断输出')
})

test('内核 runGate 关闭输出后仍须等待命令正常退出', { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'helmx-gate-quiet-'))
  await mkdir(root, { recursive: true })
  t.after(() => rm(root, { recursive: true, force: true }))
  const toolDeps = await makeGateToolDeps(root)
  const result = await runGate(
    toolDeps,
    'exec >/dev/null 2>&1; sleep 0.05; printf done > finished',
    { cwd: root, nodeId: 'local' },
  )
  assert.equal(result.ok, true)
  assert.equal(result.output, '')
  assert.equal(await readFile(join(root, 'finished'), 'utf8'), 'done')
})
