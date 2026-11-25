/**
 * 跨节点真实守护进程（createNodeDaemon + startHub + createHelmx）端到端集成测试（共享单套 Hub/Node 环境减少冷启动）。
 */
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import assert from 'node:assert/strict'
import { access, mkdir, readFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { after, before, test } from 'node:test'
import { runCli } from '../../cli/src/index.js'
import { createNodeDaemon, type NodeDaemon } from '../../node/src/index.js'
import {
  cleanupDir,
  makeTempDir,
  openHubHttpEnv,
  waitFor,
  type HubHttpTestEnv,
} from './helpers/hub-test-env.js'

function fauxToolCallMessage(name: string, input: Record<string, unknown>): ReturnType<typeof fauxAssistantMessage> {
  return fauxAssistantMessage([fauxToolCall(name, input as Record<string, never>)], { stopReason: 'toolUse' })
}

interface EnvAppFixture {
  root: string
  hubDir: string
  nodeDir: string
  remoteCwd: string
  hubEnv: HubHttpTestEnv
  nodeToken: string
  daemon: NodeDaemon
  connect(): Promise<NodeDaemon>
  cli(args: string[]): Promise<{ code: number; out: string; err: string }>
  request(path: string, body?: unknown, signal?: AbortSignal): Promise<Response>
  close(): Promise<void>
}

let env: EnvAppFixture

async function eventually(check: () => Promise<boolean> | boolean, description: string): Promise<void> {
  await waitFor(check, { timeoutMs: 5_000, intervalMs: 20, message: description })
}

before(async () => {
  const root = await makeTempDir('helmx-node-app-')
  const hubDir = join(root, 'hub')
  const nodeDir = join(root, 'node')
  const remoteCwd = join(root, 'remote-workspace')
  await Promise.all([mkdir(hubDir, { recursive: true }), mkdir(nodeDir, { recursive: true }), mkdir(remoteCwd, { recursive: true })])

  const hubEnv = await openHubHttpEnv({ dataDir: hubDir, cwd: hubDir, swallowCloseError: true })
  const cliEnv = { HELMX_HUB_URL: hubEnv.hubUrl, HELMX_TOKEN: hubEnv.token, HELMX_DATA_DIR: join(root, 'client') }

  async function cli(args: string[]) {
    let out = ''
    let err = ''
    const code = await runCli(args, { env: cliEnv, stdout: (t) => { out += t }, stderr: (t) => { err += t } })
    return { code, out, err }
  }

  const issued = await cli(['nodes', 'issue', 'integration-node', '--json'])
  assert.equal(issued.code, 0, issued.err)
  const { token: nodeToken } = JSON.parse(issued.out) as { token: string }
  assert.ok(nodeToken.startsWith('integration-node:'))

  let daemon: NodeDaemon | undefined
  const connect = async () => {
    daemon = await createNodeDaemon({
      hubUrl: hubEnv.hubUrl,
      identity: { nodeId: 'integration-node', token: nodeToken },
      dataDir: nodeDir,
      envServer: {
        shellEnv: {
          HELMX_NODE_TEST_ORIGIN: 'remote-executor',
          // Put this worktree's generated `helmx` shim first on the simulated remote node's PATH
          // so tests stay hermetic instead of executing a stale global `/usr/local/bin/helmx`.
          PATH: `${join(hubDir, 'bin')}${delimiter}${process.env['PATH'] ?? ''}`,
        },
      },
      reconnectBaseDelayMs: 50,
      log: () => undefined,
    })
    assert.equal(await daemon.waitUntilRegistered(5_000), true)
    return daemon
  }
  await connect()

  env = {
    root,
    hubDir,
    nodeDir,
    remoteCwd,
    hubEnv,
    nodeToken,
    get daemon() { return daemon! },
    connect,
    cli,
    request(path, body, signal) {
      return fetch(`${hubEnv.hubUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${hubEnv.token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal,
      })
    },
    async close() {
      try {
        await daemon?.close()
      } finally {
        try {
          await hubEnv.close()
        } finally {
          await cleanupDir(root)
        }
      }
    },
  }
}, { timeout: 60_000 })

after(async () => {
  await env?.close()
}, { timeout: 60_000 })

test('跨节点后台原生 subagent：真实 WS 节点分配 worktree、执行远端 gate、CLI 清理受管 worktree', { timeout: 60_000 }, async () => {
  const repoDir = join(env.remoteCwd, 'wt-repo')
  await mkdir(repoDir, { recursive: true })
  const setup = await env.cli([
    'env', 'exec', '--node', 'integration-node', '--cwd', repoDir, '--json', '--',
    'git init . && git config user.email test@helmx.local && git config user.name HelmxTest && printf base > base.txt && git add base.txt && git commit -m base',
  ])
  assert.equal(setup.code, 0, setup.err)
  assert.equal(JSON.parse(setup.out).ok, true, setup.out)

  const parent = await env.hubEnv.kernel.conversations.createConversation({ nodeId: 'integration-node', cwd: repoDir })
  env.hubEnv.faux.setResponses([
    fauxToolCallMessage('subagent', {
      prompt: 'execute remote verify',
      background: true,
      isolation: 'worktree',
      gate: 'test "$HELMX_NODE_TEST_ORIGIN" = remote-executor && printf "$HELMX_NODE_TEST_ORIGIN" > remote-proof.txt',
    }),
    ...Array.from({ length: 4 }, () => fauxAssistantMessage('remote task result')),
  ])
  await env.hubEnv.kernel.conversations.submitInput(parent.id, 'dispatch background isolated subagent')
  await env.hubEnv.kernel.conversations.waitForIdle(parent.id)

  const detail = await env.hubEnv.kernel.conversations.getConversationDetail(parent.id, { limit: 50 })
  const runIdMatch = /runId\\?":\\?"(wf_[0-9a-f]+)/.exec(JSON.stringify(detail))
  assert.ok(runIdMatch)
  const runId = runIdMatch[1]!

  const child = env.hubEnv.kernel.conversations.listConversations().find((c) => c.parentConversationId === parent.id)
  assert.ok(child)
  assert.equal(child.nodeId, 'integration-node')

  const inspect = await env.hubEnv.kernel.plugins.invokeAction('builtin:workflow', 'inspect', { runId }) as {
    run: { status: string; error?: string; nodes?: Array<{ id: string; status: string; error?: string }> }
  }
  for (let i = 0; i < 300 && inspect.run.status === 'running'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20))
    inspect.run = ((await env.hubEnv.kernel.plugins.invokeAction('builtin:workflow', 'inspect', { runId })) as typeof inspect).run
  }
  assert.equal(inspect.run.status, 'completed')

  const toolMessages = (await env.hubEnv.kernel.conversations.getConversationDetail(parent.id, { limit: 50 })).entries
    .filter((e) => e.kind === 'pi.tool-result')
    .flatMap((e) => (Array.isArray(e.model) ? e.model : []) as Array<{
      toolName?: string
      content?: Array<{ text?: string }>
      details?: { execution?: { worktree?: { id?: string } } }
    }>)
  const subagentMsg = toolMessages.find((m) => m.toolName === 'subagent')
  const parsedOutput = JSON.parse(subagentMsg?.content?.[0]?.text ?? '{}') as {
    execution?: { worktree?: { id?: string } }
  }
  const wtId = parsedOutput.execution?.worktree?.id
  assert.ok(wtId && wtId.startsWith('integration-node:'))
  assert.equal(subagentMsg?.details?.execution?.worktree?.id, wtId)
  const wtPath = wtId.slice('integration-node:'.length)
  assert.equal(child.cwd, wtPath)
  assert.equal(await readFile(join(wtPath, 'remote-proof.txt'), 'utf8'), 'remote-executor')

  const preserved = await env.cli(['worktrees', 'cleanup', '--worktree-id', wtId, '--json'])
  assert.notEqual(preserved.code, 0)
  assert.equal(JSON.parse(preserved.err).error.code, 'worktree_dirty')
  const cleanup = await env.cli(['worktrees', 'cleanup', '--worktree-id', wtId, '--force', '--json'])
  assert.equal(cleanup.code, 0, cleanup.err)
  assert.equal(JSON.parse(cleanup.out).nodeId, 'integration-node')
  assert.equal(JSON.parse(cleanup.out).removed, true)
  await assert.rejects(access(wtPath), { code: 'ENOENT' })
})

test('HTTP /api/env/exec 参数边界校验与本机受管 Shell helmx 包装器入口', { timeout: 60_000 }, async () => {
  for (const body of [
    { command: [] },
    { command: '   ' },
    { command: 'true', nodeId: '--bad' },
    { command: 'true', timeoutMs: 600_001 },
    { command: 'true', env: { 'BAD-NAME': 'value' } },
  ]) {
    const response = await env.request('/api/env/exec', body)
    assert.equal(response.status, 400)
    assert.equal((await response.json() as { error: { code: string } }).error.code, 'validation_error')
  }

  const wrapper = await readFile(join(env.hubDir, 'bin', 'helmx'), 'utf8')
  assert.match(wrapper, /packages[\\/]cli[\\/]src[\\/]index\.ts/)
  const response = await env.request('/api/env/exec', {
    nodeId: 'local',
    cwd: env.hubDir,
    conversationId: 1,
    command: 'helmx status --json',
  })
  assert.equal(response.status, 200)
  const result = await response.json() as { ok: boolean; output: string }
  assert.equal(result.ok, true, result.output)
  assert.equal(JSON.parse(result.output).authenticated, true)
})

test('节点全链路贯通：CLI、真实模型工具、Gate 与 Profile 子代理均在绑定节点执行', { timeout: 60_000 }, async () => {
  const wsDir = join(env.remoteCwd, 'tools-ws')
  await mkdir(wsDir, { recursive: true })
  const kernel = env.hubEnv.kernel

  assert.equal(kernel.plugins.list().find((p) => p.id === 'builtin:herdr'), undefined)
  const listed = await env.cli(['nodes', 'list', '--json'])
  assert.equal(listed.code, 0, listed.err)
  assert.ok(JSON.parse(listed.out).some((n: { id: string; online: boolean }) => n.id === 'integration-node' && n.online))

  const snapshot = kernel.events.currentSnapshot()
  assert.ok(snapshot.nodes?.some((node) => node.id === 'integration-node' && node.online))
  assert.equal(JSON.stringify(snapshot).includes(env.nodeToken), false)

  const nodeFrames: unknown[] = []
  const releaseEvents = kernel.events.subscribe((frame) => {
    if (frame.event.type === 'node.changed') nodeFrames.push(frame)
  })
  await env.daemon.close()
  await eventually(() => nodeFrames.length > 0, 'node disconnection must publish node.changed')
  await env.connect()
  await eventually(() => nodeFrames.length >= 2, 're-register must publish node.changed')
  releaseEvents()
  assert.equal(JSON.stringify(nodeFrames).includes(env.nodeToken), false)

  const conversation = await kernel.conversations.createConversation({ nodeId: 'integration-node', cwd: wsDir })
  env.hubEnv.faux.setResponses([
    fauxAssistantMessage([fauxToolCall('write', { path: 'proof.txt', content: 'first' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxToolCall('edit', { path: 'proof.txt', oldText: 'first', newText: 'second' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxToolCall('read', { path: 'proof.txt' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxToolCall('bash', { command: 'helmx status --json' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage('node tool turn complete'),
  ])
  await kernel.conversations.submitInput(conversation.id, 'execute file edit and query Hub state')
  await kernel.conversations.waitForIdle(conversation.id)
  assert.equal(await readFile(join(wsDir, 'proof.txt'), 'utf8'), 'second')

  const detail = await kernel.conversations.getConversationDetail(conversation.id)
  assert.equal(JSON.stringify(detail).includes(env.nodeToken), false)
  const toolResults = JSON.stringify(detail.entries.filter((entry) => entry.kind === 'pi.tool-result'))
  assert.doesNotMatch(toolResults, /"isError":true/)
  assert.match(toolResults, /authenticated/)

  const gate = await kernel.agentSpawn.runGate('test "$HELMX_NODE_TEST_ORIGIN" = remote-executor', {
    conversationId: conversation.id,
    cwd: wsDir,
  })
  assert.equal(gate.ok, true, gate.output)

  const executed = await env.cli([
    'env', 'exec', '--node', 'integration-node', '--cwd', wsDir, '--json', '--',
    process.execPath, '-e', 'process.stdout.write(JSON.stringify({origin:process.env.HELMX_NODE_TEST_ORIGIN,dataDir:process.env.HELMX_DATA_DIR,hubUrl:process.env.HELMX_HUB_URL}))',
  ])
  assert.equal(executed.code, 0, executed.err)
  const remoteEnvironment = JSON.parse(JSON.parse(executed.out).output)
  assert.equal(remoteEnvironment.origin, 'remote-executor')
  assert.equal(remoteEnvironment.dataDir, env.nodeDir)
  assert.equal(remoteEnvironment.hubUrl, env.hubEnv.hubUrl)

  await kernel.profiles.save({ id: 'node-expert', nodeId: 'integration-node', cwd: wsDir })
  const profileConversation = await kernel.conversations.createConversation({ profileId: 'node-expert' })
  assert.equal(profileConversation.nodeId, 'integration-node')
  assert.equal(profileConversation.cwd, wsDir)

  env.hubEnv.faux.setResponses([fauxAssistantMessage('node dedicated household complete')])
  let childId: number | undefined
  await kernel.agentSpawn.spawnAgent({
    parentConversationId: 1,
    agentType: 'node-expert',
    prompt: 'execute node dedicated household task',
    gate: 'test "$HELMX_NODE_TEST_ORIGIN" = remote-executor && printf gate >> native-gate',
    onResolved: (info) => { childId = info.conversationId },
  })
  assert.ok(childId)
  assert.equal(kernel.conversations.getConversation(childId).nodeId, 'integration-node')
  assert.equal(await readFile(join(wsDir, 'native-gate'), 'utf8'), 'gate')
})

test('流式执行与跨节点取消：实时输出、跨 chunk 机密脱敏、会话隔离及 HTTP abort 终止远端子进程树', { timeout: 60_000 }, async () => {
  const streamDir = join(env.remoteCwd, 'stream-ws')
  await mkdir(streamDir, { recursive: true })
  const kernel = env.hubEnv.kernel

  // 1. 命令结束前实时送达输出，取消 reader 关闭远端执行
  const liveRes = await env.request('/api/env/exec', {
    nodeId: 'integration-node',
    cwd: streamDir,
    stream: true,
    command: [process.execPath, '-e', 'process.stdout.write("progress\\n"); setTimeout(() => process.stdout.write("finished"), 5000)'],
  })
  const reader = liveRes.body!.getReader()
  const firstChunk = new TextDecoder().decode((await reader.read()).value)
  assert.match(firstChunk, /progress/)
  assert.doesNotMatch(firstChunk, /finished|"type":"exit"/)
  await reader.cancel()

  // 2. 跨 chunk 机密脱敏与 NDJSON 终态
  const conv = await kernel.conversations.createConversation({ nodeId: 'integration-node', cwd: streamDir })
  const secret = 'node-secret-across-chunks-7b0139'
  kernel.stash.addRedaction(secret)
  const redactedRes = await env.request('/api/env/exec', {
    conversationId: conv.id,
    stream: true,
    command: [
      process.execPath, '-e',
      `process.stdout.write(${JSON.stringify(secret.slice(0, 13))}); setTimeout(() => process.stdout.write(${JSON.stringify(secret.slice(13))}), 50)`,
    ],
  })
  assert.equal(redactedRes.status, 200)
  assert.match(redactedRes.headers.get('content-type') ?? '', /application\/x-ndjson/)
  const frames = (await redactedRes.text()).trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(frames.at(-1).type, 'exit')
  assert.equal(frames.at(-1).ok, true)
  const text = frames.filter((frame) => frame.type === 'output').map((frame) => frame.text).join('')
  assert.equal(text.includes(secret), false)
  assert.equal(text.includes(secret.slice(0, 13)), false)
  assert.match(text, /\[REDACTED\]/)

  const stored = await readFile(join(env.hubDir, 'state.sqlite'))
  assert.equal(stored.includes(Buffer.from(secret)), false)
  assert.equal(stored.includes(Buffer.from(env.nodeToken)), false)

  // 3. HTTP abort 传播到节点并终止后代进程写入
  const controller = new AbortController()
  const childProgram = 'setInterval(() => require("node:fs").appendFileSync("child-heartbeat", "x"), 20)'
  const program = `const cp = require('node:child_process'); cp.spawn(process.execPath, ['-e', ${JSON.stringify(childProgram)}], { stdio: ['ignore', 'inherit', 'inherit'] }); setInterval(() => {}, 1000)`
  const pending = env.request('/api/env/exec', {
    nodeId: 'integration-node',
    cwd: streamDir,
    command: [process.execPath, '-e', program],
  }, controller.signal)
  const completed = pending.then(() => 'completed', (error: unknown) => error)
  const heartbeatPath = join(streamDir, 'child-heartbeat')
  await eventually(async () => readFile(heartbeatPath, 'utf8').then((t) => t.length >= 3, () => false), '子孙进程启动')
  controller.abort()
  const outcome = await completed
  assert.ok(outcome instanceof Error && outcome.name === 'AbortError')
  await new Promise((resolve) => setTimeout(resolve, 150))
  const beforeLen = await readFile(heartbeatPath, 'utf8')
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(await readFile(heartbeatPath, 'utf8'), beforeLen)
})

test('Workflow + Worktree 动态远端 nodeId：本地父会话通过 subagent 与 DSL agent({ nodeId, cwd, isolation: worktree }) 在线分配远端工作树并执行远端 gate', { timeout: 60_000 }, async () => {
  const dynRepoDir = join(env.remoteCwd, 'dyn-wt-repo')
  await mkdir(dynRepoDir, { recursive: true })
  const initRepo = await env.cli([
    'env', 'exec', '--node', 'integration-node', '--cwd', dynRepoDir, '--json', '--',
    'git init . && git config user.email test@helmx.local && git config user.name HelmxTest && printf dyn-base > base.txt && git add base.txt && git commit -m base',
  ])
  assert.equal(initRepo.code, 0, initRepo.err)
  assert.equal(JSON.parse(initRepo.out).ok, true, initRepo.out)

  const kernel = env.hubEnv.kernel
  const localParent = await kernel.conversations.createConversation({
    title: 'Local Dynamic Node Parent',
    nodeId: 'local',
    cwd: env.hubDir,
  })
  assert.equal(localParent.nodeId, 'local')

  // 1) subagent tool: local parent dynamically targets integration-node + isolation: 'worktree'
  env.hubEnv.faux.setResponses([fauxAssistantMessage('subagent-remote-wt-done')])
  const subOut = (await kernel.plugins.executeTool(
    'subagent',
    {
      prompt: 'Run isolated subagent on integration-node',
      nodeId: 'integration-node',
      cwd: dynRepoDir,
      isolation: 'worktree',
      background: false,
      gate: 'test "$HELMX_NODE_TEST_ORIGIN" = remote-executor && printf "subagent:%s" "$HELMX_NODE_TEST_ORIGIN" > subagent-gate.txt',
    },
    { conversationId: localParent.id, callId: 'call-dyn-node-subagent' },
  )) as {
    structuredOutput: {
      ok: boolean
      result?: unknown
      execution?: { conversationId?: number; nodeId?: string; effectiveCwd?: string; worktree?: { id?: string; path?: string; branch?: string } }
    }
  }
  assert.equal(subOut.structuredOutput.ok, true)
  assert.equal(subOut.structuredOutput.result, 'subagent-remote-wt-done')
  assert.equal(subOut.structuredOutput.execution?.nodeId, 'integration-node')
  const subWtId = subOut.structuredOutput.execution?.worktree?.id
  const subWtPath = subOut.structuredOutput.execution?.worktree?.path
  const subChildId = subOut.structuredOutput.execution?.conversationId
  assert.ok(subWtId && subWtId.startsWith('integration-node:'), `subagent worktreeId must target integration-node: ${String(subWtId)}`)
  assert.ok(subWtPath && subWtId === `integration-node:${subWtPath}`)
  assert.ok(subChildId)
  const subChild = kernel.conversations.getConversation(subChildId)
  assert.equal(subChild.nodeId, 'integration-node')
  assert.equal(subChild.cwd, subWtPath)
  assert.equal(await readFile(join(subWtPath, 'subagent-gate.txt'), 'utf8'), 'subagent:remote-executor')

  // 2) Workflow DSL agent.withMeta({ nodeId, cwd, isolation: 'worktree', gate }) from local parent
  env.hubEnv.faux.setResponses([fauxAssistantMessage('dsl-remote-wt-done')])
  const dslScript =
    'export const meta = { name: "dyn-node-wt-dsl", description: "Workflow DSL remote worktree" }\n' +
    `const r = await agent.withMeta("Run DSL isolated agent on integration-node", { nodeId: "integration-node", cwd: ${JSON.stringify(dynRepoDir)}, isolation: "worktree", gate: 'test "$HELMX_NODE_TEST_ORIGIN" = remote-executor && printf "dsl:%s" "$HELMX_NODE_TEST_ORIGIN" > dsl-gate.txt' })\n` +
    'return r'

  const { run: dslRun } = (await kernel.plugins.invokeAction('builtin:workflow', 'run', {
    conversationId: localParent.id,
    script: dslScript,
    wait: true,
  })) as {
    run: {
      status: string
      error?: string
      result?: {
        ok: boolean
        output?: unknown
        execution?: { conversationId?: number; nodeId?: string; effectiveCwd?: string; worktree?: { id?: string; path?: string } }
      }
    }
  }
  assert.equal(dslRun.status, 'completed', dslRun.error)
  assert.equal(dslRun.result?.ok, true)
  assert.equal(dslRun.result?.output, 'dsl-remote-wt-done')
  assert.equal(dslRun.result?.execution?.nodeId, 'integration-node')
  const dslWtId = dslRun.result?.execution?.worktree?.id
  const dslWtPath = dslRun.result?.execution?.worktree?.path
  const dslChildId = dslRun.result?.execution?.conversationId
  assert.ok(dslWtId && dslWtId.startsWith('integration-node:'), `DSL worktreeId must target integration-node: ${String(dslWtId)}`)
  assert.ok(dslWtPath && dslWtId === `integration-node:${dslWtPath}`)
  assert.notEqual(dslWtPath, subWtPath, 'subagent and DSL runs allocate distinct remote worktrees')
  assert.ok(dslChildId)
  const dslChild = kernel.conversations.getConversation(dslChildId)
  assert.equal(dslChild.nodeId, 'integration-node')
  assert.equal(dslChild.cwd, dslWtPath)
  assert.equal(await readFile(join(dslWtPath, 'dsl-gate.txt'), 'utf8'), 'dsl:remote-executor')

  // Clean up both allocated remote worktrees via builtin:worktree
  for (const [wtId, wtPath] of [[subWtId, subWtPath], [dslWtId, dslWtPath]] as const) {
    const cleaned = (await kernel.plugins.invokeAction('builtin:worktree', 'cleanup_worktree', {
      worktreeId: wtId,
      force: true,
      deleteBranch: true,
    })) as { removed: boolean; nodeId: string; branchDeleted: boolean }
    assert.equal(cleaned.removed, true)
    assert.equal(cleaned.nodeId, 'integration-node')
    assert.equal(cleaned.branchDeleted, true)
    await assert.rejects(access(wtPath), { code: 'ENOENT' })
  }
})

test('节点断线与撤销：在途命令结果 unknown、重连绝不重放、移除后离线拒绝且不回落本机执行', { timeout: 60_000 }, async () => {
  const discDir = join(env.remoteCwd, 'disc-ws')
  await mkdir(discDir, { recursive: true })
  const countPath = join(discDir, 'executions.txt')

  const pending = env.request('/api/env/exec', {
    nodeId: 'integration-node',
    cwd: discDir,
    command: [process.execPath, '-e', 'require("node:fs").appendFileSync("executions.txt", "once\\n"); setInterval(() => {}, 1000)'],
  })
  await eventually(async () => readFile(countPath, 'utf8').then((t) => t === 'once\n', () => false), '远端命令真实启动')
  await env.daemon.close()
  const body = await (await pending).json() as { ok?: boolean }
  assert.equal(body.ok === true, false)
  assert.match(JSON.stringify(body), /unknown/)

  await env.connect()
  assert.equal(await readFile(countPath, 'utf8'), 'once\n')

  const removed = await env.cli(['nodes', 'remove', 'integration-node', '--json'])
  assert.equal(removed.code, 0, removed.err)
  await eventually(() => !env.daemon.isConnected(), '删除节点关闭既有 WS')

  const offline = await env.request('/api/env/exec', {
    nodeId: 'integration-node',
    cwd: env.hubDir,
    command: [process.execPath, '-e', 'require("node:fs").writeFileSync("must-not-run", "bad")'],
  })
  assert.equal(offline.ok, false)
  assert.match(JSON.stringify(await offline.json()), /node_offline|node_not_found/)
  await assert.rejects(readFile(join(env.hubDir, 'must-not-run')), { code: 'ENOENT' })
})
