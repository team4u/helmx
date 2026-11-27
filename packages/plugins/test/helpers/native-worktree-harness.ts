/**
 * `native-worktree-*.test.ts` 共享测试夹具与端口适配基座。
 *
 * 集中封装本机真实 Git/NodeExecutionEnv 端口（`localNodePorts`）、真实 SDK Harness
 * （`openSpawnHarness`）、插件宿主（`openWorkflowPluginHost` / `executeCleanupTool`）及
 * 确定性隔离并发夹具（`makeFakeIsolation`），供拆分后的 allocation / cleanup / isolation
 * 三个测试文件并行运行复用。
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { Harness, createRegistry } from '@earendil-works/pi-durable'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { MemoryStorage } from '@earendil-works/pi-durable/storage/memory'
import { HelmxError } from '@helmx/protocol'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import {
  ArtifactService,
  createEnvFabric,
  PluginHost,
  SecretStash,
  type PluginHostBackend,
  type PluginKvStore,
} from '@helmx/kernel'
import { actionToolResult, runNativeSpawn, type NativeSpawnDeps } from '@helmx/kernel/testing'
import { createPluginBuildProvider } from '@helmx/plugin-build'
import { WorktreeAllocator, type ManagedWorktreeRecord } from '../../src/worktree/worktree.js'
import {
  LEASES_KV_NAMESPACE,
  WORKTREES_KV_NAMESPACE,
  type WorktreeLeaseRecord,
} from '../../src/worktree/worktree-store.js'
import { WorktreeIsolation, type WorktreeIsolationDeps } from '../../src/worktree/isolation.js'
import { createWorkflowPlugin } from '../../src/workflow.js'
import { createWorktreePlugin } from '../../src/worktree.js'
import { createPluginHostBackendFixture } from '../../../kernel/test/helpers/plugin-host-backend.js'
import {
  createMemoryWorktreeKv,
  makeConversationSummary,
  makeFauxModels,
  MemoryDocStore,
  MemoryKvStore,
  type FauxProviderHandle,
} from './plugin-test-env.js'

export { createPluginHostBackendFixture as createWorktreeHostBackendFixture }

/**
 * 平台事实：进程占用扫描当前仅实现 Linux /proc。测试契约按平台如实分叉：
 * 非 Linux 上 cleanup 在进程检查处默认显式拒绝（501 worktree_usage_unverifiable）
 * ——不伪造 complete=true、不静默跳过；这是当前跨平台行为限制的如实断言。
 */
export const PROCESS_SCAN_ON = process.platform === 'linux'

/** 非 Linux 平台断言 cleanup 显式拒绝（进程占用扫描不支持，不伪造 0 占用）。 */
export async function assertCleanupPlatformRejected(fn: () => Promise<unknown>): Promise<void> {
  await assert.rejects(fn, (err: unknown) => {
    assert.ok(err instanceof HelmxError)
    assert.equal(err.code, 'worktree_usage_unverifiable', '非 Linux 平台：进程占用扫描不支持，cleanup 必须显式拒绝')
    assert.equal(err.status, 501)
    return true
  })
}

/**
 * 本机真实执行端口适配（无 mock）：exec 走 NodeExecutionEnv 真实 argv
 * 执行；exists/canonicalPath 走同 env 真实 fs。与生产（ctx.host.execEnv /
 * executionEnv exists/canonicalPath）同契约，供 allocator 直建测试使用。
 */
export function localNodePorts() {
  const envOf = (cwd: string) => new NodeExecutionEnv({ cwd })
  return {
    exec: async (
      _nodeId: string,
      cwd: string,
      args: readonly string[],
      options?: { timeoutMs?: number; signal?: AbortSignal },
    ) => {
      let output = ''
      const res = await envOf(cwd).exec(
        [...args],
        {
          cwd,
          ...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs / 1000 } : {}),
          onOutput: (text: string) => {
            output += text
          },
        },
        BACKGROUND_CONTEXT,
      )
      if (!res.ok) {
        return { ok: false, exitCode: null, output, timedOut: res.error.code === 'timeout' }
      }
      return { ok: res.value.exitCode === 0, exitCode: res.value.exitCode, output, timedOut: false }
    },
    nodeExists: (_nodeId: string, path: string) => envOf(path).exists(path, BACKGROUND_CONTEXT),
    nodeCanonicalPath: (_nodeId: string, path: string) => envOf(path).canonicalPath(path, BACKGROUND_CONTEXT),
  }
}

