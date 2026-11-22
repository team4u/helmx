import assert from 'node:assert/strict'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { duplexPair } from 'node:stream'
import { test } from 'node:test'
import { HelmxError, type NodeHostEnv, type NodeTunnelTarget } from '@helmx/protocol'
import { createHerdrTransport, resolveHerdrEndpointFromHostEnv } from '../src/herdr/transport.js'
import type { HerdrNodeChannel, HerdrNodeEnv } from '../src/herdr/contracts.js'
import { MutableNodeChannel, nodeFixture, pollUntil, type NodeFixture } from './herdr-node-fixture.js'

/**
 * 节点通道整链（目标节点 hostEnv 发现 + 受控 socketPath 隧道 + 统一 Duplex NDJSON）：
 * - 远端 call 与 subscribe 均走 `openTunnel({ socketPath })` 统一 Duplex NDJSON，机密只在 JSON 内部；
 * - 目标节点端点发现走 `getNodeHostEnv({ envKeys: ['HERDR_SOCKET_PATH'] })`，绝不沿用 Hub 本机 env；
 * - Linux 与 Windows-shaped 远端目标端点解析（含 Windows marker 检查与 `\\.\pipe\` 隧道路径）；
 * - readOutput / removeOutput 在真实节点文件系统执行，拦截 .helmx 父目录软链逃逸 / 32MiB 超限 / 文件软链；
 * - 离线 / draining / 通道缺失 / getNodeHostEnv 501 显式报错，绝不静默回退本机；
 * - Windows 端点/路径规则：interprocess pathcvt 真实规则（源码推导，未实机验证）。
 */

function transportOf(
  fixture: NodeFixture,
  opts: {
    nodeId?: string
    online?: boolean
    hubUrl?: string
    hostEnv?: NodeHostEnv
    redact?: (text: string) => string
  } = {},
) {
  const channel = new MutableNodeChannel()
  const nodeId = opts.nodeId ?? 'node-a'
  channel.nodes.set(nodeId, {
    online: opts.online ?? true,
    ...(opts.hubUrl !== undefined ? { hubUrl: opts.hubUrl } : {}),
    ...(opts.hostEnv !== undefined ? { hostEnv: opts.hostEnv } : {}),
    channel: fixture.channel,
  })
  return {
    channel,
    transport: createHerdrTransport({ redact: opts.redact, nodeChannel: channel }),
    target: { nodeId, socketPath: fixture.socketPath } as const,
  }
}

test('远端节点 call 经受控 socketPath 隧道完成统一 Duplex NDJSON 往返，机密只在 JSON 内部', { timeout: 60_000 }, async (t) => {
  const fixture = await nodeFixture(t)
  const secret = 'pipeline-secret-only-in-stdin'
  const { transport, target, channel } = transportOf(fixture)
  const result = await transport.call(target, 'tab.create', { env: { PRIVATE_TOKEN: secret } }, { timeoutMs: 3_000 })
  assert.deepEqual(result, { type: 'ok' })
  assert.equal(fixture.requests.length, 1)
  assert.equal(fixture.requests[0]!.id, '1')
  assert.equal(fixture.requests[0]!.method, 'tab.create')
  assert.deepEqual(fixture.requests[0]!.params.env, { PRIVATE_TOKEN: secret })
  // 显式 socketPath 跳过 hostEnv 查询，直接走 openTunnel({ socketPath })。
  assert.equal(channel.seenHostEnvQueries.length, 0)
  assert.deepEqual(channel.seenTunnelInputs, [{ nodeId: 'node-a', target: { socketPath: fixture.socketPath } }])
})

