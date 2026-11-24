/**
 * builtin:profile 节点技能库测试（真 PluginHost + 真文件系统 for local；
 * 远端用受控 executionEnv / isOnline 桩验证跨节点契约）。
 *
 * 覆盖（对齐需求验收重点）：
 * - 发现：`.helmx/skills` 缺失属常态（空目录，不注入不可用段）；正常技能
 *   （SKILL.md + references 嵌套）进 catalog；隐藏 / node_modules /
 *   __pycache__ / dist 跳过；非法 id 目录、无 SKILL.md、frontmatter 非法
 *   跳过；SKILL.md 超 MAX_NODE_SKILL_FILE_BYTES / 条目数超上限显式
 *   unavailable；managedByPlugin 强制剥离（节点文件不得冒充受管技能）；
 * - 同名优先级契约：Hub dataDir 技能 > 节点技能；同名时 catalog 只出现
 *   Hub 版本、load_skill 永远读到 Hub 内容（无来源参数，不可绕过）；
 * - 会话节点隔离：catalog / load_skill 均按会话自身 (nodeId, cwd)；
 * - load_skill：节点 SKILL.md 与 references 的精确读取；path 穿越 /
 *   绝对路径 / 反斜杠拒绝（400）；节点不存在 → 404；Profile 白名单外 →
 *   403 skill_not_available（与 Hub 技能同规则）；
 * - 更新下一回合生效：修改节点 SKILL.md 后下一 before_turn 的 catalog 与
 *   load_skill 都反映最新内容（无缓存、不回写历史上下文）；
 * - 显式诊断（绝不静默降级）：远端离线（isOnline === false，不进入
 *   executionEnv）与 isOnline 抛错 → before_turn 注入
 *   profile.node-skills-unavailable 段；load_skill 抛 409 node_offline；
 *   listDir permission_denied → 显式 unavailable / 502
 *   node_skill_read_failed；读取期间文件变化（同句柄复核）→ 显式拒绝；
 * - 有界安全读取纪律：canonicalPath + openBinaryReader({ noFollow: true })
 *   同句柄 info/read/close，read 至多请求 MAX_NODE_SKILL_FILE_BYTES + 1。
 * runner: tsx --test；每项 timeout: 60_000。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { HelmxError, type ConversationSummary, type SkillSummary } from '@helmx/protocol'
import {
  FileError,
  type BinaryReader,
  type ExecutionEnv,
  type FileInfo,
  type Result,
} from '@earendil-works/pi-durable/env'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { PluginHost, type PluginHostBackend } from '../../kernel/src/plugins/index.js'
import { ProfileService } from '../../kernel/src/services/index.js'
import { createProfileFileHost } from '../../kernel/test/helpers/profile-file-host.js'
import { createPluginHostBackendFixture } from '../../kernel/test/helpers/plugin-host-backend.js'
import { createProfilePlugin } from '../src/profile.js'
import {
  MAX_NODE_SKILL_FILE_BYTES,
  MAX_NODE_SKILLS,
  NODE_SKILLS_RELATIVE_DIR,
  scanNodeSkills,
} from '../src/profile/node-skills.js'
import type { NodeSkillsHostPort } from '../src/profile/node-skills.js'
import { createPluginBuildProvider } from '@helmx/plugin-build'
import { MemoryDocStore, makeConversationSummary } from './helpers/plugin-test-env.js'

// ---------------------------------------------------------------------------
// 测试基建
// ---------------------------------------------------------------------------

const makeConversation = (id: number, over: Partial<ConversationSummary> = {}): ConversationSummary =>
  makeConversationSummary({ id, ...over })

interface EnvCall {
  nodeId: string
  cwd: string
}

interface ControlledBackend extends PluginHostBackend {
  envCalls: EnvCall[]
  conversations: Map<number, ConversationSummary>
}

interface BackendOptions {
  /** 远端在线判定（local 恒不调用）；缺省恒在线。 */
  online?: (nodeId: string) => boolean
  /** executionEnv 工厂：缺省真实 NodeExecutionEnv（真文件系统）。 */
  envFor?: (nodeId: string, cwd: string) => ExecutionEnv
  redact?: (text: string) => string
  /** 测试隔离主目录（把 ~ 展开到独立临时目录，绝不污染或泄漏宿主 /root/.agents/skills）。 */
  homeDir?: string
}

function expandTestHome(path: string, homeDir: string): string {
  if (path === '~') return homeDir
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homeDir, path.slice(2))
  return path
}

/** 包装 ExecutionEnv，将 `~` 映射到隔离的临时 homeDir，避免单测触及宿主用户主目录。 */
function withTestHome(env: ExecutionEnv, homeDir: string): ExecutionEnv {
  return {
    ...env,
    id: env.id,
    cwd: env.cwd,
    absolutePath: (p, c) => env.absolutePath(expandTestHome(p, homeDir), c),
    joinPath: (parts, c) => env.joinPath(parts, c),
    readTextFile: (p, c) => env.readTextFile(expandTestHome(p, homeDir), c),
    readTextLines: (p, o, c) => env.readTextLines(expandTestHome(p, homeDir), o, c),
    openTextLineReader: (p, c) => env.openTextLineReader(expandTestHome(p, homeDir), c),
    readBinaryFile: (p, c) => env.readBinaryFile(expandTestHome(p, homeDir), c),
    openBinaryReader: (p, o, c) => env.openBinaryReader(expandTestHome(p, homeDir), o, c),
    writeFile: (p, x, c) => env.writeFile(expandTestHome(p, homeDir), x, c),
    appendFile: (p, x, c) => env.appendFile(expandTestHome(p, homeDir), x, c),
    truncateFile: (p, s, c) => env.truncateFile(expandTestHome(p, homeDir), s, c),
    flushFile: (p, c) => env.flushFile(expandTestHome(p, homeDir), c),
    renameFile: (s, d, c) => env.renameFile(expandTestHome(s, homeDir), expandTestHome(d, homeDir), c),
    fileInfo: (p, c) => env.fileInfo(expandTestHome(p, homeDir), c),
    listDir: (p, c) => env.listDir(expandTestHome(p, homeDir), c),
    openDirReader: (p, c) => env.openDirReader(expandTestHome(p, homeDir), c),
    watch: (tg, o, c) => env.watch(tg, o, c),
    canonicalPath: (p, c) => env.canonicalPath(expandTestHome(p, homeDir), c),
    exists: (p, c) => env.exists(expandTestHome(p, homeDir), c),
    createDir: (p, o, c) => env.createDir(expandTestHome(p, homeDir), o, c),
    remove: (p, o, c) => env.remove(expandTestHome(p, homeDir), o, c),
    createTempDir: (p, c) => env.createTempDir(p, c),
    createTempFile: (o, c) => env.createTempFile(o, c),
    cleanup: (c) => env.cleanup(c),
    exec: (cmd, o, c) => env.exec(cmd, o, c),
  }
}

function makeBackend(opts: BackendOptions = {}): ControlledBackend {
  const envCalls: EnvCall[] = []
  const conversations = new Map<number, ConversationSummary>()
  return {
    ...createPluginHostBackendFixture(),
    envCalls,
    conversations,
    nodeIpc: {
      isOnline: opts.online ?? (() => true),
    },
    executionEnv(nodeId: string, cwd: string) {
      envCalls.push({ nodeId, cwd })
      const base = opts.envFor ? opts.envFor(nodeId, cwd) : new NodeExecutionEnv({ cwd })
      return opts.homeDir !== undefined ? withTestHome(base, opts.homeDir) : base
    },
    ...(opts.redact !== undefined ? { redact: opts.redact } : {}),
    async emitEvent() {},
    getConversation(id: number) {
      const found = conversations.get(id)
      if (!found) throw new HelmxError('not_found', `会话不存在：${id}`, 404, { conversationId: id })
      return found
    },
  }
}

interface Env {
  dataDir: string
  homeDir: string
  host: PluginHost
  backend: ControlledBackend
  close(): Promise<void>
}

async function makeEnv(opts: BackendOptions = {}): Promise<Env> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helmx-node-skills-'))
  const homeDir = opts.homeDir ?? mkdtempSync(join(tmpdir(), 'helmx-node-home-'))
  const ownsHome = opts.homeDir === undefined
  const profiles = new ProfileService(dataDir)
  await profiles.ensureDefault()
  const backend = Object.assign(makeBackend({ ...opts, homeDir }), createProfileFileHost(dataDir, profiles))
  const host = new PluginHost({
    buildProvider: createPluginBuildProvider(),
    dataDir,
    host: backend,
    docs: new MemoryDocStore(),
  })
  await host.register(createProfilePlugin(), { enabled: true })
  return {
    dataDir,
    homeDir,
    host,
    backend,
    async close() {
      await host.dispose().catch(() => {})
      rmSync(dataDir, { recursive: true, force: true })
      if (ownsHome) rmSync(homeDir, { recursive: true, force: true })
    },
  }
}