/** 真实 SDK Harness（MemoryStorage）+ faux provider + 完整 NativeSpawnDeps（spawn-ask 同构）。 */
export async function openSpawnHarness(repoDir: string, dataDir: string): Promise<{
  harness: Harness
  deps: NativeSpawnDeps
  faux: FauxProviderHandle
  allocator: WorktreeAllocator
  isolation: WorktreeIsolation
  spawnIsolated: (request: Record<string, unknown>) => Promise<unknown>
  markIdle: (childId: number) => void
  markWorking: (childId: number) => void
  mirrors: Map<number, { profileId: string; cwd: string; model: string; modelOverride?: string; title: string; tags: string[]; createdAt: number }>
  kvStore: MemoryKvStore
  close(): Promise<void>
}> {
  const { models, faux } = makeFauxModels()
  const storage = new MemoryStorage()
  const registry = createRegistry()
  const harness = await Harness.open(
    storage,
    { models: () => models, registry },
    BACKGROUND_CONTEXT,
  )

  const stash = new SecretStash()
  const parents = new Map<number, number>()
  const lastTexts = new Map<number, string>()
  const observers = new Map<number, () => void>()
  const mirrors = new Map<
    number,
    { profileId: string; cwd: string; model: string; modelOverride?: string; title: string; tags: string[]; createdAt: number }
  >()

  const envFabric = createEnvFabric({})
  const kvStore = new MemoryKvStore()
  const worktreeKv = createMemoryWorktreeKv(kvStore)
  const working = new Set<number>()
  const allocator = new WorktreeAllocator({
    ...localNodePorts(),
    inspectPathUsage: (nodeId, path, signal) => envFabric.inspectPathUsage(nodeId, path, signal),
    kv: worktreeKv,
    redact: (t) => stash.redact(t),
    isConversationWorking: (id) => working.has(id),
  })
  const isolation = new WorktreeIsolation({
    host: {
      resolveSpawnTarget: async (input) => ({
        nodeId: 'local',
        sourceCwd: input.requestCwd ?? repoDir,
        parentCwd: repoDir,
      }),
      execEnv: async (req) => {
        const env = new NodeExecutionEnv({ cwd: req.cwd ?? repoDir })
        let combined = ''
        const result = await env.exec(
          req.command as string | readonly string[],
          {
            ...(req.cwd !== undefined ? { cwd: req.cwd } : {}),
            ...(req.timeoutMs !== undefined ? { timeout: req.timeoutMs / 1000 } : {}),
            onOutput: (text: string) => {
              combined += text
            },
          },
          BACKGROUND_CONTEXT,
        )
        if (!result.ok) {
          return { ok: false, exitCode: null, output: combined, timedOut: result.error.code === 'timeout' }
        }
        return { ok: result.value.exitCode === 0, exitCode: result.value.exitCode, output: combined, timedOut: false }
      },
      executionEnv: (_nodeId, cwd) => new NodeExecutionEnv({ cwd }),
      inspectNodePathUsage: (input) => envFabric.inspectPathUsage(input.nodeId, input.path, input.signal),
      listActiveSpawnExecutions: () => [],
      redact: (t) => stash.redact(t),
      getConversation: (id: number) => {
        const m = mirrors.get(id)
        if (!m) throw new HelmxError('not_found', `会话不存在：${id}`, 404)
        return { cwd: m.cwd, nodeId: 'local', status: working.has(id) ? 'working' : 'idle' }
      },
    },
    kv: worktreeKv,
  })
  const markIdle = (childId: number): void => {
    working.delete(childId)
  }
  const markWorking = (childId: number): void => {
    working.add(childId)
  }

  const deps: NativeSpawnDeps = {
    dataDir,
    defaultCwd: repoDir,
    hubUrl: 'http://127.0.0.1:3200',
    redact: (t) => stash.redact(t),
    artifacts: new ArtifactService(dataDir, { get: () => undefined, list: () => [], put: () => {}, deleteByConversation: () => {} } as never),
    envFabric,
    harness,
    getLastAssistantText: (id) => lastTexts.get(id),
    resolveModel: () => ({ provider: 'faux', modelId: 'faux-1' }),
    agentSessions: new Map(),
    registerChildConversation: async ({ childId, parentId, profileId, childCwd, modelMirror }) => {
      parents.set(childId, parentId)
      mirrors.set(childId, {
        profileId,
        cwd: childCwd,
        model: modelMirror,
        title: `子代理 ${childId}`,
        tags: [],
        createdAt: Date.now(),
      })
      working.add(childId)
      const conv = await harness.conversation(childId as never, BACKGROUND_CONTEXT)
      if (!conv) return
      const observer = {
        advance: (call: { kind: string; value: { entries: Array<{ kind: string; id: number; model?: ReadonlyArray<{ content?: ReadonlyArray<{ type: string; text?: string }> }> }> } }) => {
          if (call.kind !== 'value') return
          const view = call.value
          for (let i = view.entries.length - 1; i >= 0; i -= 1) {
            const entry = view.entries[i]!
            if (entry.kind !== 'pi.assistant') continue
            const text = (entry.model?.[0]?.content ?? [])
              .filter((b) => b.type === 'text' && typeof b.text === 'string')
              .map((b) => b.text as string)
              .join('\n')
            if (text !== '') {
              lastTexts.set(childId, text)
              break
            }
          }
        },
        end: () => {},
      }
      const observation = await harness.observeConversation(childId as never, observer as never, BACKGROUND_CONTEXT)
      observers.set(childId, () => observation.detach())
    },
    resolveProfile: async (profileId) => {
      if (profileId !== 'assistant') return undefined
      return {}
    },
    getParentOfConversation: (childId) => parents.get(childId),
    getModelOverride: (childId) => mirrors.get(childId)?.modelOverride,
    getConversation: (childId) => {
      const m = mirrors.get(childId)
      if (!m) return undefined
      return {
        id: childId,
        title: m.title,
        profileId: m.profileId,
        tags: m.tags,
        cwd: m.cwd,
        model: m.model,
        thinkingLevel: '',
        status: 'idle' as never,
        stateChangeSeq: 1,
        completionSeq: 0,
        unread: false,
        pinned: false,
        pendingAskCount: 0,
        createdAt: m.createdAt,
        updatedAt: m.createdAt,
      }
    },
    updateConversation: async (childId, patch) => {
      const m = mirrors.get(childId)
      if (!m) throw new HelmxError('not_found', `会话不存在：${childId}`, 404)
      if (patch.cwd !== undefined) m.cwd = patch.cwd
      if (patch.profileId !== undefined) m.profileId = patch.profileId
      if (patch.model !== undefined) m.modelOverride = patch.model
      if (m.modelOverride === undefined) m.model = 'faux/faux-1'
      else m.model = m.modelOverride
      return deps.getConversation(childId)!
    },
    installChildExtension: (extension) => {
      registry.install(extension)
    },
  }
  return {
    harness,
    deps,
    faux,
    allocator,
    isolation,
    spawnIsolated: (request) =>
      isolation.aroundSpawn(request as never, (final) => runNativeSpawn(deps, final)),
    mirrors,
    markIdle,
    markWorking,
    kvStore,
    async close() {
      for (const detach of observers.values()) detach()
      await harness.close(BACKGROUND_CONTEXT)
      await storage.close(BACKGROUND_CONTEXT)
      await envFabric.dispose()
    },
  }
}