test('目标节点环境发现：远端缺省 socketPath 仅用目标节点 Linux hostEnv，绝不受 Hub 本机 env 污染', { timeout: 60_000 }, async (t) => {
  const fixture = await nodeFixture(t)
  const prevHubSocket = process.env.HERDR_SOCKET_PATH
  const prevHubXdg = process.env.XDG_CONFIG_HOME
  process.env.HERDR_SOCKET_PATH = '/hub-only/should-never-be-used.sock'
  process.env.XDG_CONFIG_HOME = '/hub-xdg/should-never-be-used'
  try {
    // 1. 远端目标节点有自己的 HERDR_SOCKET_PATH -> 隧道拨号目标节点声明的路径
    const withRemoteEnv = transportOf(fixture, {
      nodeId: 'linux-remote',
      hostEnv: {
        platform: 'linux',
        homeDir: '/home/remote-dev',
        tempDir: '/tmp',
        dirs: { home: '/home/remote-dev', xdgConfigHome: '/home/remote-dev/.xdg' },
        env: { HERDR_SOCKET_PATH: fixture.socketPath },
      },
    })
    const res = await withRemoteEnv.transport.call({ nodeId: 'linux-remote' }, 'ping', {}, { timeoutMs: 3_000 })
    assert.deepEqual(res, { type: 'ok' })
    assert.deepEqual(withRemoteEnv.channel.seenHostEnvQueries, [
      { nodeId: 'linux-remote', query: { envKeys: ['HERDR_SOCKET_PATH'] } },
    ])
    assert.deepEqual(withRemoteEnv.channel.seenTunnelInputs, [
      { nodeId: 'linux-remote', target: { socketPath: fixture.socketPath } },
    ])

    // 2. 远端目标节点无 HERDR_SOCKET_PATH，带 session -> 按目标节点 XDG_CONFIG_HOME 推导（绝不取 Hub 的 HERDR_SOCKET_PATH）
    const seenTargets: NodeTunnelTarget[] = []
    const [clientSide, serverSide] = duplexPair()
    serverSide.on('data', (chunk: Buffer) => {
      const req = JSON.parse(chunk.toString('utf8').trim()) as { id: string }
      serverSide.end(`${JSON.stringify({ id: req.id, result: { type: 'ok' } })}\n`)
    })
    const customChannel: HerdrNodeChannel = {
      isOnline: () => true,
      getNodeHubUrl: () => undefined,
      getNodeHostEnv: async () => ({
        platform: 'linux',
        homeDir: '/home/remote-dev',
        tempDir: '/tmp',
        dirs: { xdgConfigHome: '/home/remote-dev/.xdg', home: '/home/remote-dev' },
        env: {},
      }),
      openTunnel: async (_nodeId, target) => {
        seenTargets.push(target)
        return clientSide
      },
      envFor: (id, cwd) => fixture.channel.envFor('local', cwd),
    }
    const transport = createHerdrTransport({ nodeChannel: customChannel })
    const res2 = await transport.call({ nodeId: 'linux-xdg', session: 'nightly' }, 'ping', {})
    assert.deepEqual(res2, { type: 'ok' })
    assert.deepEqual(seenTargets, [{ socketPath: '/home/remote-dev/.xdg/herdr/sessions/nightly/herdr.sock' }])
  } finally {
    if (prevHubSocket === undefined) delete process.env.HERDR_SOCKET_PATH
    else process.env.HERDR_SOCKET_PATH = prevHubSocket
    if (prevHubXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = prevHubXdg
  }
})

test('目标节点环境发现（Windows 形状）：marker 缺失报 herdr_unreachable；marker 存在后以 \\\\.\\pipe\\ 拨号隧道', { timeout: 60_000 }, async () => {
  const winHostEnv: NodeHostEnv = {
    platform: 'win32',
    homeDir: 'C:\\Users\\alice',
    tempDir: 'C:\\Users\\alice\\AppData\\Local\\Temp',
    dirs: {
      appData: 'C:\\Users\\alice\\AppData\\Roaming',
      userProfile: 'C:\\Users\\alice',
    },
    env: {},
  }
  const expectedMarker = 'C:\\Users\\alice\\AppData\\Roaming\\herdr\\sessions\\work\\herdr.sock'
  const expectedPipe = `\\\\.\\pipe\\${expectedMarker}`

  // 1. 纯推导覆盖 Windows 优先级：XDG > APPDATA > USERPROFILE > HOME/.config > temp，以及 HERDR_SOCKET_PATH
  assert.deepEqual(resolveHerdrEndpointFromHostEnv({ session: 'work' }, winHostEnv), {
    kind: 'named-pipe',
    connectPath: expectedPipe,
    markerPath: expectedMarker,
  })
  assert.deepEqual(
    resolveHerdrEndpointFromHostEnv(
      {},
      {
        platform: 'win32',
        homeDir: 'C:\\Users\\alice',
        tempDir: 'T:\\tmp',
        dirs: { xdgConfigHome: 'D:\\xdg', appData: 'C:\\Users\\alice\\AppData\\Roaming' },
        env: {},
      },
    ),
    {
      kind: 'named-pipe',
      connectPath: '\\\\.\\pipe\\D:\\xdg\\herdr\\herdr.sock',
      markerPath: 'D:\\xdg\\herdr\\herdr.sock',
    },
  )
  assert.deepEqual(
    resolveHerdrEndpointFromHostEnv(
      {},
      {
        platform: 'win32',
        homeDir: 'C:\\Users\\alice',
        tempDir: 'T:\\tmp',
        dirs: { userProfile: 'C:\\Users\\alice' },
        env: {},
      },
    ),
    {
      kind: 'named-pipe',
      connectPath: '\\\\.\\pipe\\C:\\Users\\alice\\AppData\\Roaming\\herdr\\herdr.sock',
      markerPath: 'C:\\Users\\alice\\AppData\\Roaming\\herdr\\herdr.sock',
    },
  )
  assert.deepEqual(
    resolveHerdrEndpointFromHostEnv(
      {},
      {
        platform: 'win32',
        homeDir: 'C:\\Users\\alice',
        tempDir: 'T:\\tmp',
        dirs: {},
        env: { HERDR_SOCKET_PATH: '\\\\.\\pipe\\custom-herdr' },
      },
    ),
    {
      kind: 'named-pipe',
      connectPath: '\\\\.\\pipe\\custom-herdr',
    },
  )

  // 2. 远端 Windows 节点 marker 缺失 -> 在 envFor.fileInfo 阶段显式 herdr_unreachable，绝不拨号 openTunnel
  let tunnelAttempts = 0
  const missingMarkerChannel: HerdrNodeChannel = {
    isOnline: () => true,
    getNodeHubUrl: () => undefined,
    getNodeHostEnv: async () => winHostEnv,
    openTunnel: async () => {
      tunnelAttempts += 1
      throw new Error('must not dial openTunnel when marker is missing')
    },
    envFor: () => ({
      fileInfo: async () => ({ ok: false, error: { code: 'not_found', message: 'ENOENT' } }),
    }) as unknown as HerdrNodeEnv,
  }
  await assert.rejects(
    createHerdrTransport({ nodeChannel: missingMarkerChannel }).call({ nodeId: 'win-box', session: 'work' }, 'ping', {}),
    (err: unknown) => {
      assert.equal((err as { code?: string }).code, 'herdr_unreachable')
      assert.ok((err as Error).message.includes('herdr.sock'))
      return true
    },
  )
  assert.equal(tunnelAttempts, 0)

  // 3. 远端 Windows 节点 marker 存在 -> openTunnel 收到受控 \\.\pipe\... 路径完成 NDJSON 往返
  const seenTargets: NodeTunnelTarget[] = []
  const seenMarkerChecks: string[] = []
  const [clientSide, serverSide] = duplexPair()
  serverSide.on('data', (chunk: Buffer) => {
    const req = JSON.parse(chunk.toString('utf8').trim()) as { id: string }
    serverSide.end(`${JSON.stringify({ id: req.id, result: { type: 'pong-win' } })}\n`)
  })
  const presentMarkerChannel: HerdrNodeChannel = {
    isOnline: () => true,
    getNodeHubUrl: () => undefined,
    getNodeHostEnv: async () => winHostEnv,
    openTunnel: async (_nodeId, target) => {
      seenTargets.push(target)
      return clientSide
    },
    envFor: () => ({
      fileInfo: async (markerPath: string) => {
        seenMarkerChecks.push(markerPath)
        return { ok: true, value: { kind: 'file', size: 12 } }
      },
    }) as unknown as HerdrNodeEnv,
  }
  const winRes = await createHerdrTransport({ nodeChannel: presentMarkerChannel }).call(
    { nodeId: 'win-box', session: 'work' },
    'ping',
    {},
  )
  assert.deepEqual(winRes, { type: 'pong-win' })
  assert.deepEqual(seenMarkerChecks, [expectedMarker])
  assert.deepEqual(seenTargets, [{ socketPath: expectedPipe }])
})

test('同一节点通道完成远端文件读取与删除', { timeout: 60_000 }, async (t) => {
  const fixture = await nodeFixture(t)
  const root = fixture.root
  await mkdir(join(root, '.helmx'), { recursive: true })
  await writeFile(join(root, '.helmx', 'wf-out-pipeline.json'), '{"answer":42}')
  const { transport } = transportOf(fixture)
  const target = { nodeId: 'node-a' }
  assert.equal(await transport.readOutput(target, root, 'wf-out-pipeline.json'), '{"answer":42}')
  await transport.removeOutput(target, root, 'wf-out-pipeline.json')
  await assert.rejects(transport.readOutput(target, root, 'wf-out-pipeline.json'), (error: unknown) =>
    typeof error === 'object' && error !== null && 'code' in error && error.code === 'herdr_output_missing')
})

test('本机与远端节点交接文件均拒绝通过 .helmx 父目录软链越界', { timeout: 60_000 }, async (t) => {
  const fixture = await nodeFixture(t)
  const root = fixture.root
  const cwd = join(root, 'task')
  const outside = join(root, 'outside')
  await mkdir(cwd)
  await mkdir(outside)
  await writeFile(join(outside, 'wf-out-parent.json'), '{"private":true}')
  await symlink(outside, join(cwd, '.helmx'))
  const { transport } = transportOf(fixture)
  for (const target of [{}, { nodeId: 'node-a' }]) {
    await assert.rejects(transport.readOutput(target, cwd, 'wf-out-parent.json'), '读取不得越过工作目录')
    await assert.rejects(transport.removeOutput(target, cwd, 'wf-out-parent.json'), '删除不得越过工作目录')
    assert.equal(await readFile(join(outside, 'wf-out-parent.json'), 'utf8'), '{"private":true}')
  }
})

test('远端节点离线、draining、通道缺失与 getNodeHostEnv 501 显式报错，绝不静默回退本机', { timeout: 60_000 }, async (t) => {
  const fixture = await nodeFixture(t)
  // 通道存在但节点离线。
  const offline = transportOf(fixture, { nodeId: 'offline-node', online: false })
  await assert.rejects(
    offline.transport.call({ nodeId: 'offline-node', socketPath: fixture.socketPath }, 'ping', {}),
    (error: unknown) => (error as { code?: string }).code === 'herdr_node_offline',
  )
  // 节点 draining：openTunnel 返回 503 node_draining 时保留精确 code。
  const drainingChannel: HerdrNodeChannel = {
    isOnline: () => true,
    getNodeHubUrl: () => undefined,
    getNodeHostEnv: async () => {
      throw new HelmxError('node_host_env_not_supported', 'unsupported', 501)
    },
    openTunnel: async () => {
      throw new HelmxError('node_draining', 'daemon is draining', 503)
    },
    envFor: (id, cwd) => fixture.channel.envFor('local', cwd),
  }
  const drainingTransport = createHerdrTransport({ nodeChannel: drainingChannel })
  await assert.rejects(
    drainingTransport.call({ nodeId: 'drain-node', socketPath: fixture.socketPath }, 'ping', {}),
    (error: unknown) => (error as { code?: string }).code === 'node_draining',
  )
  // getNodeHostEnv 501 显式报错（绝不静默读取 Hub 本机环境）。
  await assert.rejects(
    drainingTransport.call({ nodeId: 'drain-node' }, 'ping', {}),
    (error: unknown) => (error as { code?: string }).code === 'herdr_node_error',
  )
  // 完全没有通道注入（nodeChannel 未提供且 nodeId 非 local）。
  const bare = createHerdrTransport({})
  await assert.rejects(
    bare.call({ nodeId: 'unknown-node' }, 'ping', {}),
    (error: unknown) => (error as { code?: string }).code === 'herdr_node_unavailable',
  )
  await assert.rejects(
    bare.readOutput({ nodeId: 'unknown-node' }, '/tmp', 'wf-out-x.json'),
    (error: unknown) => (error as { code?: string }).code === 'herdr_node_unavailable',
  )
})

test('远端节点 hubUrl 经 getNodeHubUrl 提供时可用于窗格回连注入', { timeout: 60_000 }, async (t) => {
  const fixture = await nodeFixture(t)
  const { channel } = transportOf(fixture, { nodeId: 'node-hub', hubUrl: 'http://10.0.0.9:3202' })
  assert.equal(channel.getNodeHubUrl?.('node-hub'), 'http://10.0.0.9:3202')
  assert.equal(channel.getNodeHubUrl?.('other-node'), undefined)
})

test('远端 call 错误信封经 redact 脱敏后抛出', { timeout: 60_000 }, async (t) => {
  const secret = '{{NODE_ERR_SECRET}}'
  const fixture = await nodeFixture(t, (req, socket) => {
    socket.end(`${JSON.stringify({ id: req['id'], error: { code: 'agent_blocked', message: `blocked with ${secret}` } })}\n`)
  })
  const { transport, target } = transportOf(fixture, { redact: (s) => s.replaceAll(secret, '[REDACTED]') })
  await assert.rejects(
    transport.call(target, 'agent.prompt', { target: 'w1:p1', text: 'hi' }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'agent_blocked')
      assert.ok(!JSON.stringify(error).includes(secret), '机密不得泄漏')
      return true
    },
  )
})