interface TurnLike {
  conversation: ConversationSummary
  sections: Array<{ id: string; text: string }>
  tools: Array<{ name: string }>
  inputs: unknown[]
  messages: Array<Record<string, unknown>>
}

function makeTurn(cwd: string, over: Partial<ConversationSummary> = {}): TurnLike {
  return {
    conversation: makeConversation(1, { cwd, ...over }),
    sections: [],
    tools: [],
    inputs: [],
    messages: [],
  }
}

async function runBeforeTurn(env: Env, turn: TurnLike): Promise<Array<{ id: string; text: string }>> {
  const result = (await env.host.runHook('before_turn', turn as never)) as {
    action: string
    value?: TurnLike
  }
  assert.equal(result.action, 'transform')
  return result.value!.sections
}

/** 触发 load_skill 并断言成功返回 { text }。 */
async function loadSkillOk(env: Env, conversationId: number, input: { skillId: string; path?: string }): Promise<string> {
  const result = (await env.host.executeTool('load_skill', input, { conversationId })) as { text: string }
  assert.ok(typeof result.text === 'string')
  return result.text
}

/** 触发 load_skill 并断言失败，返回 HelmxError（经 assertRejectsCode 同源校验）。 */
async function loadSkillErr(env: Env, conversationId: number, input: { skillId: string; path?: string }): Promise<HelmxError> {
  try {
    await env.host.executeTool('load_skill', input, { conversationId })
  } catch (err) {
    assert.ok(err instanceof HelmxError, `expected HelmxError, got: ${String(err)}`)
    return err
  }
  assert.fail('expected load_skill to throw')
}

function skillSection(sections: Array<{ id: string; text: string }>): string | undefined {
  return sections.find((s) => s.id === 'profile.skills')?.text
}

/** 在工作区写入一个节点技能（返回技能目录绝对路径）。 */
function writeNodeSkill(
  workspace: string,
  id: string,
  skillMd: string,
  references: Record<string, string> = {},
): string {
  const dir = join(workspace, NODE_SKILLS_RELATIVE_DIR, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), skillMd)
  for (const [rel, content] of Object.entries(references)) {
    const target = join(dir, rel)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
  return dir
}

/** 在 Hub dataDir 写入一个技能（同名优先级的高优先级侧）。 */
function writeHubSkill(dataDir: string, id: string, skillMd: string): void {
  const dir = join(dataDir, 'skills', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), skillMd)
}