/** 读取子会话最近一次提交的 prompt 文本（helmx.input entry 的 user 消息 content）。 */
export async function childPromptText(harness: Harness, childId: number): Promise<string> {
  const conversation = await harness.conversation(childId as never, BACKGROUND_CONTEXT)
  assert.ok(conversation)
  const page = await conversation.entries({ order: 'descending' }, 50, undefined, BACKGROUND_CONTEXT)
  for (const entry of page.items) {
    if (entry.kind !== 'helmx.input') continue
    const model = entry.model ?? []
    let text = ''
    for (const msg of model) {
      if (msg === null || typeof msg !== 'object') continue
      if ((msg as { role?: unknown }).role !== 'user') continue
      const content = (msg as { content?: unknown }).content
      if (typeof content === 'string') text += content
      else if (Array.isArray(content)) {
        for (const block of content) {
          if (block !== null && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
            text += (block as { text?: unknown }).text ?? ''
          }
        }
      }
    }
    if (text !== '') return text
  }
  return ''
}

/** bareAllocator 共用的真实 EnvFabric（local 进程内真实 /proc 扫描）。 */
let bareFabric: ReturnType<typeof createEnvFabric> | undefined
export function bareFabricOf(): ReturnType<typeof createEnvFabric> {
  bareFabric ??= createEnvFabric({})
  return bareFabric
}