test('远端长 wait 经通道取消立即结算（底层 Duplex 即刻销毁）', { timeout: 60_000 }, async (t) => {
  const fixture = await nodeFixture(t, () => {
    /* 收到请求后永久静默：模拟无响应的 agent.wait */
  })
  const { transport, target } = transportOf(fixture)
  const controller = new AbortController()
  const pending = transport.call(target, 'agent.wait', { target: 'p1' }, { signal: controller.signal, timeoutMs: undefined })
  const observed = pending.then(() => undefined, (error: unknown) => error)
  await pollUntil(() => fixture.requests.some((r) => r.method === 'agent.wait'), 5_000, 'agent.wait 请求到达节点')
  controller.abort()
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), 3_000)
  })
  const error = await Promise.race([observed, deadline])
  clearTimeout(timer)
  assert.ok(error, '通道取消后长 wait 必须在限期内结算')
  assert.equal((error as { code?: string }).code, 'herdr_aborted')
})

test('远端节点交接文件超限拒绝（herdr_output_too_large），不静默截断', { timeout: 60_000 }, async (t) => {
  const fixture = await nodeFixture(t)
  const root = fixture.root
  await mkdir(join(root, '.helmx'), { recursive: true })
  const big = 'x'.repeat(33 * 1024 * 1024)
  await writeFile(join(root, '.helmx', 'wf-out-huge.md'), big)
  const { transport } = transportOf(fixture)
  await assert.rejects(
    transport.readOutput({ nodeId: 'node-a' }, root, 'wf-out-huge.md'),
    (error: unknown) => (error as { code?: string }).code === 'herdr_output_too_large',
  )
})

