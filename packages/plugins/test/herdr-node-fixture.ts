/**
 * 测试共享：基于真实本地 Unix Socket + LocalNodeChannel 的节点通道 fixture。
 * 协议边界、目标节点 hostEnv 发现、受控 socketPath 隧道、取消、限额均经
 * 真实生产代码路径（createHerdrTransport + LocalNodeChannel）验证。
 *
 * LocalNodeChannel 仅承载 'local' 节点（isOnline/拒绝语义收紧）；远端节点
 * 由 MutableNodeChannel 组合（目标节点 hostEnv 发现 + openTunnel({ socketPath })，
 * 与 EnvFabric 远端通道同构）。
 */
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import {
  HelmxError,
  type NodeHostEnv,
  type NodeHostEnvQuery,
  type NodeTunnelTarget,
} from '@helmx/protocol'
import { LocalNodeChannel } from '../src/herdr/local-node-channel.js'
import type { HerdrNodeChannel } from '../src/herdr/contracts.js'

export interface NodeFixture {
  /** 临时根目录（测试自清理）。 */
  root: string
  /** 目标节点的 Herdr UDS 路径。 */
  socketPath: string
  /** 已收到的一行请求（JSON）。 */
  requests: Array<{ id: string; method: string; params: Record<string, unknown> }>
  /** 连接存活追踪（取消语义断言用）。 */
  sockets: Set<Socket>
  server: Server
  /** 节点通道实现（真实 LocalNodeChannel，协议同构；仅承载 'local'）。 */
  channel: HerdrNodeChannel
  close(): Promise<void>
}

/**
 * 可编程响应服务器 + 节点通道。
 * respond 收到（请求对象, socket）；缺省应答 `{id: req.id, result:{type:'ok'}}`。
 */