/** 直建 allocator（不经 spawn 链）的轻量夹具（共享同一 MemoryKvStore）。 */
export function bareAllocator(
  kvStore: MemoryKvStore,
  extra?: { isPathInUse?: (nodeId: string, path: string) => boolean; redact?: (t: string) => string },
) {
  return new WorktreeAllocator({
    ...localNodePorts(),
    inspectPathUsage: (nodeId, path, signal) => bareFabricOf().inspectPathUsage(nodeId, path, signal),
    kv: createMemoryWorktreeKv(kvStore),
    ...(extra?.redact !== undefined ? { redact: extra.redact } : {}),
    ...(extra?.isPathInUse !== undefined ? { isPathInUse: extra.isPathInUse } : {}),
  })
}

/** 从 KV 读全部受管记录（原始落库内容断言；无条目时空数组）。 */
export function rawRecords(kvStore: MemoryKvStore): ManagedWorktreeRecord[] {
  return kvStore.listParsed<ManagedWorktreeRecord>('builtin:worktree', WORKTREES_KV_NAMESPACE).map((e) => e.value)
}

/** 读取隔离层租约表原始落库内容。 */
export function leasesOf(kvStore: MemoryKvStore): Record<string, { phase: string; worktreeId: string }> {
  return Object.fromEntries(
    kvStore.listParsed<WorktreeLeaseRecord>('builtin:worktree', LEASES_KV_NAMESPACE).map((e) => [e.key, e.value]),
  ) as never
}

export function leaseCount(kvStore: MemoryKvStore): number {
  return kvStore.listParsed('builtin:worktree', LEASES_KV_NAMESPACE).length
}

/** POSIX dirname（测试辅助）。 */
export function dirnameOf(p: string): string {
  const parts = p.split('/')
  parts.pop()
  return parts.join('/') || '/'
}

/** 受控 exec：按命令尾参派发脚本输出，返回直接执行结果形状。 */
export function stubChunkedExec(scriptOf: (args: readonly string[]) => { output: string; exitCode?: number }) {
  const seen: string[][] = []
  let chunkSize = 64
  const exec = async (
    _nodeId: string,
    _cwd: string,
    args: readonly string[],
  ): Promise<{ ok: boolean; exitCode: number; output: string; timedOut: false }> => {
    seen.push([...args])
    const cmdArgs = args[0] === 'git' ? (args[1] === '-C' ? args.slice(3) : args.slice(1)) : args
    const spec = scriptOf(cmdArgs)
    const exitCode = spec.exitCode ?? 0
    void chunkSize
    return { ok: exitCode === 0, exitCode, output: spec.output, timedOut: false }
  }
  return { seen, setChunkSize: (n: number) => (chunkSize = n), exec }
}