const SKILL_MD = (name: string, description: string): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nBody.\n`

// ---------------------------------------------------------------------------
// scanNodeSkills 单元面（不经 PluginHost）
// ---------------------------------------------------------------------------

test('scanNodeSkills: workspace without .helmx/skills is an ordinary empty (ok, no diagnostics)', { timeout: 60_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  const host: NodeSkillsHostPort = {
    executionEnv: (nodeId, cwd) => new NodeExecutionEnv({ cwd }),
    redact: (text) => text,
    nodeIpc: { isOnline: () => true },
  }
  const scan = await scanNodeSkills(host, 'local', workspace)
  assert.equal(scan.kind, 'ok')
  assert.deepEqual((scan as { skills: SkillSummary[] }).skills, [])
})

test('scanNodeSkills: local with empty cwd resolves to empty without touching executionEnv; remote with empty cwd scans machine roots', { timeout: 60_000 }, async (t) => {
  let envCreated = false
  const hostNoCall: NodeSkillsHostPort = {
    executionEnv: () => {
      envCreated = true
      throw new Error('must not be reached')
    },
    redact: (text) => text,
    nodeIpc: { isOnline: () => true },
  }
  const localScan = await scanNodeSkills(hostNoCall, 'local', '')
  assert.equal(localScan.kind, 'ok')
  assert.deepEqual((localScan as { skills: SkillSummary[] }).skills, [])
  assert.ok(!envCreated, 'local without cwd has no extra roots and never acquires executionEnv')

  const fakeHome = mkdtempSync(join(tmpdir(), 'helmx-node-home-'))
  t.after(() => rmSync(fakeHome, { recursive: true, force: true }))
  const remoteSharedDir = join(fakeHome, '.agents', 'skills', 'remote-shared')
  mkdirSync(remoteSharedDir, { recursive: true })
  writeFileSync(join(remoteSharedDir, 'SKILL.md'), SKILL_MD('Remote Shared', 'from ~/.agents/skills'))
  const remoteHost: NodeSkillsHostPort = {
    executionEnv: (_nodeId, cwd) => withTestHome(new NodeExecutionEnv({ cwd }), fakeHome),
    redact: (text) => text,
    nodeIpc: { isOnline: () => true },
  }
  const remoteScan = await scanNodeSkills(remoteHost, 'remote-1', '')
  assert.equal(remoteScan.kind, 'ok')
  assert.deepEqual(
    (remoteScan as { skills: SkillSummary[] }).skills.map((s) => s.id),
    ['remote-shared'],
  )
})

// ---------------------------------------------------------------------------
// before_turn catalog 注入（发现 / 同名优先级 / 隔离 / 显式诊断）
// ---------------------------------------------------------------------------

test('before_turn injects node skills into the available_skills catalog (source node, nested references)', { timeout: 60_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  writeNodeSkill(workspace, 'deploy-helper', SKILL_MD('Deploy Helper', 'Node-local deploy runbook'), {
    'references/runbook.md': '# runbook\nstep 1\n',
    'references/advanced/tuning.md': '# tuning\n',
  })
  // 常态跳过面：隐藏目录、依赖产物目录、非法 id、无 SKILL.md、frontmatter 非法。
  writeNodeSkill(workspace, '.hidden-skill', SKILL_MD('hidden', 'should be skipped'))
  const nodeModulesDir = join(workspace, NODE_SKILLS_RELATIVE_DIR, 'in-node-modules', 'node_modules', 'x')
  mkdirSync(nodeModulesDir, { recursive: true })
  writeFileSync(join(nodeModulesDir, 'SKILL.md'), SKILL_MD('x', 'x'))
  const badIdDir = join(workspace, NODE_SKILLS_RELATIVE_DIR, 'bad id with spaces')
  mkdirSync(badIdDir, { recursive: true })
  writeFileSync(join(badIdDir, 'SKILL.md'), SKILL_MD('bad', 'id'))
  const noSkillMdDir = join(workspace, NODE_SKILLS_RELATIVE_DIR, 'no-skill-md')
  mkdirSync(noSkillMdDir, { recursive: true })
  writeFileSync(join(noSkillMdDir, 'README.md'), 'not a skill')
  const brokenDir = join(workspace, NODE_SKILLS_RELATIVE_DIR, 'broken-frontmatter')
  mkdirSync(brokenDir, { recursive: true })
  writeFileSync(join(brokenDir, 'SKILL.md'), '---\nmanagedByPlugin:\n---\nbody\n')

  const env = await makeEnv()
  t.after(() => env.close(), { timeout: 60_000 })
  const sections = await runBeforeTurn(env, makeTurn(workspace))
  const catalog = skillSection(sections)
  assert.ok(catalog !== undefined, 'catalog section present (helmx-cli + node skill)')
  assert.ok(catalog.includes('<skill id="deploy-helper">'), 'node skill listed')
  assert.ok(catalog.includes('<name>Deploy Helper</name>'))
  assert.ok(catalog.includes('<description>Node-local deploy runbook</description>'))
  assert.ok(catalog.includes('<references>references/advanced/tuning.md, references/runbook.md</references>'))
  for (const missing of ['.hidden-skill', 'in-node-modules', 'bad id', 'no-skill-md', 'broken-frontmatter']) {
    assert.ok(!catalog.includes(missing), `skipped entry not in catalog: ${missing}`)
  }
  assert.ok(sections.every((s) => s.id !== 'profile.node-skills-unavailable'), 'no unavailable section for ordinary states')
})

test('node SKILL.md managedByPlugin is stripped — the node cannot fake a host-managed skill', { timeout: 60_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  writeNodeSkill(workspace, 'fake-managed', '---\nname: Fake\nmanagedByPlugin: builtin:profile\n---\nbody\n')
  const host: NodeSkillsHostPort = {
    executionEnv: (nodeId, cwd) => new NodeExecutionEnv({ cwd }),
    redact: (text) => text,
    nodeIpc: { isOnline: () => true },
  }
  const scan = await scanNodeSkills(host, 'local', workspace)
  assert.equal(scan.kind, 'ok')
  const skill = (scan as { skills: SkillSummary[] }).skills.find((s) => s.id === 'fake-managed')
  assert.ok(skill !== undefined)
  assert.ok(skill.managedByPlugin === undefined, 'managedByPlugin must be stripped from node skills')
  assert.equal(skill.source, 'node')
})

test('same-name priority: Hub dataDir skill wins the catalog and load_skill; the node version is unreachable', { timeout: 60_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  writeNodeSkill(workspace, 'shared-name', SKILL_MD('Node Variant', 'node description must not surface'))
  const env = await makeEnv()
  t.after(() => env.close(), { timeout: 60_000 })
  writeHubSkill(env.dataDir, 'shared-name', SKILL_MD('Hub Variant', 'hub description wins'))
  env.backend.conversations.set(1, makeConversation(1, { cwd: workspace }))

  const catalog = skillSection(await runBeforeTurn(env, makeTurn(workspace)))
  assert.ok(catalog !== undefined)
  assert.ok(catalog.includes('<skill id="shared-name">'))
  assert.ok(catalog.includes('Hub Variant') && catalog.includes('hub description wins'))
  assert.ok(!catalog.includes('Node Variant') && !catalog.includes('node description must not surface'), 'node variant never surfaces')

  const text = await loadSkillOk(env, 1, { skillId: 'shared-name' })
  assert.ok(text.includes('Hub Variant'), 'load_skill resolves the Hub version (highest priority)')
  assert.ok(!text.includes('Node Variant'))
  // load_skill 的 Hub 分支不触达节点执行环境（before_turn 的节点扫描除外，次数不因 load_skill 增加）。
  const callsAfterCatalog = env.backend.envCalls.length
  await loadSkillOk(env, 1, { skillId: 'shared-name' })
  assert.equal(env.backend.envCalls.length, callsAfterCatalog, 'Hub-resolved load_skill never touches the node env')
})

test('node skills are isolated per conversation (nodeId, cwd) — another workspace never sees them', { timeout: 60_000 }, async (t) => {
  const wsA = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  const wsB = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => {
    rmSync(wsA, { recursive: true, force: true })
    rmSync(wsB, { recursive: true, force: true })
  })
  writeNodeSkill(wsA, 'ws-a-only', SKILL_MD('A Only', 'from workspace A'))
  const env = await makeEnv()
  t.after(() => env.close(), { timeout: 60_000 })

  const catalogA = skillSection(await runBeforeTurn(env, makeTurn(wsA)))
  const catalogB = skillSection(await runBeforeTurn(env, makeTurn(wsB)))
  assert.ok(catalogA?.includes('ws-a-only'))
  assert.ok(!catalogB?.includes('ws-a-only'), 'workspace B catalog must not list workspace A node skills')
})

test('remote node skills route through executionEnv(nodeId, cwd) with an online precheck', { timeout: 60_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  writeNodeSkill(workspace, 'remote-skill', SKILL_MD('Remote Skill', 'lives on the remote node'))
  let onlineChecked: string[] = []
  const env = await makeEnv({ online: (nodeId) => (onlineChecked.push(nodeId), true) })
  t.after(() => env.close(), { timeout: 60_000 })

  const turn = makeTurn(workspace, { nodeId: 'remote-1' })
  const catalog = skillSection(await runBeforeTurn(env, turn))
  assert.ok(catalog?.includes('remote-skill'))
  // 同一回合内节点技能扫描与 AGENTS.md 读取都会预检在线状态，均以目标节点为参。
  assert.ok(onlineChecked.length >= 1 && onlineChecked.every((id) => id === 'remote-1'))
  assert.ok(env.backend.envCalls.length >= 1)
  assert.deepEqual(env.backend.envCalls[0], { nodeId: 'remote-1', cwd: workspace })
})

test('remote node offline: explicit unavailable section (never silently empty), load_skill fails node_offline', { timeout: 60_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  writeNodeSkill(workspace, 'remote-skill', SKILL_MD('Remote Skill', 'unreachable while offline'))
  const env = await makeEnv({ online: () => false })
  t.after(() => env.close(), { timeout: 60_000 })
  env.backend.conversations.set(1, makeConversation(1, { cwd: workspace, nodeId: 'remote-1' }))

  const sections = await runBeforeTurn(env, makeTurn(workspace, { nodeId: 'remote-1' }))
  const unavailable = sections.find((s) => s.id === 'profile.node-skills-unavailable')
  assert.ok(unavailable !== undefined, 'offline state injects an explicit unavailable section')
  assert.ok(unavailable.text.includes('<node_skills_unavailable'))
  assert.ok(unavailable.text.includes('remote-1'))
  assert.ok(unavailable.text.includes('离线'))
  // 离线即止步：绝不进入 executionEnv（远端 RPC 会阻塞在重连窗口）。
  assert.deepEqual(env.backend.envCalls, [])

  const err = await loadSkillErr(env, 1, { skillId: 'remote-skill' })
  assert.equal(err.code, 'node_offline')
  assert.equal(err.status, 409)
})

test('isOnline throwing (unwired host capability) is stated explicitly, never treated as online', { timeout: 60_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  const env = await makeEnv({
    online: () => {
      throw new HelmxError('node_ipc_unavailable', '测试桩未接线 nodeIpc', 501)
    },
  })
  t.after(() => env.close(), { timeout: 60_000 })

  const sections = await runBeforeTurn(env, makeTurn(workspace, { nodeId: 'remote-1' }))
  const unavailable = sections.find((s) => s.id === 'profile.node-skills-unavailable')
  assert.ok(unavailable !== undefined)
  assert.ok(unavailable.text.includes('node_ipc_unavailable'))
})

// ---------------------------------------------------------------------------
// load_skill：节点分支精确读取 / 边界拒绝 / 白名单 / 更新生效
// ---------------------------------------------------------------------------

test('load_skill reads node SKILL.md and references precisely (latest node content, no cache)', { timeout: 60_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  const dir = writeNodeSkill(
    workspace,
    'node-tool',
    SKILL_MD('Node Tool', 'v1 description'),
    { 'references/guide.md': '# guide v1\n' },
  )
  const env = await makeEnv()
  t.after(() => env.close(), { timeout: 60_000 })
  env.backend.conversations.set(1, makeConversation(1, { cwd: workspace }))

  const md = await loadSkillOk(env, 1, { skillId: 'node-tool' })
  assert.ok(md.includes('# Node Tool'))
  const guide = await loadSkillOk(env, 1, { skillId: 'node-tool', path: 'references/guide.md' })
  assert.equal(guide, '# guide v1\n')

  // 节点事实来源更新：下一回合 catalog 与 load_skill 都反映最新内容（不回写历史）。
  writeFileSync(join(dir, 'SKILL.md'), SKILL_MD('Node Tool', 'v2 description'))
  writeFileSync(join(dir, 'references', 'guide.md'), '# guide v2\n')
  const md2 = await loadSkillOk(env, 1, { skillId: 'node-tool' })
  assert.ok(md2.includes('v2 description'))
  const guide2 = await loadSkillOk(env, 1, { skillId: 'node-tool', path: 'references/guide.md' })
  assert.equal(guide2, '# guide v2\n')
  const catalog = skillSection(await runBeforeTurn(env, makeTurn(workspace)))
  assert.ok(catalog?.includes('v2 description'))
})

test('load_skill rejects traversal / absolute / backslash paths on the node branch (400)', { timeout: 60_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  writeNodeSkill(workspace, 'node-tool', SKILL_MD('Node Tool', 'd'))
  const env = await makeEnv()
  t.after(() => env.close(), { timeout: 60_000 })
  env.backend.conversations.set(1, makeConversation(1, { cwd: workspace }))

  for (const path of ['../outside.md', 'references/../../outside.md', '/etc/passwd', 'a\\b.md']) {
    const err = await loadSkillErr(env, 1, { skillId: 'node-tool', path })
    assert.equal(err.code, 'validation_error', `path=${path}`)
    assert.equal(err.status, 400)
  }
})

test('load_skill on a node skill missing everywhere is a plain 404 (no fabrication)', { timeout: 60_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  const env = await makeEnv()
  t.after(() => env.close(), { timeout: 60_000 })
  env.backend.conversations.set(1, makeConversation(1, { cwd: workspace }))

  const err = await loadSkillErr(env, 1, { skillId: 'never-exists' })
  assert.equal(err.code, 'not_found')
  assert.equal(err.status, 404)
})

test('Profile whitelist applies to node skills with the same rule as Hub skills (403 outside)', { timeout: 60_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  writeNodeSkill(workspace, 'node-tool', SKILL_MD('Node Tool', 'd'))
  writeNodeSkill(workspace, 'node-other', SKILL_MD('Node Other', 'd'))
  const env = await makeEnv()
  t.after(() => env.close(), { timeout: 60_000 })
  const assistant = await (env.backend as unknown as { profiles: { get(id: string): Promise<unknown> } }).profiles.get('assistant')
  assert.ok(assistant !== undefined)
  // 通过宿主 profiles 端口保存白名单（只允许 node-tool）。
  const profilesPort = (env.backend as unknown as { profiles: { save(p: unknown): Promise<unknown> } }).profiles
  await profilesPort.save({ ...(assistant as object), skills: ['node-tool'] })
  env.backend.conversations.set(1, makeConversation(1, { cwd: workspace }))

  const catalog = skillSection(await runBeforeTurn(env, makeTurn(workspace)))
  assert.ok(catalog?.includes('node-tool'))
  assert.ok(!catalog?.includes('node-other'), 'non-whitelisted node skill filtered from catalog')

  const okText = await loadSkillOk(env, 1, { skillId: 'node-tool' })
  assert.ok(okText.includes('# Node Tool'))
  const err = await loadSkillErr(env, 1, { skillId: 'node-other' })
  assert.equal(err.code, 'skill_not_available')
  assert.equal(err.status, 403)
})

// ---------------------------------------------------------------------------
// 显式故障面：listDir 权限错误 / 超限 / 读取期间变化
// ---------------------------------------------------------------------------

/** Path separator that matches the path's own shape (POSIX / Windows targets both safe). */
function sepLike(path: string): string {
  return path.includes('\\') && !path.includes('/') ? '\\' : '/'
}

/** 受控执行环境：委托真实 NodeExecutionEnv，但可覆写 listDir / openBinaryReader 应答。 */
function controlledEnv(workspace: string, over: {
  listDir?: (path: string) => Result<FileInfo[], FileError>
  wrapReader?: (path: string, reader: BinaryReader) => BinaryReader
}): ExecutionEnv {
  const real = new NodeExecutionEnv({ cwd: workspace })
  const env: ExecutionEnv = {
    id: real.id,
    cwd: real.cwd,
    absolutePath: (p, c) => real.absolutePath(p, c),
    joinPath: (p, c) => real.joinPath(p, c),
    readTextFile: (p, c) => real.readTextFile(p, c),
    openTextLineReader: (p, c) => real.openTextLineReader(p, c),
    readTextLines: (p, o, c) => real.readTextLines(p, o, c),
    readBinaryFile: (p, c) => real.readBinaryFile(p, c),
    openBinaryReader: async (p, o, c) => {
      const opened = await real.openBinaryReader(p, o, c)
      if (!opened.ok || over.wrapReader === undefined) return opened
      return { ok: true, value: over.wrapReader(p, opened.value) }
    },
    writeFile: (p, x, c) => real.writeFile(p, x, c),
    appendFile: (p, x, c) => real.appendFile(p, x, c),
    truncateFile: (p, s, c) => real.truncateFile(p, s, c),
    flushFile: (p, c) => real.flushFile(p, c),
    renameFile: (s, d, c) => real.renameFile(s, d, c),
    fileInfo: (p, c) => real.fileInfo(p, c),
    listDir: async (p, c) => (over.listDir ? over.listDir(p) : real.listDir(p, c)),
    openDirReader: (p, c) => real.openDirReader(p, c),
    watch: (tg, o, c) => real.watch(tg, o, c),
    canonicalPath: (p, c) => real.canonicalPath(p, c),
    exists: (p, c) => real.exists(p, c),
    createDir: (p, o, c) => real.createDir(p, o, c),
    remove: (p, o, c) => real.remove(p, o, c),
    createTempDir: (p, c) => real.createTempDir(p, c),
    createTempFile: (o, c) => real.createTempFile(o, c),
    cleanup: (c) => real.cleanup(c),
    async exec() {
      throw new Error('not needed in this test')
    },
  }
  return env
}

test('listDir permission failure surfaces as an explicit unavailable section (never silent empty)', { timeout: 60_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  writeNodeSkill(workspace, 'node-tool', SKILL_MD('Node Tool', 'd'))
  const env = await makeEnv({
    envFor: (nodeId, cwd) =>
      controlledEnv(workspace, {
        listDir: (path) =>
          path.split(sepLike(path)).includes('skills') && path.includes('.helmx')
            ? { ok: false, error: new FileError('permission_denied', 'EACCES: permission denied', path) }
            : { ok: true, value: [] as FileInfo[] },
      }),
  })
  t.after(() => env.close(), { timeout: 60_000 })

  const sections = await runBeforeTurn(env, makeTurn(workspace, { nodeId: 'remote-1' }))
  const unavailable = sections.find((s) => s.id === 'profile.node-skills-unavailable')
  assert.ok(unavailable !== undefined)
  assert.ok(unavailable.text.includes('permission_denied'))
  // Hub 技能目录照常注入（仅节点来源显式缺失）。
  assert.ok(skillSection(sections) !== undefined)
})

test('oversized SKILL.md (over MAX_NODE_SKILL_FILE_BYTES) fails the scan explicitly', { timeout: 60_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  const dir = join(workspace, NODE_SKILLS_RELATIVE_DIR, 'huge-skill')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), 'x'.repeat(MAX_NODE_SKILL_FILE_BYTES + 1))
  const host: NodeSkillsHostPort = {
    executionEnv: (nodeId, cwd) => new NodeExecutionEnv({ cwd }),
    redact: (text) => text,
    nodeIpc: { isOnline: () => true },
  }
  const scan = await scanNodeSkills(host, 'local', workspace)
  assert.equal(scan.kind, 'unavailable')
  assert.ok((scan as { reason: string }).reason.includes('huge-skill'))
})

test('exceeding MAX_NODE_SKILLS entries fails the scan explicitly (no silent truncation)', { timeout: 60_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  for (let i = 0; i <= MAX_NODE_SKILLS; i++) {
    writeNodeSkill(workspace, `s${i.toString().padStart(4, '0')}`, SKILL_MD(`s${i}`, 'd'))
  }
  const host: NodeSkillsHostPort = {
    executionEnv: (nodeId, cwd) => new NodeExecutionEnv({ cwd }),
    redact: (text) => text,
    nodeIpc: { isOnline: () => true },
  }
  const scan = await scanNodeSkills(host, 'local', workspace)
  assert.equal(scan.kind, 'unavailable')
  assert.ok((scan as { reason: string }).reason.includes(String(MAX_NODE_SKILLS)))
})

test('a node skill directory that is a symlink is skipped (never followed)', { timeout: 60_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  const real = writeNodeSkill(workspace, 'real-skill', SKILL_MD('Real', 'd'))
  const linkDir = join(workspace, NODE_SKILLS_RELATIVE_DIR, 'linked-skill')
  mkdirSync(join(workspace, NODE_SKILLS_RELATIVE_DIR), { recursive: true })
  symlinkSync(real, linkDir)
  const host: NodeSkillsHostPort = {
    executionEnv: (nodeId, cwd) => new NodeExecutionEnv({ cwd }),
    redact: (text) => text,
    nodeIpc: { isOnline: () => true },
  }
  const scan = await scanNodeSkills(host, 'local', workspace)
  assert.equal(scan.kind, 'ok')
  const ids = (scan as { skills: SkillSummary[] }).skills.map((s) => s.id)
  assert.ok(ids.includes('real-skill'))
  assert.ok(!ids.includes('linked-skill'), 'symlinked skill dir is listed as symlink and skipped')
})

test('load_skill on the node branch reports a mid-read size change explicitly (502)', { timeout: 60_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  writeNodeSkill(workspace, 'node-tool', SKILL_MD('Node Tool', 'd'))
  // 受控 reader：第二次 info（读后复核）前改写文件——同句柄复核必须显式拒绝，
  // 绝不把旧前缀当完整快照返回。
  const env = await makeEnv({
    envFor: (nodeId, cwd) =>
      controlledEnv(workspace, {
        wrapReader: (path, reader): BinaryReader => {
          if (!path.endsWith('SKILL.md')) return reader
          let infoCalls = 0
          return {
            info: async (ctx) => {
              infoCalls += 1
              // 第二次 info（读后复核）前先改写文件，再取同句柄元信息：
              // size/mtime 与读前不一致必须被显式拒绝。
              if (infoCalls === 2) {
                writeFileSync(path, SKILL_MD('Node Tool', 'changed mid-read'))
              }
              return reader.info(ctx)
            },
            read: (offset, length, ctx) => reader.read(offset, length, ctx),
            scanLines: (options2, ctx) => reader.scanLines(options2, ctx),
            close: (ctx) => reader.close(ctx),
          }
        },
      }),
  })
  t.after(() => env.close(), { timeout: 60_000 })
  env.backend.conversations.set(1, makeConversation(1, { cwd: workspace, nodeId: 'remote-1' }))

  const err = await loadSkillErr(env, 1, { skillId: 'node-tool' })
  assert.equal(err.code, 'node_skill_read_failed')
  assert.equal(err.status, 502)
  assert.ok(err.message.includes('变化') || err.message.includes('size'), `diagnostic mentions the mid-read change: ${err.message}`)
})

test('node catalog name/description are redacted before entering the system prompt', { timeout: 60_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  writeNodeSkill(workspace, 'leaky', '---\nname: leaky\ndescription: token sk-secret-value inside\n---\nbody\n')
  const env = await makeEnv({ redact: (text) => text.replace(/sk-secret-value/g, '[REDACTED]') })
  t.after(() => env.close(), { timeout: 60_000 })

  const catalog = skillSection(await runBeforeTurn(env, makeTurn(workspace)))
  assert.ok(catalog !== undefined)
  assert.ok(catalog.includes('[REDACTED]'))
  assert.ok(!catalog.includes('sk-secret-value'))
})

// ---------------------------------------------------------------------------
// 坐标作用域 action：skill_catalog / skill_read（scope ACL + 输入边界）
// ---------------------------------------------------------------------------

/** 触发 action 并断言失败，返回 HelmxError（与 loadSkillErr 同源校验）。 */
async function actionErr(
  env: Env,
  actionId: 'skill_catalog' | 'skill_read',
  input: unknown,
  context?: { conversationId: number },
): Promise<HelmxError> {
  try {
    await env.host.invokeAction('builtin:profile', actionId, input, context)
  } catch (err) {
    assert.ok(err instanceof HelmxError, `expected HelmxError, got: ${String(err)}`)
    return err
  }
  assert.fail(`expected action ${actionId} to throw`)
}

test('skill_catalog / skill_read action manifests: exposeToPrompt:false, scope excludes sessions, idempotent, no cli.command override', { timeout: 60_000 }, async (t) => {
  const env = await makeEnv()
  t.after(() => env.close(), { timeout: 60_000 })
  const manifests = env.host
    .listActions()
    .filter((m) => m.pluginId === 'builtin:profile' && (m.id === 'skill_catalog' || m.id === 'skill_read'))
  assert.equal(manifests.length, 2, 'both actions declared on the enabled plugin')
  for (const manifest of manifests) {
    // exposeToPrompt:false 由内核 renderActionDirectory 统一跳过（kernel 通用行为已由
    // kernel 测试锁定），此处锁定 manifest 结构不变量：不进 <available_actions> 目录。
    assert.equal(manifest.exposeToPrompt, false, `${manifest.id} must stay out of the model prompt catalog`)
    // scope:{conversationIds:[]} 是真正的 ACL：显式空数组排除一切带 conversationId 的调用
    // （run_action / workflow / HTTP body.conversationId）——模型连 manifest 都拿不到。
    assert.deepEqual(manifest.scope, { conversationIds: [] }, `${manifest.id} excludes every session-context call`)
    assert.equal(manifest.idempotent, true, `${manifest.id} is a read-only idempotent action`)
    assert.notEqual(manifest.exposeAsTool, true, `${manifest.id} is not a direct tool`)
    assert.equal(manifest.cli, undefined, `${manifest.id} keeps the default dynamic CLI path (no skills list/read conflict)`)
  }
})

test('scope ACL: every conversation-carrying call is rejected 403 before the handler (run_action / workflow / HTTP body.conversationId paths)', { timeout: 60_000 }, async (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => rmSync(ws, { recursive: true, force: true }))
  writeNodeSkill(ws, 'ws-skill', SKILL_MD('WS Skill', 'never reached through a session context'))
  const env = await makeEnv()
  t.after(() => env.close(), { timeout: 60_000 })
  env.backend.conversations.set(1, makeConversation(1, { cwd: ws }))

  // 会话上下文（无论是否携带显式坐标）一律 403——会话坐标绑定路径已按安全裁定移除
  for (const input of [{}, { nodeId: 'local' }, { nodeId: 'local', cwd: ws }]) {
    const err = await actionErr(env, 'skill_catalog', input, { conversationId: 1 })
    assert.equal(err.code, 'conversation_scope_violation', `session-context call rejected: ${JSON.stringify(input)}`)
    assert.equal(err.status, 403)
  }
  const steered = await actionErr(env, 'skill_read', { skillId: 'ws-skill', nodeId: 'local', cwd: ws }, { conversationId: 1 })
  assert.equal(steered.code, 'conversation_scope_violation')
  assert.equal(steered.status, 403)
  // 失效会话目标 → scope 判定前 getConversation 显式 404（不猜测）
  const missing = await actionErr(env, 'skill_catalog', {}, { conversationId: 404 })
  assert.equal(missing.code, 'not_found')
})

test('skill_catalog: context-free calls require explicit nodeId (cwd optional); relative cwd, extra properties and unregistered nodeIds are rejected', { timeout: 60_000 }, async (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => rmSync(ws, { recursive: true, force: true }))
  writeNodeSkill(ws, 'explicit-skill', SKILL_MD('Explicit', 'discovered via explicit coordinates'))
  // 默认桩对一切 nodeId 报在线；显式关闭后 ghost-node 在边界被拒（local 恒不查 isOnline）
  const env = await makeEnv({ online: () => false })
  t.after(() => env.close(), { timeout: 60_000 })

  for (const input of [{}, { cwd: ws }, { nodeId: '  ' }]) {
    const err = await actionErr(env, 'skill_catalog', input)
    assert.equal(err.code, 'validation_error', `missing/invalid nodeId rejected: ${JSON.stringify(input)}`)
  }
  const relative = await actionErr(env, 'skill_catalog', { nodeId: 'local', cwd: 'relative/path' })
  assert.equal(relative.code, 'validation_error')
  assert.ok(relative.message.includes('absolute'))
  const extra = await actionErr(env, 'skill_catalog', { nodeId: 'local', cwd: ws, bogus: true })
  assert.equal(extra.code, 'validation_error', 'input boundary: additionalProperties rejected')
  // 未注册 nodeId（与已断线不可区分）在输入边界显式 400，绝不进入扫描
  const ghost = await actionErr(env, 'skill_catalog', { nodeId: 'ghost-node', cwd: ws })
  assert.equal(ghost.code, 'validation_error')
  assert.ok(ghost.message.includes('not currently registered'), `honest registration diagnostic: ${ghost.message}`)
  assert.deepEqual(env.backend.envCalls, [], 'an unregistered nodeId never reaches executionEnv')

  // local 不传 cwd：返回 Hub 目录且不触发 executionEnv
  const localOnly = (await env.host.invokeAction('builtin:profile', 'skill_catalog', { nodeId: 'local' })) as {
    nodeId: string
    cwd?: string
    skills: SkillSummary[]
    shadowedNodeSkillIds: string[]
  }
  assert.equal(localOnly.nodeId, 'local')
  assert.equal(localOnly.cwd, undefined)
  assert.deepEqual(localOnly.shadowedNodeSkillIds, [])
  assert.deepEqual(env.backend.envCalls, [])

  const catalog = (await env.host.invokeAction('builtin:profile', 'skill_catalog', { nodeId: 'local', cwd: ws })) as {
    nodeId: string
    cwd?: string
    skills: SkillSummary[]
    shadowedNodeSkillIds: string[]
    nodeUnavailable?: string
  }
  assert.equal(catalog.nodeId, 'local')
  assert.equal(catalog.cwd, ws)
  assert.ok(catalog.skills.some((s) => s.id === 'explicit-skill' && s.source === 'node'))
  assert.deepEqual(catalog.shadowedNodeSkillIds, [])
  assert.ok(catalog.nodeUnavailable === undefined)
})

test('skill_catalog: same-name node skill is shadowed — the Hub version stays effective and shadowedNodeSkillIds reports it explicitly', { timeout: 60_000 }, async (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => rmSync(ws, { recursive: true, force: true }))
  writeNodeSkill(ws, 'shared-name', SKILL_MD('Node Variant', 'node description must not surface'))
  writeNodeSkill(ws, 'node-only', SKILL_MD('Node Only', 'node supplement'))
  const env = await makeEnv()
  t.after(() => env.close(), { timeout: 60_000 })
  writeHubSkill(env.dataDir, 'shared-name', SKILL_MD('Hub Variant', 'hub description wins'))

  const catalog = (await env.host.invokeAction('builtin:profile', 'skill_catalog', { nodeId: 'local', cwd: ws })) as {
    skills: SkillSummary[]
    shadowedNodeSkillIds: string[]
  }
  const shared = catalog.skills.find((s) => s.id === 'shared-name')
  assert.ok(shared !== undefined)
  assert.equal(shared.name, 'Hub Variant', 'the Hub version is the effective one')
  assert.notEqual(shared.source, 'node')
  assert.ok(!catalog.skills.some((s) => s.id === 'shared-name' && s.source === 'node'), 'node variant never enters the merged catalog')
  assert.deepEqual(catalog.shadowedNodeSkillIds, ['shared-name'], 'the shadowed node id is reported explicitly')
  assert.ok(catalog.skills.some((s) => s.id === 'node-only' && s.source === 'node'), 'non-shadowed node skills still supplement')
})

test('skill_catalog: an offline remote nodeId is rejected at the input boundary; a post-boundary offline race still surfaces nodeUnavailable', { timeout: 60_000 }, async (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => rmSync(ws, { recursive: true, force: true }))
  writeNodeSkill(ws, 'remote-skill', SKILL_MD('Remote', 'unreachable while offline'))
  const env = await makeEnv({ online: () => false })
  t.after(() => env.close(), { timeout: 60_000 })
  writeHubSkill(env.dataDir, 'hub-skill', SKILL_MD('Hub Skill', 'hub side'))

  // 未注册/已断线（isOnline 语义下不可区分）→ 输入边界 400，诚实措辞不谎称能区分
  const rejected = await actionErr(env, 'skill_catalog', { nodeId: 'remote-1', cwd: ws })
  assert.equal(rejected.code, 'validation_error')
  assert.ok(rejected.message.includes('not currently registered'))
  assert.deepEqual(env.backend.envCalls, [], 'offline stops before entering executionEnv')

  // TOCTOU 竞态：边界核验时在线、扫描预检时掉线 → 扫描层显式 nodeUnavailable（Hub 目录仍返回）
  let onlineCalls = 0
  const envRace = await makeEnv({ online: () => (onlineCalls += 1) === 1 })
  t.after(() => envRace.close(), { timeout: 60_000 })
  writeHubSkill(envRace.dataDir, 'hub-skill', SKILL_MD('Hub Skill', 'still listed through the race'))
  const catalog = (await envRace.host.invokeAction('builtin:profile', 'skill_catalog', { nodeId: 'remote-1', cwd: ws })) as {
    nodeId: string
    skills: SkillSummary[]
    nodeUnavailable?: string
  }
  assert.equal(onlineCalls, 2, 'boundary precheck + scan precheck are the two registration probes')
  assert.ok(catalog.nodeUnavailable !== undefined, 'the post-boundary race surfaces an explicit diagnostic')
  assert.ok(catalog.nodeUnavailable.includes('remote-1'))
  assert.ok(catalog.skills.some((s) => s.id === 'hub-skill'), 'Hub skills are still returned')
  assert.ok(!catalog.skills.some((s) => s.id === 'remote-skill'))
  assert.deepEqual(envRace.backend.envCalls, [], 'offline stops before entering executionEnv')
})

test('skill_read: Hub hit wins first; node-only ids read live from the node (SKILL.md and references); boundary rejections', { timeout: 60_000 }, async (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => rmSync(ws, { recursive: true, force: true }))
  writeNodeSkill(ws, 'shared-name', SKILL_MD('Node Variant', 'unreachable node body'))
  writeNodeSkill(ws, 'node-only', SKILL_MD('Node Only', 'node body'), { 'references/guide.md': '# node guide\n' })
  const env = await makeEnv()
  t.after(() => env.close(), { timeout: 60_000 })
  writeHubSkill(env.dataDir, 'shared-name', SKILL_MD('Hub Variant', 'hub body wins'))

  const hubRead = (await env.host.invokeAction('builtin:profile', 'skill_read', { skillId: 'shared-name', nodeId: 'local', cwd: ws })) as { text: string }
  assert.ok(hubRead.text.includes('Hub Variant'), 'Hub catalog hit reads the Hub version first')
  assert.ok(!hubRead.text.includes('Node Variant'))
  const callsAfterHubRead = env.backend.envCalls.length
  await env.host.invokeAction('builtin:profile', 'skill_read', { skillId: 'shared-name', nodeId: 'local', cwd: ws })
  assert.equal(env.backend.envCalls.length, callsAfterHubRead, 'Hub-resolved reads never touch the node env')

  const nodeRead = (await env.host.invokeAction('builtin:profile', 'skill_read', { skillId: 'node-only', nodeId: 'local', cwd: ws })) as { text: string }
  assert.ok(nodeRead.text.includes('Node Only'))
  const refRead = (await env.host.invokeAction('builtin:profile', 'skill_read', { skillId: 'node-only', path: 'references/guide.md', nodeId: 'local', cwd: ws })) as { text: string }
  assert.ok(refRead.text.includes('# node guide'))

  const notFound = await actionErr(env, 'skill_read', { skillId: 'missing-everywhere', nodeId: 'local', cwd: ws })
  assert.equal(notFound.code, 'not_found')
  assert.equal(notFound.status, 404)
  const traversal = await actionErr(env, 'skill_read', { skillId: 'node-only', path: '../escape.md', nodeId: 'local', cwd: ws })
  assert.equal(traversal.code, 'validation_error')
  assert.equal(traversal.status, 400)
})

test('skill_read: session-context calls are excluded by scope; context-free explicit coordinates are the only path', { timeout: 60_000 }, async (t) => {
  const wsA = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  const wsB = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => {
    rmSync(wsA, { recursive: true, force: true })
    rmSync(wsB, { recursive: true, force: true })
  })
  writeNodeSkill(wsA, 'ws-a-skill', SKILL_MD('A Skill', 'from workspace A'))
  writeNodeSkill(wsB, 'ws-b-skill', SKILL_MD('B Skill', 'from workspace B'))
  // online:()=>false 使未注册 nodeId 在边界被拒；local 靶点恒不查 isOnline
  const env = await makeEnv({ online: () => false })
  t.after(() => env.close(), { timeout: 60_000 })
  env.backend.conversations.set(1, makeConversation(1, { cwd: wsA }))

  // 会话上下文（无论 body 给什么坐标）一律 403——Profile.skills 白名单语义只归 load_skill
  for (const input of [{ skillId: 'ws-a-skill' }, { skillId: 'ws-b-skill', nodeId: 'local', cwd: wsB }]) {
    const err = await actionErr(env, 'skill_read', input, { conversationId: 1 })
    assert.equal(err.code, 'conversation_scope_violation')
    assert.equal(err.status, 403)
  }

  // 无会话上下文 + 显式成对坐标：人类调用方自由选择靶点（CLI --current 由客户端解析坐标后走此路径）
  const readA = (await env.host.invokeAction('builtin:profile', 'skill_read', { skillId: 'ws-a-skill', nodeId: 'local', cwd: wsA })) as { text: string }
  assert.ok(readA.text.includes('from workspace A'))
  const readB = (await env.host.invokeAction('builtin:profile', 'skill_read', { skillId: 'ws-b-skill', nodeId: 'local', cwd: wsB })) as { text: string }
  assert.ok(readB.text.includes('from workspace B'))

  const missingCoords = await actionErr(env, 'skill_read', { skillId: 'ws-b-skill' })
  assert.equal(missingCoords.code, 'validation_error')
  const relative = await actionErr(env, 'skill_read', { skillId: 'ws-b-skill', nodeId: 'local', cwd: 'relative/path' })
  assert.equal(relative.code, 'validation_error')
  const ghost = await actionErr(env, 'skill_read', { skillId: 'ws-b-skill', nodeId: 'ghost-node', cwd: wsB })
  assert.equal(ghost.code, 'validation_error')
  assert.ok(ghost.message.includes('not currently registered'))
})

test('skill_read: an offline race after the boundary still fails explicitly (409 node_offline)', { timeout: 60_000 }, async (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => rmSync(ws, { recursive: true, force: true }))
  writeNodeSkill(ws, 'node-tool', SKILL_MD('Node Tool', 'drops offline mid-call'))
  let onlineCalls = 0
  const env = await makeEnv({ online: () => (onlineCalls += 1) === 1 })
  t.after(() => env.close(), { timeout: 60_000 })

  const err = await actionErr(env, 'skill_read', { skillId: 'node-tool', nodeId: 'remote-1', cwd: ws })
  assert.equal(err.code, 'node_offline', 'the read layer keeps its explicit offline semantics for races')
  assert.equal(err.status, 409)
})

test('remote node machine roots (~/.helmx/skills > ~/.agents/skills > <cwd>/.helmx/skills): priority, read isolation, and home-as-cwd dedup', { timeout: 60_000 }, async (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => rmSync(ws, { recursive: true, force: true }))
  const env = await makeEnv()
  t.after(() => env.close(), { timeout: 60_000 })

  // Seed Hub, node ~/.helmx/skills, node ~/.agents/skills, and workspace <cwd>/.helmx/skills
  writeHubSkill(env.dataDir, 'hub-wins', SKILL_MD('Hub Wins', 'from hub'))

  const writeRootSkill = (root: string, id: string, md: string, refs: Record<string, string> = {}) => {
    const dir = join(root, id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), md)
    for (const [rel, body] of Object.entries(refs)) {
      const full = join(dir, rel)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, body)
    }
  }

  const nodeHelmxRoot = join(env.homeDir, '.helmx', 'skills')
  const nodeAgentsRoot = join(env.homeDir, '.agents', 'skills')
  writeRootSkill(nodeHelmxRoot, 'hub-wins', SKILL_MD('Node Helmx Shadowed', 'must be shadowed by Hub'))
  writeRootSkill(nodeHelmxRoot, 'node-helmx-only', SKILL_MD('Node Helmx', 'personal root'))
  writeRootSkill(nodeHelmxRoot, 'node-override', SKILL_MD('Node Helmx Override', 'wins over node agents'))
  writeRootSkill(nodeAgentsRoot, 'node-override', SKILL_MD('Node Agents Lower', 'shadowed by node ~/.helmx'), {
    'references/only-in-agents.md': 'must not leak across roots\n',
  })
  writeRootSkill(nodeAgentsRoot, 'node-agents-only', SKILL_MD('Node Agents', 'shared root'), {
    'references/guide.md': '# agents guide\n',
  })
  writeRootSkill(nodeAgentsRoot, 'ws-override', SKILL_MD('Node Agents Higher', 'wins over workspace'))
  writeNodeSkill(ws, 'ws-override', SKILL_MD('Workspace Lower', 'shadowed by node ~/.agents'))
  writeNodeSkill(ws, 'ws-only', SKILL_MD('Workspace Only', 'project supplement'))

  // 1. Standalone nodeId (no cwd): merges Hub + ~/.helmx/skills + ~/.agents/skills; Hub shadows 'hub-wins'
  const nodeOnlyCatalog = (await env.host.invokeAction('builtin:profile', 'skill_catalog', {
    nodeId: 'remote-1',
  })) as {
    nodeId: string
    cwd?: string
    skills: SkillSummary[]
    shadowedNodeSkillIds: string[]
  }
  assert.equal(nodeOnlyCatalog.nodeId, 'remote-1')
  assert.equal(nodeOnlyCatalog.cwd, undefined)
  assert.deepEqual(nodeOnlyCatalog.shadowedNodeSkillIds, ['hub-wins'])
  const byId = new Map(nodeOnlyCatalog.skills.map((s) => [s.id, s]))
  assert.equal(byId.get('hub-wins')?.name, 'Hub Wins')
  assert.equal(byId.get('node-helmx-only')?.source, 'node')
  assert.equal(byId.get('node-agents-only')?.source, 'node')
  assert.equal(byId.get('node-override')?.name, 'Node Helmx Override')
  assert.equal(byId.has('ws-only'), false, 'workspace-only skill is not included when cwd is omitted')

  // 2. skill_read without cwd reads node machine skills directly; higher-priority root owns skillId (no cross-root reference leak)
  const agentsRead = (await env.host.invokeAction('builtin:profile', 'skill_read', {
    nodeId: 'remote-1',
    skillId: 'node-agents-only',
    path: 'references/guide.md',
  })) as { text: string }
  assert.equal(agentsRead.text, '# agents guide\n')
  const overrideRead = (await env.host.invokeAction('builtin:profile', 'skill_read', {
    nodeId: 'remote-1',
    skillId: 'node-override',
  })) as { text: string }
  assert.ok(overrideRead.text.includes('Node Helmx Override'))
  const crossRootMiss = await actionErr(env, 'skill_read', {
    nodeId: 'remote-1',
    skillId: 'node-override',
    path: 'references/only-in-agents.md',
  })
  assert.equal(crossRootMiss.code, 'not_found', 'owning root lacks reference -> 404, never leaks from lower root')

  // 3. With workspace cwd: adds workspace .helmx/skills as lowest node priority; runtime before_turn/load_skill align
  const fullCatalog = (await env.host.invokeAction('builtin:profile', 'skill_catalog', {
    nodeId: 'remote-1',
    cwd: ws,
  })) as {
    nodeId: string
    cwd?: string
    skills: SkillSummary[]
    shadowedNodeSkillIds: string[]
  }
  assert.equal(fullCatalog.cwd, ws)
  const fullById = new Map(fullCatalog.skills.map((s) => [s.id, s]))
  assert.equal(fullById.get('ws-only')?.source, 'node')
  assert.equal(fullById.get('ws-override')?.name, 'Node Agents Higher')

  const beforeTurnCatalog = skillSection(await runBeforeTurn(env, makeTurn(ws, { nodeId: 'remote-1' })))
  assert.ok(beforeTurnCatalog?.includes('node-agents-only'))
  assert.ok(beforeTurnCatalog?.includes('ws-only'))
  env.backend.conversations.set(99, makeConversation(99, { nodeId: 'remote-1', cwd: ws }))
  const runtimeRead = await loadSkillOk(env, 99, { skillId: 'node-agents-only', path: 'references/guide.md' })
  assert.equal(runtimeRead, '# agents guide\n')

  // 4. When cwd === homeDir (e.g. a remote profile defaulting cwd to ~), canonicalPath dedup skips scanning ~/.helmx/skills twice
  const homeAsCwdCatalog = (await env.host.invokeAction('builtin:profile', 'skill_catalog', {
    nodeId: 'remote-1',
    cwd: env.homeDir,
  })) as {
    skills: SkillSummary[]
    shadowedNodeSkillIds: string[]
  }
  assert.deepEqual(homeAsCwdCatalog.shadowedNodeSkillIds, ['hub-wins'])
  assert.equal(
    homeAsCwdCatalog.skills.filter((s) => s.id === 'node-helmx-only').length,
    1,
    'skill in ~/.helmx/skills is never duplicated when cwd equals homeDir',
  )
})

test('before_turn deduplicates profiles.get(profileId) to a single lookup per turn', { timeout: 60_000 }, async (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'helmx-profile-dedup-'))
  t.after(() => rmSync(ws, { recursive: true, force: true }))
  const env = await makeEnv()
  t.after(() => env.close(), { timeout: 60_000 })

  let getCount = 0
  const originalGet = env.backend.profiles.get.bind(env.backend.profiles)
  env.backend.profiles.get = async (id: string) => {
    getCount += 1
    return originalGet(id)
  }

  await runBeforeTurn(env, makeTurn(ws))
  assert.equal(getCount, 1, 'before_turn must call profiles.get(profileId) exactly once per turn')
})

test('node-skills optimizations: shadowed Hub IDs skip SKILL.md/references IO, collectNodeReferences enforces depth=8 & early-exit at 513, frontmatter.name redacts, and TTL cache invalidates on load_skill miss', { timeout: 60_000 }, async (t) => {
  const { MAX_NODE_SKILL_REFERENCES, MAX_NODE_SKILL_REFERENCE_DEPTH, readNodeSkillFile } = await import('../src/profile.js')
  const ws = mkdtempSync(join(tmpdir(), 'helmx-node-skills-opt-'))
  t.after(() => rmSync(ws, { recursive: true, force: true }))

  // 1) Shadowed skill has SKILL.md + refs, while visible skill has depth > 8 + secret in frontmatter.name
  const shadowedDir = writeNodeSkill(ws, 'hub-shadowed', SKILL_MD('Shadowed Node', 'should never be opened'), {
    'references/never-listed.md': 'nope',
  })
  const deepWithinCap = `${Array.from({ length: MAX_NODE_SKILL_REFERENCE_DEPTH }, (_, i) => `d${i + 1}`).join('/')}/at-cap.md`
  const deepBeyondCap = `${Array.from({ length: MAX_NODE_SKILL_REFERENCE_DEPTH + 2 }, (_, i) => `d${i + 1}`).join('/')}/beyond-cap.md`
  writeNodeSkill(
    ws,
    'visible-skill',
    '---\nname: Visible sk-name-secret Skill\ndescription: safe desc\n---\nbody\n',
    {
      [deepWithinCap]: 'within depth 8',
      [deepBeyondCap]: 'beyond depth 8',
    },
  )

  let openedShadowedSkillMd = false
  let listRootCalls = 0
  let fakeNow = 10_000
  const baseEnv = new NodeExecutionEnv({ cwd: ws })
  const trackingHost = {
    nodeIpc: { isOnline: () => true },
    redact: (text: string) => text.replace(/sk-name-secret/g, '[REDACTED]'),
    executionEnv: () => ({
      ...baseEnv,
      canonicalPath: (p: string, ctx: never) => baseEnv.canonicalPath(p, ctx),
      fileInfo: (p: string, ctx: never) => baseEnv.fileInfo(p, ctx),
      listDir: async (p: string, ctx: never) => {
        if (p.replaceAll('\\', '/').endsWith('.helmx/skills')) listRootCalls += 1
        return baseEnv.listDir(p, ctx)
      },
      openBinaryReader: async (p: string, opts: never, ctx: never) => {
        if (p.startsWith(shadowedDir)) openedShadowedSkillMd = true
        return baseEnv.openBinaryReader(p, opts, ctx)
      },
    }),
  }

  const first = await scanNodeSkills(trackingHost as never, 'local', ws, {
    shadowedIds: new Set(['hub-shadowed']),
    cacheTtlMs: 5_000,
    now: () => fakeNow,
  })
  assert.equal(first.kind, 'ok')
  assert.equal(openedShadowedSkillMd, false, 'shadowed Hub skill directory must skip opening SKILL.md')
  assert.deepEqual(first.shadowedSkillIds, ['hub-shadowed'])
  assert.equal(first.skills.length, 1)
  assert.equal(first.skills[0]!.name, 'Visible [REDACTED] Skill', 'frontmatter.name must pass through host.redact')
  assert.ok(first.skills[0]!.references.includes(deepWithinCap), 'depth 8 reference is collected')
  assert.equal(first.skills[0]!.references.includes(deepBeyondCap), false, 'depth > 8 subdirectories are not descended')
  assert.equal(listRootCalls, 1)

  // 2) Short TTL cache hit within 5_000ms skips re-scanning disk
  fakeNow += 1_000
  const cachedHit = await scanNodeSkills(trackingHost as never, 'local', ws, {
    shadowedIds: new Set(['hub-shadowed']),
    cacheTtlMs: 5_000,
    now: () => fakeNow,
  })
  assert.equal(cachedHit.kind, 'ok')
  assert.equal(listRootCalls, 1, 'TTL cache hit must not re-list .helmx/skills')

  // 3) Read miss (not_found) immediately invalidates cache for (nodeId, cwd) before TTL expires
  await assert.rejects(
    () => readNodeSkillFile(trackingHost as never, 'local', ws, 'newly-added-skill', 'SKILL.md'),
    (err: unknown) => err instanceof HelmxError && err.code === 'not_found',
  )
  await scanNodeSkills(trackingHost as never, 'local', ws, {
    shadowedIds: new Set(['hub-shadowed']),
    cacheTtlMs: 5_000,
    now: () => fakeNow,
  })
  assert.equal(listRootCalls, 2, 'not_found miss on readNodeSkillFile must invalidate TTL cache immediately')

  // 4) Early exit at MAX_NODE_SKILL_REFERENCES + 1: stops listing extra subdirectories once 513 files are seen
  const manyWs = mkdtempSync(join(tmpdir(), 'helmx-node-skills-cap-'))
  t.after(() => rmSync(manyWs, { recursive: true, force: true }))
  const refs: Record<string, string> = {}
  for (let b = 0; b < 10; b += 1) {
    for (let f = 0; f < 100; f += 1) {
      refs[`b${String(b).padStart(2, '0')}/f${String(f).padStart(3, '0')}.md`] = 'x'
    }
  }
  writeNodeSkill(manyWs, 'too-many-refs', SKILL_MD('Too Many', 'exceeds cap'), refs)
  let bucketListCalls = 0
  const capBaseEnv = new NodeExecutionEnv({ cwd: manyWs })
  const capHost = {
    nodeIpc: { isOnline: () => true },
    redact: (t2: string) => t2,
    executionEnv: () => ({
      ...capBaseEnv,
      canonicalPath: (p: string, ctx: never) => capBaseEnv.canonicalPath(p, ctx),
      fileInfo: (p: string, ctx: never) => capBaseEnv.fileInfo(p, ctx),
      openBinaryReader: (p: string, opts: never, ctx: never) => capBaseEnv.openBinaryReader(p, opts, ctx),
      listDir: async (p: string, ctx: never) => {
        if (/\/b\d{2}$/.test(p.replaceAll('\\', '/'))) bucketListCalls += 1
        return capBaseEnv.listDir(p, ctx)
      },
    }),
  }
  const overCap = await scanNodeSkills(capHost as never, 'local', manyWs, { cacheTtlMs: 0 })
  assert.equal(overCap.kind, 'unavailable')
  assert.match(overCap.reason, new RegExp(String(MAX_NODE_SKILL_REFERENCES)))
  assert.ok(bucketListCalls <= 6, `must early-exit at 513 files instead of scanning all 10 buckets (scanned ${bucketListCalls})`)
})

test('node skill ID / fallback name / references / shadowedSkillIds / diagnostics / readNodeSkillFile errors are redacted', { timeout: 60_000 }, async (t) => {
  const { MAX_NODE_SKILL_FILE_BYTES, readNodeSkillFile } = await import('../src/profile.js')
  const secretA = 'sk-id-secret-alpha'
  const secretB = 'sk-id-secret-beta'
  const ws = mkdtempSync(join(tmpdir(), 'helmx-node-skills-id-redact-'))
  t.after(() => rmSync(ws, { recursive: true, force: true }))

  // Skill with secret in directory id, omitted frontmatter.name (falls back to id), and secret in reference path
  writeNodeSkill(
    ws,
    `tool-${secretA}-${secretB}`,
    '---\ndescription: safe body\n---\n# body\n',
    { [`references/${secretA}.md`]: 'ref' },
  )
  writeNodeSkill(ws, `hub-${secretA}`, SKILL_MD('Hub Shadowed', 'desc'))

  let activeSecrets = [secretA]
  const dynamicRedact = (text: string): string => {
    let out = text
    for (const s of activeSecrets) out = out.split(s).join('[REDACTED]')
    return out
  }
  const baseEnv = new NodeExecutionEnv({ cwd: ws })
  const host = {
    nodeIpc: { isOnline: () => true },
    redact: dynamicRedact,
    executionEnv: () => baseEnv,
  }
  let fakeNow = 50_000

  // 1) Fresh scan redacts secretA from id, fallback name, references, and shadowedSkillIds
  const fresh = await scanNodeSkills(host as never, 'local', ws, {
    shadowedIds: new Set([`hub-${secretA}`]),
    cacheTtlMs: 5_000,
    now: () => fakeNow,
  })
  assert.equal(fresh.kind, 'ok')
  assert.equal(JSON.stringify(fresh).includes(secretA), false, 'fresh scan output must not leak secret in skill id/name/refs/shadowedSkillIds')
  assert.equal(fresh.skills[0]!.id, `tool-[REDACTED]-${secretB}`)
  assert.equal(fresh.skills[0]!.name, `tool-[REDACTED]-${secretB}`)
  assert.deepEqual(fresh.skills[0]!.references, ['references/[REDACTED].md'])
  assert.deepEqual(fresh.shadowedSkillIds, ['hub-[REDACTED]'])

  // 2) Cache hit re-redacts newly registered secretB from id, fallback name, references, and shadowedSkillIds
  activeSecrets = [secretA, secretB]
  fakeNow += 1_000
  const cached = await scanNodeSkills(host as never, 'local', ws, {
    shadowedIds: new Set([`hub-${secretA}`]),
    cacheTtlMs: 5_000,
    now: () => fakeNow,
  })
  assert.equal(cached.kind, 'ok')
  assert.equal(JSON.stringify(cached).includes(secretA), false)
  assert.equal(JSON.stringify(cached).includes(secretB), false, 'cache hit must re-redact newly added secret from skill id/name')
  assert.equal(cached.skills[0]!.id, 'tool-[REDACTED]-[REDACTED]')
  assert.equal(cached.skills[0]!.name, 'tool-[REDACTED]-[REDACTED]')

  // 3) before_turn system prompt catalog must not leak secret in skill id
  const env = await makeEnv({ redact: dynamicRedact })
  t.after(() => env.close(), { timeout: 60_000 })
  const catalog = skillSection(await runBeforeTurn(env, makeTurn(ws)))
  assert.ok(catalog !== undefined)
  assert.equal(catalog.includes(secretA), false)
  assert.equal(catalog.includes(secretB), false)
  assert.ok(catalog.includes('tool-[REDACTED]-[REDACTED]'))

  // 4) Unavailable diagnostic redacts skill id & path (e.g. oversized SKILL.md)
  const badWs = mkdtempSync(join(tmpdir(), 'helmx-node-skills-bad-id-'))
  t.after(() => rmSync(badWs, { recursive: true, force: true }))
  writeNodeSkill(badWs, `big-${secretA}`, 'x'.repeat(MAX_NODE_SKILL_FILE_BYTES + 16))
  const badHost = {
    nodeIpc: { isOnline: () => true },
    redact: dynamicRedact,
    executionEnv: () => new NodeExecutionEnv({ cwd: badWs }),
  }
  const unavail = await scanNodeSkills(badHost as never, 'local', badWs, { cacheTtlMs: 0 })
  assert.equal(unavail.kind, 'unavailable')
  assert.equal(unavail.reason.includes(secretA), false, 'unavailable diagnostic must redact skill id and path')
  assert.ok(unavail.reason.includes('[REDACTED]'))

  // 5) readNodeSkillFile errors (validation_error / not_found / node_offline) redact skillId & path in message and details
  const assertErrRedacted = async (fn: () => Promise<unknown>, expectedCode: string): Promise<void> => {
    try {
      await fn()
      assert.fail(`expected ${expectedCode}`)
    } catch (err) {
      assert.ok(err instanceof HelmxError)
      assert.equal(err.code, expectedCode)
      assert.equal(err.message.includes(secretA), false, `${expectedCode} message must redact secret: ${err.message}`)
      assert.equal(JSON.stringify(err.details ?? {}).includes(secretA), false, `${expectedCode} details must redact secret`)
    }
  }
  await assertErrRedacted(() => readNodeSkillFile(host as never, 'local', ws, `../${secretA}`, 'SKILL.md'), 'validation_error')
  await assertErrRedacted(() => readNodeSkillFile(host as never, 'local', ws, 'valid-id', `../${secretA}`), 'validation_error')
  await assertErrRedacted(() => readNodeSkillFile(host as never, 'local', ws, `missing-${secretA}`, 'SKILL.md'), 'not_found')
  const offlineHost = { ...host, nodeIpc: { isOnline: () => false } }
  await assertErrRedacted(() => readNodeSkillFile(offlineHost as never, 'remote-1', ws, `remote-${secretA}`, 'SKILL.md'), 'node_offline')
})