export async function nodeFixture(
  t: TestContext,
  respond: (request: Record<string, unknown>, socket: Socket) => void = (req, socket) => {
    socket.end(`${JSON.stringify({ id: req['id'] ?? '1', result: { type: 'ok' } })}\n`)
  },
): Promise<NodeFixture> {
  const root = await mkdtemp(join(tmpdir(), 'helmx-node-channel-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const socketPath = join(root, 'herdr.sock')
  const requests: Array<{ id: string; method: string; params: Record<string, unknown> }> = []
  const sockets = new Set<Socket>()
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    let input = ''
    socket.on('data', (chunk) => {
      input += chunk.toString('utf8')
      let newline = input.indexOf('\n')
      while (newline >= 0) {
        const line = input.slice(0, newline)
        input = input.slice(newline + 1)
        newline = input.indexOf('\n')
        const request = JSON.parse(line) as { id: string; method: string; params: Record<string, unknown> }
        requests.push(request)
        respond(request, socket)
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  })
  const close = async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    await rm(root, { recursive: true, force: true })
  }
  const channel = new LocalNodeChannel()
  return { root, socketPath, requests, sockets, server, channel, close }
}

export interface MutableNodeEntry {
  online: boolean
  hubUrl?: string
  /** Optional target-node host env snapshot override (simulates remote Linux/Windows nodes). */
  hostEnv?: NodeHostEnv
  channel: HerdrNodeChannel
}

/**
 * 可变注册的节点注册表 fixture：按 nodeId 提供在线状态、hubUrl、目标节点 hostEnv 与底层隧道；
 * 未注册节点视为离线（transport 显式报 herdr_node_offline，绝不回退本机）。
 * 'local' 委托真实 LocalNodeChannel；注册的远端节点经 relabelChannel 包装：
 * 协议/隧道/文件/执行全部走真实实现，仅 nodeId 换标。
 */
export class MutableNodeChannel implements HerdrNodeChannel {
  readonly nodes = new Map<string, MutableNodeEntry>()
  private readonly local = new LocalNodeChannel()
  /** openTunnel 实际收到的靶点记录（远端端点纪律断言用）。 */
  readonly seenTunnelInputs: Array<{ nodeId: string; target: NodeTunnelTarget }> = []
  /** getNodeHostEnv 实际收到的查询记录（目标节点环境发现断言用）。 */
  readonly seenHostEnvQueries: Array<{ nodeId: string; query?: NodeHostEnvQuery }> = []

  isOnline(nodeId: string): boolean {
    if (nodeId === 'local') return true
    return this.nodes.get(nodeId)?.online ?? false
  }

  getNodeHubUrl(nodeId: string): string | undefined {
    return this.nodes.get(nodeId)?.hubUrl
  }

  nodePlatform(nodeId: string): string | undefined {
    if (nodeId === 'local') return process.platform
    const node = this.nodes.get(nodeId)
    return node?.hostEnv?.platform ?? node?.channel.nodePlatform?.(nodeId)
  }

  async getNodeHostEnv(nodeId: string, query?: NodeHostEnvQuery, signal?: AbortSignal): Promise<NodeHostEnv> {
    if (nodeId !== 'local') this.seenHostEnvQueries.push({ nodeId, query })
    if (nodeId === 'local') return this.local.getNodeHostEnv('local', query, signal)
    const node = this.nodes.get(nodeId)
    if (node === undefined || !node.online) {
      throw new HelmxError('node_offline', `node '${nodeId}' is offline`, 409, { nodeId })
    }
    if (node.hostEnv !== undefined) {
      const requested = new Set(query?.envKeys ?? [])
      const filteredEnv: Record<string, string> = {}
      for (const key of requested) {
        const value = node.hostEnv.env[key]
        if (value !== undefined) filteredEnv[key] = value
      }
      return {
        ...node.hostEnv,
        dirs: { ...node.hostEnv.dirs },
        env: filteredEnv,
      }
    }
    return this.channelOf(nodeId)!.getNodeHostEnv(nodeId, query, signal)
  }

  async openTunnel(nodeId: string, target: NodeTunnelTarget, signal?: AbortSignal) {
    if (nodeId !== 'local') this.seenTunnelInputs.push({ nodeId, target })
    if (nodeId === 'local') return this.local.openTunnel('local', target, signal)
    const node = this.nodes.get(nodeId)
    if (node === undefined || !node.online) {
      throw new HelmxError('node_offline', `node '${nodeId}' is offline`, 409, { nodeId })
    }
    return this.channelOf(nodeId)!.openTunnel(nodeId, target, signal)
  }

  envFor(nodeId: string, cwd: string) {
    const target = this.channelOf(nodeId)
    if (target === undefined) throw new HelmxError('node_offline', `node '${nodeId}' unknown`, 409, { nodeId })
    return target.envFor(nodeId, cwd)
  }

  private channelOf(nodeId: string): HerdrNodeChannel | undefined {
    if (nodeId === 'local') return this.local
    const node = this.nodes.get(nodeId)
    if (node === undefined) return undefined
    return node.channel instanceof LocalNodeChannel ? relabelChannel(node.channel, nodeId) : node.channel
  }
}

/**
 * nodeId 换标适配器：把仅承载 'local' 的真实 LocalNodeChannel 以目标远端 nodeId
 * 对外暴露（协议/隧道/文件/执行零改动；fixture 模拟 EnvFabric 远端节点的同构形态）。
 */
export function relabelChannel(local: HerdrNodeChannel, nodeId: string): HerdrNodeChannel {
  return {
    isOnline: (id) => id === nodeId && local.isOnline('local'),
    getNodeHubUrl: () => undefined,
    getNodeHostEnv: (_id, query, signal) => local.getNodeHostEnv('local', query, signal),
    openTunnel: (_id, target, signal) => local.openTunnel('local', target, signal),
    envFor: (_id, cwd) => local.envFor('local', cwd),
  }
}

/** 临时目录（含 .helmx）。 */
export async function tempRoot(t: TestContext, prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, '.helmx'), { recursive: true })
  return root
}

/** 轮询直至条件满足或超时（显式失败，不静默跳过）。 */
export async function pollUntil(predicate: () => Promise<boolean> | boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`${label} 未在 ${timeoutMs}ms 内满足`)
}