/**
 * 经 builtin:worktree 插件工具执行 cleanup_worktree（真实插件内隔离能力：
 * 本地真实 git 端口 + 共享 KV 存储）。kvStore 与 spawn 夹具共享，
 * 使工具清理同一批受管记录。
 */
export async function executeCleanupTool(
  kvStore: MemoryKvStore,
  input: Record<string, unknown>,
): Promise<{
  output: Array<{ type: string; text: string }>
  structuredOutput: Record<string, unknown>
  presentationMeta?: Record<string, unknown>
}> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helmx-wf-tool-'))
  const localExec = async (
    command: string | readonly string[],
    options: { cwd?: string; timeout?: number },
  ): Promise<{ ok: boolean; exitCode: number | null; output: string; timedOut: boolean }> => {
    const env = new NodeExecutionEnv({ cwd: options.cwd ?? dataDir })
    let combined = ''
    const r = await env.exec(command, {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
      onOutput: (t: string) => {
        combined += t
      },
    }, BACKGROUND_CONTEXT)
    if (!r.ok) {
      return { ok: false, exitCode: null, output: combined, timedOut: r.error.code === 'timeout' }
    }
    return { ok: r.value.exitCode === 0, exitCode: r.value.exitCode, output: combined, timedOut: false }
  }
  const backend: PluginHostBackend = {
    ...createPluginHostBackendFixture(),
    dispatchTrigger: async () => {},
    submitInput: async () => {},
    createConversation: async () => ({}) as never,
    listConversations: () => [],
    getConversation: (id: number) =>
      makeConversationSummary({ id, cwd: dataDir, model: '', createdAt: 1, updatedAt: 1 }),
    updateConversation: async () => ({}) as never,
    abortConversation: async () => {},
    getConversationOwnership(id: number): 'helmx' | 'human' {
      return id === 1 ? 'human' : 'helmx'
    },
    spawnAgent: async () => ({}),
    runGate: async () => ({ ok: true, output: '' }),
    resolveSpawnTarget: async () => ({ nodeId: 'local', sourceCwd: dataDir, parentCwd: dataDir }),
    listActiveSpawnExecutions: () => [],
    inspectNodePathUsage: (input: { nodeId: string; path: string; signal?: AbortSignal }) =>
      bareFabricOf().inspectPathUsage(input.nodeId, input.path, input.signal),
    executionEnv: (_nodeId: string, cwd: string) => new NodeExecutionEnv({ cwd }),
    redact: (t: string) => t,
    execEnv: async (req: { command: string | string[]; cwd?: string; timeoutMs?: number }) =>
      localExec(req.command, { ...(req.cwd !== undefined ? { cwd: req.cwd } : {}), ...(req.timeoutMs !== undefined ? { timeout: req.timeoutMs / 1000 } : {}) }),
    manageConversation: () => () => {},
    markConversationOwnership: () => {},
    createAsk: async () => ({}) as never,
    cancelAsk: async () => {},
    onEvent: () => () => {},
    emitEvent: () => {},
  }
  const host = new PluginHost({
    buildProvider: createPluginBuildProvider(),
    dataDir,
    host: backend,
    docs: new MemoryDocStore(),
    kv: kvStore,
    sessionDocs: {
      get: () => undefined,
      put: () => {},
      delete: () => {},
      deletePlugin: () => {},
      listConversationIds: () => [],
      flush: async () => {},
    },
  })
  try {
    await host.register(createWorkflowPlugin())
    await host.register(createWorktreePlugin())
    const spec = host.listTools().find((t) => t.name === 'cleanup_worktree')
    assert.ok(spec, 'cleanup_worktree derived tool must be registered')
    const raw = await host.executeTool('cleanup_worktree', input, { conversationId: 1 })
    const normalized = actionToolResult(raw, input, (text) => text, {
      structuredOutputSchema: spec.structuredOutputSchema,
      presentationMetaSchema: spec.presentationMetaSchema,
      projectPresentationMeta: spec.projectPresentationMeta,
      formatOutput: spec.formatOutput,
      toolName: spec.name,
    })
    return {
      output: normalized.output,
      structuredOutput: normalized.structuredOutput as Record<string, unknown>,
      presentationMeta: normalized.details,
    }
  } finally {
    await host.dispose().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
}

