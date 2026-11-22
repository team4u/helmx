/**
 * 插件行为级边界回归：
 *
 * 1. profiles-skills：MEMORY.md 大小防线收敛到 ProfileService.updateMemory
 *    文件锁内（合并后检查）——跨实例并发 append 不可能叠加突破上限；
 *    save(memory)（HTTP/CLI 唯一写入路径）同限拒绝，不写半截；
 * 2. assistant：update_memory 并发（同 Profile 双会话）最终内容 ≤ 上限且
 *    超限方显式 memory_limit_exceeded；资产缺失时向模型注入显式
 *    assets-missing 节（不沉默换人格）+ 每文件独立告警去重与恢复后可重新告警；
 * 3. profile：restrictToCwd 开启时注入 workspace_boundary 边界声明。
 *
 * 组合纪律：真实插件代码路径 + 受控 PluginHost backend；profile 边界用真实
 * ProfileService 临时目录验证纯文件行为。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HelmxError, type ConversationSummary } from '@helmx/protocol'
import { PluginHost, type PluginHostBackend } from '../../kernel/src/plugins/index.js'
import { hostBackendStub } from '../../kernel/test/helpers/host-backend-stub.js'
import { createProfilePlugin } from '../src/profile.js'
import { createMemoryPlugin, MAX_MEMORY_CHARS as MEM_MAX, MemoryStore } from '../src/memory.js'
import { createProfileFileHost } from '../../kernel/test/helpers/profile-file-host.js'
import { createPluginHostBackendFixture } from '../../kernel/test/helpers/plugin-host-backend.js'
import { ProfileService } from '../../kernel/src/services/index.js'
import { createPluginBuildProvider } from '@helmx/plugin-build'
import { MemoryDocStore, makeConversationSummary } from './helpers/plugin-test-env.js'

// ---------------------------------------------------------------------------
// 共享基建
// ---------------------------------------------------------------------------

const makeConversation = (id: number, over: Partial<ConversationSummary> = {}): ConversationSummary =>
  makeConversationSummary({ id, ...over })

interface ControlledBackend {
  conversations: Map<number, ConversationSummary>
  notifications: Array<{ title: string; body: string; level: string }>
  submits: Array<{ conversationId: number; origin?: string }>
  /** 会话级失败注入：createConversation 后首个副作用（markOwnership）抛错。 */
  failMarkOwnershipFor: Set<number>
  /** submitInput 拒绝规则。 */
  submitRejector: ((conversationId: number) => Error | undefined) | undefined
}