test('远端节点软链交接文件拒绝（herdr_output_not_file）', { timeout: 60_000 }, async (t) => {
  const fixture = await nodeFixture(t)
  const root = fixture.root
  await mkdir(join(root, '.helmx'), { recursive: true })
  const outside = join(root, 'outside.json')
  await writeFile(outside, '{}')
  await symlink(outside, join(root, '.helmx', 'wf-out-link.json'))
  const { transport } = transportOf(fixture)
  await assert.rejects(
    transport.readOutput({ nodeId: 'node-a' }, root, 'wf-out-link.json'),
    (error: unknown) => (error as { code?: string }).code === 'herdr_output_not_file',
  )
})

test('LocalNodeChannel 仅承载 local：isOnline 非 local 为 false，getNodeHostEnv/openTunnel/envFor 显式拒绝', { timeout: 60_000 }, async () => {
  const { LocalNodeChannel } = await import('../src/herdr/local-node-channel.js')
  const channel = new LocalNodeChannel()
  assert.equal(channel.isOnline('local'), true)
  assert.equal(channel.isOnline('node-a'), false)
  assert.equal(channel.isOnline('build-box'), false)
  await assert.rejects(
    () => channel.getNodeHostEnv('node-a', { envKeys: ['HERDR_SOCKET_PATH'] }),
    (error: unknown) => error instanceof HelmxError && error.code === 'node_offline' && error.status === 409,
  )
  await assert.rejects(
    () => channel.openTunnel('node-a', { socketPath: '/tmp/a.sock' }),
    (error: unknown) => error instanceof HelmxError && error.code === 'node_offline' && error.status === 409,
  )
  assert.throws(() => channel.envFor('node-a', '/tmp'))
})