/** 构造完整挂载 builtin:workflow + builtin:worktree 的真实 PluginHost，用于测试隐藏动作与 inUse 门禁。 */
export async function openWorkflowPluginHost(options: {
  repoDir: string
  dataDir: string
  docs: MemoryKvStore
  plugins?: 'both' | 'worktree-only'
  stash?: SecretStash
  onResolveSpawnTarget?: (input: {
    parentConversationId: number
    profileId?: string
    requestNodeId?: string
    requestCwd?: string
    fork?: boolean
  }) => void
  onFlush?: () => void
}): Promise<{
  host: PluginHost
  globalDocs: MemoryDocStore
  close(): Promise<void>
}> {
  const stash = options.stash ?? new SecretStash()
  const localExec = async (
    command: string | readonly string[],
    execOpts: { cwd?: string; timeout?: number },
  ): Promise<{ ok: boolean; exitCode: number | null; output: string; timedOut: boolean }> => {
    const env = new NodeExecutionEnv({ cwd: execOpts.cwd ?? options.repoDir })
    let combined = ''
    const r = await env.exec(
      command,
      {
        ...(execOpts.cwd !== undefined ? { cwd: execOpts.cwd } : {}),
        ...(execOpts.timeout !== undefined ? { timeout: execOpts.timeout } : {}),
        onOutput: (t: string) => {
          combined += t
        },
      },
      BACKGROUND_CONTEXT,
    )
    if (!r.ok) {
      return { ok: false, exitCode: null, output: combined, timedOut: r.error.code === 'timeout' }
    }
    return { ok: r.value.exitCode === 0, exitCode: r.value.exitCode, output: combined, timedOut: false }
  }
  const backend: PluginHostBackend = {
    ...createPluginHostBackendFixture(),
    dispatchTrigger: async () => {},
    submitInput: async () => {},
    createConversation: async () => ({}) as never,
    listConversations: () => [],
    getConversation: (id: number) =>
      makeConversationSummary({ id, cwd: options.repoDir, model: '', createdAt: 1, updatedAt: 1 }),
    updateConversation: async () => ({}) as never,
    abortConversation: async () => {},
    getConversationOwnership: (id: number) => (id === 1 ? 'human' : 'helmx'),
    spawnAgent: async () => ({}),
    runGate: async () => ({ ok: true, output: '' }),
    resolveSpawnTarget: async (input) => {
      options.onResolveSpawnTarget?.(input)
      return {
        nodeId: input.requestNodeId ?? 'local',
        sourceCwd: input.requestCwd ?? options.repoDir,
        parentCwd: options.repoDir,
      }
    },
    listActiveSpawnExecutions: () => [],
    inspectNodePathUsage: (input) =>
      bareFabricOf().inspectPathUsage(input.nodeId, input.path, input.signal),
    executionEnv: (_nodeId: string, cwd: string) => new NodeExecutionEnv({ cwd }),
    redact: (t: string) => stash.redact(t),
    execEnv: async (req: { command: string | string[]; cwd?: string; timeoutMs?: number }) =>
      localExec(req.command, {
        ...(req.cwd !== undefined ? { cwd: req.cwd } : {}),
        ...(req.timeoutMs !== undefined ? { timeout: req.timeoutMs / 1000 } : {}),
      }),
    manageConversation: () => () => {},
    markConversationOwnership: () => {},
    createAsk: async () => ({}) as never,
    cancelAsk: async () => {},
    onEvent: () => () => {},
    emitEvent: () => {},
  }
  const globalDocs = new MemoryDocStore()
  const kvStore: PluginKvStore = {
    get: (p, ns, k) => options.docs.get(p, ns, k),
    put: (p, ns, k, v) => options.docs.put(p, ns, k, v),
    delete: (p, ns, k) => options.docs.delete(p, ns, k),
    list: (p, ns, o) => options.docs.list(p, ns, o),
    clearNamespace: (p, ns) => options.docs.clearNamespace(p, ns),
    deletePlugin: (p) => options.docs.deletePlugin(p),
    flush: async () => {
      await options.docs.flush()
      options.onFlush?.()
    },
  }
  const host = new PluginHost({
    buildProvider: createPluginBuildProvider(),
    dataDir: options.dataDir,
    host: backend,
    redactText: (t) => stash.redact(t),
    docs: globalDocs,
    kv: kvStore,
    sessionDocs: {
      get: () => undefined,
      put: () => {},
      delete: () => {},
      deletePlugin: () => {},
      listConversationIds: () => [],
      flush: async () => {},
    },
  })
  if (options.plugins !== 'worktree-only') await host.register(createWorkflowPlugin())
  await host.register(createWorktreePlugin())
  return {
    host,
    globalDocs,
    close: async () => {
      await host.dispose().catch(() => {})
    },
  }
}