function makeControlledBackend(dataDir: string): ControlledBackend & PluginHostBackend {
  const conversations = new Map<number, ConversationSummary>()
  conversations.set(1, makeConversation(1, { tags: ['root'] }))
  const notifications: Array<{ title: string; body: string; level: string }> = []
  const submits: Array<{ conversationId: number; origin?: string }> = []
  // 真实 ProfileService/SkillService（临时目录）：自举资产走真实文件路径。
  // profiles/skills 子端口复用 createProfileFileHost 的公共适配（含
  // FileNotFoundError -> HelmxError not_found 的边界转换，插件侧据此判定
  // 资产缺失）。
  const fileHost = createProfileFileHost(dataDir)
  const rawBackend: ControlledBackend & Partial<PluginHostBackend> = {
    ...createPluginHostBackendFixture(),
    ...createProfileFileHost(dataDir),
    profiles: fileHost.profiles,
    skills: fileHost.skills,
    getConversationDetail: async (id: number) => ({ ...makeConversation(id), entries: [] }) as never,
    listArtifacts: async () => [],
    redact: (t: string) => t,
    conversations,
    notifications,
    submits,
    failMarkOwnershipFor: new Set(),
    submitRejector: undefined,
    async dispatchTrigger() {},
    async submitInput(conversationId, _text, opts) {
      submits.push({ conversationId, origin: opts?.origin })
      const rejection = this.submitRejector?.(conversationId)
      if (rejection !== undefined) throw rejection
    },
    async createConversation(init) {
      const id = Math.max(0, ...conversations.keys()) + 1
      const summary = makeConversation(id, {
        title: init.title ?? 'new',
        profileId: init.profileId ?? 'assistant',
        ...(init.tags !== undefined ? { tags: init.tags } : {}),
        ...(init.parentConversationId !== undefined ? { parentConversationId: init.parentConversationId } : {}),
      })
      conversations.set(id, summary)
      return summary
    },
    listConversations() { return [...conversations.values()] },
    getConversation(id) {
      const found = conversations.get(id)
      if (!found) throw new HelmxError('not_found', `会话不存在：${id}`, 404, { conversationId: id })
      return found
    },
    async updateConversation(id, patch) {
      const found = conversations.get(id)
      if (!found) throw new HelmxError('not_found', `会话不存在：${id}`, 404)
      const next = { ...found, ...patch }
      conversations.set(id, next)
      return next
    },
    manageConversation() { return () => {} },
    markConversationOwnership(id) {
      if (this.failMarkOwnershipFor.has(id)) {
        throw new HelmxError('document_store_failed', '测试注入：归属标记写入失败', 500)
      }
    },
    async createAsk() { throw new HelmxError('unsupported', 'test', 400) },
    async cancelAsk() {},
    onEvent() { return () => {} },
    getConversationOwnership: () => 'human',
    abortConversation: async () => {},
    spawnAgent: async () => ({}),
    runGate: async () => ({ ok: true, output: '' }),
    execEnv: async () => { throw new HelmxError('unsupported', '本 fixture 不执行节点命令', 501) },
    emitEvent(type, payload) {
      if (type === 'notification') notifications.push(payload as { title: string; body: string; level: string })
    },
  }
  return Object.assign(hostBackendStub(), rawBackend) as ControlledBackend & PluginHostBackend
}

// ---------------------------------------------------------------------------
// 1. MemoryStore：锁内大小防线（并发 append 不可叠加突破；无绕过上限参数）
// ---------------------------------------------------------------------------