test('Windows 端点规则：pathcvt 只拼接前缀，不替换冒号/斜杠（interprocess 2.4.2 源码推导）', { timeout: 60_000 }, async () => {
  const { windowsPipeNameOf, connectHerdrEndpoint } = await import('../src/herdr/local-node-channel.js')
  const marker = 'C:\\Users\\a\\AppData\\Roaming\\herdr\\herdr.sock'
  const pipe = windowsPipeNameOf(marker)
  assert.equal(pipe, '\\\\.\\pipe\\' + marker, '按真实规则：前缀 + 原始 marker 路径，冒号原样保留')
  assert.ok(pipe.includes(':'), '冒号不替换（旧实现替换为下划线是伪造规则）')
  assert.equal(windowsPipeNameOf('C:/Users/a/herdr.sock'), '\\\\.\\pipe\\C:\\Users\\a\\herdr.sock')
  assert.equal(windowsPipeNameOf('\\\\.\\pipe\\herdr-sock'), '\\\\.\\pipe\\herdr-sock')
  assert.equal(windowsPipeNameOf('\\\\CHARA\\pipe\\remote-pipe'), '\\\\CHARA\\pipe\\remote-pipe')
  const socket = connectHerdrEndpoint('C:\\Users\\a\\herdr.sock', 'named-pipe')
  socket.destroy()
})