export interface FakeIsolationOptions {
  gatedExistsPath?: string
  existsValue?: boolean
  failFlushFirst?: number
}

export interface FakeIsolationHandle {
  isolation: WorktreeIsolation
  kvStore: MemoryKvStore
  probeEntered: Promise<void>
  releaseProbe(): void
  execCalls: Array<{ command: string | string[]; cwd?: string }>
}

export function makeFakeIsolation(options: FakeIsolationOptions = {}): FakeIsolationHandle {
  let flushes = 0
  const kvStore = new MemoryKvStore({
    onFlush: async () => {
      flushes++
      if (options.failFlushFirst !== undefined && flushes <= options.failFlushFirst) {
        throw new Error('simulated kv flush failure')
      }
    },
  })
  let releaseProbe: () => void = () => {}
  let probeEnteredNotify: () => void = () => {}
  const probeEntered = new Promise<void>((resolve) => {
    probeEnteredNotify = resolve
  })
  const gatedPath = options.gatedExistsPath
  let gateConsumed = false
  const execCalls: FakeIsolationHandle['execCalls'] = []
  return {
    kvStore,
    probeEntered,
    releaseProbe: () => releaseProbe(),
    execCalls,
    isolation: new WorktreeIsolation({
      host: {
        resolveSpawnTarget: async (input) => ({
          nodeId: 'local',
          sourceCwd: input.requestCwd ?? '/repo',
          parentCwd: '/repo',
        }),
        execEnv: async (req) => {
          execCalls.push({ command: req.command, cwd: req.cwd })
          return { ok: true, exitCode: 0, output: 'true\n', timedOut: false }
        },
        executionEnv: ((_nodeId: string, _cwd: string) =>
          ({
            exists: async (path: string) => {
              if (gatedPath !== undefined && path === gatedPath && !gateConsumed) {
                gateConsumed = true
                probeEnteredNotify()
                await new Promise<void>((resolve) => {
                  releaseProbe = resolve
                })
              }
              return { ok: true, value: options.existsValue ?? true } as const
            },
            canonicalPath: async (path: string) => ({ ok: true, value: path } as const),
          }) as never) as WorktreeIsolationDeps['host']['executionEnv'],
        listActiveSpawnExecutions: () => [],
        redact: (text) => text,
        inspectNodePathUsage: async (input: { nodeId: string; path: string }) => ({
          path: input.path,
          processes: [],
          matchedTotal: 0,
          processesTruncated: false,
          complete: true,
          unobservable: 0,
          diagnostics: [],
        }),
        getConversation: () => ({ cwd: gatedPath ?? '/repo', nodeId: 'local', status: 'idle' }),
      },
      kv: createMemoryWorktreeKv(kvStore),
    }),
  }
}