test('memory：并发 append（跨实例、锁内合并检查）最终不超上限且超限方显式拒绝', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helmx-mem-limit-'))
  try {
    // 预置接近上限：剩余空间只够一次追加。
    const base = new MemoryStore(createProfileFileHost(dataDir))
    await base.ensureMemory('assistant')
    await base.updateMemory('assistant', 'x'.repeat(MEM_MAX - 1_000), 'replace')

    // 跨实例并发 append（每个都单独看是合法的 800 字符）：合并后必有一笔超限。
    const stores = Array.from({ length: 4 }, () => new MemoryStore(createProfileFileHost(dataDir)))
    const outcomes = await Promise.allSettled(
      stores.map((store) => store.updateMemory('assistant', 'y'.repeat(800), 'append')),
    )
    const rejected = outcomes.filter((o) => o.status === 'rejected')
    // 4 笔 × 800 = 3200 > 1000 余量：至少一笔被锁内拒绝；全部成功即防线失效。
    assert.ok(rejected.length >= 1, `至少一笔 append 应被锁内拒绝（实际 ${rejected.length} 笔被拒）`)
    for (const r of rejected) {
      assert.ok(r.reason instanceof HelmxError, '拒绝应是 HelmxError')
      assert.equal(r.reason.code, 'memory_limit_exceeded')
      assert.equal(r.reason.status, 400)
      assert.ok(/replace/.test(r.reason.message), '错误信息应提示 replace 整理')
    }
    // 最终文件 ≤ 上限（锁内串行合并，绝不写半截超限内容）。
    const final = await base.getMemory('assistant')
    assert.ok(final.length <= MEM_MAX, `最终内容 ${final.length} 不得超过上限`)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('memory：set 动作超限在写盘前拒绝（MEMORY.md 不半截写入）', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helmx-mem-save-'))
  try {
    const profiles = new ProfileService(dataDir)
    await profiles.ensureDefault()
    const backend = makeControlledBackend(dataDir)
    const host = new PluginHost({ buildProvider: createPluginBuildProvider(), dataDir, host: backend, docs: new MemoryDocStore() })
    await host.register(createMemoryPlugin(), { enabled: true })
    await assert.rejects(
      () => host.invokeAction('builtin:memory', 'set', { profileId: 'assistant', text: 'M'.repeat(MEM_MAX + 1) }),
      (err: unknown) => err instanceof HelmxError && err.code === 'memory_limit_exceeded' && err.status === 400,
    )
    // MEMORY.md 未被创建（超限拒绝不留半截）。
    const memoryExists = existsSync(join(dataDir, 'profiles', 'assistant', 'MEMORY.md'))
    assert.ok(!memoryExists || !(await new MemoryStore(createProfileFileHost(dataDir)).getMemory('assistant')).startsWith('M'.repeat(100)), '超限 memory 不得落盘')
    // 合法大小（恰在上限）通过。
    await host.invokeAction('builtin:memory', 'set', { profileId: 'assistant', text: 'M'.repeat(MEM_MAX) })
    assert.equal((await new MemoryStore(createProfileFileHost(dataDir)).getMemory('assistant')).length, MEM_MAX)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('memory：写入路径无绕过上限参数（任何调用均强制 4k）', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helmx-mem-nolimit-'))
  try {
    const store = new MemoryStore(createProfileFileHost(dataDir))
    await store.ensureMemory('assistant')
    // MemoryStore 公开 API 无 maxChars 参数：超限即拒绝，无「不设限」路径。
    await assert.rejects(
      () => store.updateMemory('assistant', 'x'.repeat(MEM_MAX + 100), 'replace'),
      (err: unknown) => err instanceof HelmxError && err.code === 'memory_limit_exceeded',
    )
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 2. memory：update_memory 并发 + 资产缺失的模型可见告知
// ---------------------------------------------------------------------------

test('memory：同 Profile 双会话并发 update_memory append 最终不超上限', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helmx-memory-conc-'))
  try {
    const profiles = new ProfileService(dataDir)
    await profiles.ensureDefault()
    await new MemoryStore(createProfileFileHost(dataDir)).updateMemory('assistant', 'x'.repeat(MEM_MAX - 1_000), 'replace')
    const backend = makeControlledBackend(dataDir)
    backend.conversations.set(10, makeConversation(10))
    backend.conversations.set(20, makeConversation(20))
    const host = new PluginHost({ buildProvider: createPluginBuildProvider(), dataDir, host: backend, docs: new MemoryDocStore() })
    await host.register(createMemoryPlugin(), { enabled: true })

    const outcomes = await Promise.allSettled([
      host.executeTool('update_memory', { text: 'y'.repeat(800), mode: 'append' }, { conversationId: 10 }),
      host.executeTool('update_memory', { text: 'z'.repeat(800), mode: 'append' }, { conversationId: 20 }),
      host.executeTool('update_memory', { text: 'w'.repeat(800), mode: 'append' }, { conversationId: 1 }),
    ])
    const rejected = outcomes.filter((o) => o.status === 'rejected')
    assert.ok(rejected.length >= 1, '并发 append 必有超限方被锁内拒绝')
    for (const r of rejected) {
      assert.ok(r.reason instanceof HelmxError && r.reason.code === 'memory_limit_exceeded')
    }
    const final = await new MemoryStore(createProfileFileHost(dataDir)).getMemory('assistant')
    assert.ok(final.length <= MEM_MAX, `最终 ${final.length} ≤ 上限`)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('profile/memory：SYSTEM 与已初始化 MEMORY 缺失时注入显式 assets-missing 节（不沉默换人格）', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helmx-pm-missing-'))
  try {
    const profiles = new ProfileService(dataDir)
    await profiles.ensureDefault()
    const backend = makeControlledBackend(dataDir)
    const host = new PluginHost({ buildProvider: createPluginBuildProvider(), dataDir, host: backend, docs: new MemoryDocStore() })
    await host.register(createProfilePlugin(), { enabled: true })
    await host.register(createMemoryPlugin(), { enabled: true })

    // 先跑一回合建立 memory initializedProfiles 标记（惰性初始化 MEMORY.md）。
    {
      const turn = { conversation: makeConversation(1), sections: [], tools: [], inputs: [], messages: [] }
      await host.runHook('before_turn', turn as never)
    }
    unlinkSync(join(dataDir, 'profiles', 'assistant', 'MEMORY.md'))
    unlinkSync(join(dataDir, 'profiles', 'assistant', 'SYSTEM.md'))

    const turn = {
      conversation: makeConversation(1),
      sections: [{ id: 'base', text: 'base' }],
      tools: [],
      inputs: [],
      messages: [],
    }
    const result = await host.runHook('before_turn', turn as never)
    assert.ok(result.action === 'transform')
    const sections = (result as { value: { sections: Array<{ id: string; text: string }> } }).value.sections
    const sysMissing = sections.find((s) => s.id === 'profile.assets-missing')
    assert.ok(sysMissing !== undefined, '必须注入 profile.assets-missing 节')
    assert.ok(sysMissing.text.includes('SYSTEM.md'), '显式点名 SYSTEM.md 缺失')
    const memMissing = sections.find((s) => s.id === 'memory.assets-missing')
    assert.ok(memMissing !== undefined, '必须注入 memory.assets-missing 节')
    assert.ok(memMissing.text.includes('MEMORY.md'), '显式点名 MEMORY.md 缺失')
    assert.ok(memMissing.text.includes('until then you have no long-term memory') || sysMissing.text.includes('do not pretend'), 'the model is told not to fabricate missing memory or persona')
    // 人类侧告警也发出（双通道：模型可见 + 人类通知）。
    assert.ok(
      backend.notifications.some((n) => n.title.includes('MEMORY.md') || n.title.includes('Long-term Memory')),
      'MEMORY.md 缺失应有人类侧告警',
    )
    assert.ok(
      backend.notifications.some((n) => n.title.includes('SYSTEM.md')),
      'SYSTEM.md 缺失应有人类侧告警（每文件独立）',
    )

    // 同一缺失状态第二回合：不再重复告警（去重），但模型仍每回合可见。
    backend.notifications.length = 0
    const again = await host.runHook('before_turn', { ...turn, sections: [{ id: 'base', text: 'base' }] } as never)
    assert.ok(again.action === 'transform')
    assert.equal(backend.notifications.length, 0, '持续缺失不重复告警')
    const sections2 = (again as { value: { sections: Array<{ id: string }> } }).value.sections
    assert.ok(sections2.some((s) => s.id === 'profile.assets-missing'), '模型每回合仍可见 SYSTEM 缺失说明')
    assert.ok(sections2.some((s) => s.id === 'memory.assets-missing'), '模型每回合仍可见 MEMORY 缺失说明')

    // 文件恢复：告警标记复位——再次缺失可重新告警。
    const memoryPath = join(dataDir, 'profiles', 'assistant', 'MEMORY.md')
    writeFileSync(memoryPath, '# Memory\n\n恢复的记忆。\n')
    const healed = await host.runHook('before_turn', { ...turn, sections: [] } as never)
    assert.ok(healed.action === 'transform')
    const healedSections = (healed as { value: { sections: Array<{ id: string; text: string }> } }).value.sections
    // SYSTEM 仍缺失：profile.assets-missing 节仍在；MEMORY 恢复后 memory 段落回归。
    assert.ok(healedSections.some((s) => s.id === 'profile.assets-missing'), 'SYSTEM 仍缺失时节仍在')
    assert.ok(!healedSections.some((s) => s.id === 'memory.assets-missing'), 'MEMORY 恢复后缺失节移除')
    assert.ok(healedSections.some((s) => s.id === 'memory.content'), '恢复后正常注入 memory.content')
    backend.notifications.length = 0
    unlinkSync(memoryPath)
    await host.runHook('before_turn', { ...turn, sections: [] } as never)
    assert.ok(
      backend.notifications.some((n) => n.title.includes('MEMORY.md') || n.title.includes('Long-term Memory')),
      '恢复后再次缺失应重新告警（去重状态已复位）',
    )
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('memory：权限/IO 错误不被吞（仅 FileNotFoundError 走缺失路径）', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helmx-memory-ioerr-'))
  try {
    const profiles = new ProfileService(dataDir)
    await profiles.ensureDefault()
    // 先建立已初始化状态，再把 MEMORY.md 换成同名目录：readFile 得 EISDIR
    //（真实 IO 错，非 ENOENT 缺失）。
    await new MemoryStore(createProfileFileHost(dataDir)).ensureMemory('assistant')
    unlinkSync(join(dataDir, 'profiles', 'assistant', 'MEMORY.md'))
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(dataDir, 'profiles', 'assistant', 'MEMORY.md'))

    const backend = makeControlledBackend(dataDir)
    const host = new PluginHost({ buildProvider: createPluginBuildProvider(), dataDir, host: backend, docs: new MemoryDocStore() })
    await host.register(createMemoryPlugin(), { enabled: true })
    const turn = {
      conversation: makeConversation(1),
      sections: [],
      tools: [],
      inputs: [],
      messages: [],
    }
    await assert.rejects(
      () => host.runHook('before_turn', turn as never),
      (err: unknown) => {
        // 绝不被吞成「空记忆 + 缺失告警」：真实 IO 错误上抛（宿主包一层
        // HelmxError 但保留 cause 与原始 EISDIR 信息），不足缺失路径。
        const message = err instanceof Error ? err.message : String(err)
        assert.ok(message.includes('EISDIR'), `应携带真实 EISDIR 错误（实际 ${message}）`)
        return true
      },
    )
    // 也没发缺失告警（不是缺失路径）。
    assert.equal(backend.notifications.filter((n) => n.title.includes('缺失')).length, 0)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('profile：restrictToCwd 开启时注入 workspace_boundary 边界声明（关闭时不注入）', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helmx-pm-restrict-'))
  try {
    const profiles = new ProfileService(dataDir)
    await profiles.ensureDefault()
    const backend = makeControlledBackend(dataDir)
    const host = new PluginHost({ buildProvider: createPluginBuildProvider(), dataDir, host: backend, docs: new MemoryDocStore() })
    await host.register(createProfilePlugin(), { enabled: true })

    const turn = {
      conversation: makeConversation(1, { cwd: '/tmp/helmx/repo' }),
      sections: [],
      tools: [],
      inputs: [],
      messages: [],
    }
    // 默认（未开启）：不注入边界节。
    const off = await host.runHook('before_turn', turn as never)
    assert.ok(off.action === 'transform')
    const offSections = (off as { value: { sections: Array<{ id: string }> } }).value.sections
    assert.ok(!offSections.some((s) => s.id === 'profile.workspace-boundary'), '未开启 restrictToCwd 不注入边界节')

    // 开启：注入边界节，点名会话 cwd 与 path_outside_workspace。
    await profiles.save({ id: 'assistant', tags: ['assistant'], restrictToCwd: true })
    const on = await host.runHook('before_turn', turn as never)
    assert.ok(on.action === 'transform')
    const onSections = (on as { value: { sections: Array<{ id: string; text: string }> } }).value.sections
    const boundary = onSections.find((s) => s.id === 'profile.workspace-boundary')
    assert.ok(boundary !== undefined, '开启 restrictToCwd 必须注入边界节')
    assert.ok(boundary.text.includes('/tmp/helmx/repo'), '点名会话 cwd')
    assert.ok(boundary.text.includes('path_outside_workspace'), '点名拒绝错误码')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})