test('跨平台路径纯规则：Windows 形状选 win32，根目录 containment 不多加分隔', { timeout: 60_000 }, async () => {
  const { pathContains, isWindowsShapedPath, isAbsoluteAnyPath } = await import('../src/herdr/transport.js')
  assert.equal(isWindowsShapedPath('C:\\a'), true)
  assert.equal(isWindowsShapedPath('C:/a'), true)
  assert.equal(isWindowsShapedPath('\\\\srv\\share'), true)
  assert.equal(isWindowsShapedPath('/posix'), false)
  assert.equal(isAbsoluteAnyPath('C:\\work'), true)
  assert.equal(isAbsoluteAnyPath('C:relative'), false)
  assert.equal(isAbsoluteAnyPath('\\\\srv\\share\\w'), true)
  assert.equal(isAbsoluteAnyPath('/work'), true)
  assert.equal(isAbsoluteAnyPath('rel'), false)
  assert.equal(pathContains('/', '/foo'), true)
  assert.equal(pathContains('/work', '/work/.helmx'), true)
  assert.equal(pathContains('/work', '/workshop'), false, '前缀相同但非子路径不得包含')
  assert.equal(pathContains('C:\\work', 'C:\\work\\.helmx'), true)
  assert.equal(pathContains('C:\\work', 'C:\\workshop'), false)
  assert.equal(pathContains('\\\\srv\\share', '\\\\srv\\share\\helmx'), true)
})

test('远端节点订阅走统一 Duplex NDJSON：ACK 在 herdr 内校验，ACK 前事件保序、后续事件分发、迟到 id 帧显式报错', { timeout: 60_000 }, async (t) => {
  const fixture = await nodeFixture(t)
  const [clientSide, serverSide] = duplexPair()
  let serverClosed = false
  serverSide.once('close', () => { serverClosed = true })

  let subBuf = ''
  serverSide.on('data', (chunk: Buffer) => {
    subBuf += chunk.toString('utf8')
    const nl = subBuf.indexOf('\n')
    if (nl < 0) return
    const request = JSON.parse(subBuf.slice(0, nl)) as { id: string; method: string; params: { subscriptions: unknown[] } }
    assert.equal(request.id, 'sub')
    assert.equal(request.method, 'events.subscribe')
    assert.equal(request.params.subscriptions.length, 8)
    // 事件帧在 ACK 之前到达：统一 Duplex 订阅必须按序分发不丢弃。
    serverSide.write(`${JSON.stringify({ event: 'pane_updated', data: { pane: { pane_id: 'w1:p0' } } })}\n`)
    serverSide.write(`${JSON.stringify({ id: 'sub', result: { type: 'subscription_started' } })}\n`)
  })

  const channel: HerdrNodeChannel = {
    isOnline: () => true,
    getNodeHubUrl: () => undefined,
    getNodeHostEnv: async () => ({
      platform: 'linux',
      homeDir: '/home/u',
      tempDir: '/tmp',
      dirs: { home: '/home/u' },
      env: { HERDR_SOCKET_PATH: fixture.socketPath },
    }),
    openTunnel: async () => clientSide,
    envFor: (_id, cwd) => fixture.channel.envFor('local', cwd),
  }

  const transport = createHerdrTransport({ nodeChannel: channel })
  const errors: unknown[] = []
  const received: string[] = []
  const stop = await transport.subscribe(
    { nodeId: 'node-sub' },
    (event) => {
      if ('paneId' in event) received.push(`${event.type}:${event.paneId}`)
    },
    (error) => errors.push(error),
  )

  serverSide.write(`${JSON.stringify({ event: 'pane_closed', data: { pane_id: 'w1:p3' } })}\n`)
  serverSide.write(`${JSON.stringify({ event: 'pane_focused', data: { pane_id: 'w1:p4' } })}\n`)
  await pollUntil(() => received.length === 3, 5_000, '3 条订阅事件按序送达')
  assert.deepEqual(received, ['pane.updated:w1:p0', 'pane.closed:w1:p3', 'pane.focused:w1:p4'])
  assert.equal(errors.length, 0)

  // 迟到 id 帧：ACK 已完成，此处属协议违约，显式报错且只触发一次。
  serverSide.write(`${JSON.stringify({ id: 'sub', result: { type: 'subscription_started' } })}\n`)
  await pollUntil(() => errors.length === 1, 5_000, '迟到 id 帧上报 herdr_protocol')
  assert.equal((errors[0] as { code?: string }).code, 'herdr_protocol')
  stop()
  await pollUntil(() => serverClosed || clientSide.destroyed, 5_000, 'stop 销毁远端隧道 Duplex')
})
