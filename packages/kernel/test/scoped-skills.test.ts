/**
 * Kernel coordinate-scoped skill discovery, HTTP routes, `core:skills` actions, and `load_skill` tool tests.
 *
 * Covers:
 * - Node skill discovery (`~/.helmx/skills`, `~/.agents/skills`, `<cwd>/.helmx/skills`):
 *   skipping dotfiles/node_modules/symlinks/invalid ids/broken frontmatter, stripping spoofed
 *   `managedByPlugin`, Hub > node precedence, shadowed node skill reporting, entry/byte/depth caps;
 * - Per-conversation isolation (`nodeId`, `cwd`) and `Profile.skills` whitelist filtering;
 * - Live reads (`load_skill` kernel tool & `GET /api/skills/:id?nodeId=...&cwd=...`), path safety,
 *   secret redaction across IDs/references/diagnostics/errors, mid-read change rejection;
 * - `core:skills.catalog` / `core:skills.read` ACL (`scope: { conversationIds: [] }`), strict input validation,
 *   and HTTP `GET /api/skills/scoped/catalog` & `GET /api/skills/:id`;
 * - `TurnContextAssembler`: `profiles.get` deduplicated to 1 lookup/turn, `resolvePostSections(false)` clearing skills.
 *
 * Runner: node --test / run-tests; timeout: 60_000.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  HelmxError,
  type ConversationSummary,
  type PluginSummary,
  type SkillSummary,
} from '@helmx/protocol'
import {
  FileError,
  type BinaryReader,
  type ExecutionEnv,
  type FileInfo,
  type Result,
} from '@earendil-works/pi-durable/env'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { makeConversationSummary, MemoryDocStore } from './helpers.js'
import { createPluginHostBackendFixture } from './helpers/plugin-host-backend.js'
import { ProfileService, SkillService } from '../src/services/index.js'
import {
  MAX_NODE_SKILL_FILE_BYTES,
  MAX_NODE_SKILL_REFERENCES,
  MAX_NODE_SKILL_REFERENCE_DEPTH,
  MAX_NODE_SKILLS,
  NODE_SKILLS_RELATIVE_DIR,
  readNodeSkillFile,
  scanNodeSkills,
  type NodeSkillsHostPort,
} from '../src/runtime/node-skills.js'
import { ScopedSkillService } from '../src/runtime/scoped-skills.js'
import { TurnContextAssembler } from '../src/runtime/turn-context.js'
import { createLoadSkillTool } from '../src/runtime/tools/skill-tools.js'
import { registerSkillCoreActions } from '../src/runtime/core-actions/skill.js'
import { handleSkillsDomain } from '../src/http/asset-routes.js'
import { decodeSegment } from '../src/http/route-match.js'
import { PluginHost } from '../src/plugins/index.js'

const makeConversation = (id: number, over: Partial<ConversationSummary> = {}): ConversationSummary =>
  makeConversationSummary({ id, ...over })

interface EnvCall {
  nodeId: string
  cwd: string
}

interface EnvOptions {
  online?: (nodeId: string) => boolean
  envFor?: (nodeId: string, cwd: string) => ExecutionEnv
  redact?: (text: string) => string
  homeDir?: string
}

function expandTestHome(path: string, homeDir: string): string {
  if (path === '~') return homeDir
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homeDir, path.slice(2))
  return path
}

/** Wraps ExecutionEnv to map `~` into an isolated temp directory (never touching host `~/.agents/skills`). */
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

interface TestEnv {
  dataDir: string
  homeDir: string
  profiles: ProfileService
  skills: SkillService
  scopedSkills: ScopedSkillService
  assembler: TurnContextAssembler
  host: PluginHost
  conversations: Map<number, ConversationSummary>
  envCalls: EnvCall[]
  pluginsSnapshot: PluginSummary[]
  loadSkillTool: ReturnType<typeof createLoadSkillTool>
  close(): Promise<void>
}

async function makeEnv(opts: EnvOptions = {}): Promise<TestEnv> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helmx-kernel-skills-'))
  const homeDir = opts.homeDir ?? mkdtempSync(join(tmpdir(), 'helmx-kernel-home-'))
  const ownsHome = opts.homeDir === undefined
  const profiles = new ProfileService(dataDir)
  await profiles.ensureDefault()
  const skills = new SkillService(dataDir, { externalRoots: [] })
  const conversations = new Map<number, ConversationSummary>()
  const envCalls: EnvCall[] = []
  const pluginsSnapshot: PluginSummary[] = []
  const redact = opts.redact ?? ((t: string) => t)
  const isNodeOnline = opts.online ?? (() => true)
  const executionEnv = (nodeId: string, cwd: string): ExecutionEnv => {
    envCalls.push({ nodeId, cwd })
    const base = opts.envFor ? opts.envFor(nodeId, cwd) : new NodeExecutionEnv({ cwd })
    return withTestHome(base, homeDir)
  }
  const getConversation = (id: number): ConversationSummary => {
    const found = conversations.get(id)
    if (!found) throw new HelmxError('not_found', `conversation not found: ${id}`, 404, { conversationId: id })
    return found
  }
  const scopedSkills = new ScopedSkillService({
    skills,
    profiles,
    getConversation,
    executionEnv,
    redact,
    isNodeOnline,
    listPlugins: () => [...pluginsSnapshot, ...host.list()],
  })
  const assembler = new TurnContextAssembler({
    profiles,
    scopedSkills,
    executionEnv,
    isNodeOnline,
    redact,
    notifyWarning: () => {},
  })
  const host = new PluginHost({
    dataDir,
    host: Object.assign(createPluginHostBackendFixture(), {
      getConversation,
      emitEvent: async () => {},
    }),
    docs: new MemoryDocStore(),
  })
  registerSkillCoreActions({ skills, scopedSkills } as never, host)
  const loadSkillTool = createLoadSkillTool({
    redact,
    loadSkillForConversation: (cid, input) => scopedSkills.loadSkillForConversation(cid, input),
  })
  return {
    dataDir,
    homeDir,
    profiles,
    skills,
    scopedSkills,
    assembler,
    host,
    conversations,
    envCalls,
    pluginsSnapshot,
    loadSkillTool,
    async close() {
      await host.dispose().catch(() => {})
      rmSync(dataDir, { recursive: true, force: true })
      if (ownsHome) rmSync(homeDir, { recursive: true, force: true })
    },
  }
}

async function assembleTurn(env: TestEnv, cwd: string, over: Partial<ConversationSummary> = {}, loadSkillActive = true) {
  const conv = makeConversation(1, { cwd, ...over })
  const prepared = await env.assembler.prepare(conv)
  const pre = env.assembler.applyPreSections([], prepared.preSections)
  return env.assembler.applyPostSections(pre, prepared.resolvePostSections(loadSkillActive))
}

async function loadSkillOk(env: TestEnv, conversationId: number, input: { skillId: string; path?: string }): Promise<string> {
  const res = await env.loadSkillTool.execute(input, { conversationId } as never, {} as never)
  assert.notEqual(res.isError, true, `expected load_skill success, got: ${JSON.stringify(res)}`)
  assert.ok(res.output && res.output[0], 'expected non-empty load_skill output')
  return (res.output[0] as { type: 'text'; text: string }).text
}

async function loadSkillErr(env: TestEnv, conversationId: number, input: { skillId: string; path?: string }): Promise<HelmxError> {
  try {
    await env.scopedSkills.loadSkillForConversation(conversationId, input)
  } catch (err) {
    assert.ok(err instanceof HelmxError, `expected HelmxError, got: ${String(err)}`)
    return err
  }
  assert.fail('expected loadSkillForConversation to throw')
}

function skillSection(sections: Array<{ id: string; text: string }>): string | undefined {
  return sections.find((s) => s.id === 'profile.skills')?.text
}

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

function writeHubSkill(dataDir: string, id: string, skillMd: string): void {
  const dir = join(dataDir, 'skills', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), skillMd)
}

const SKILL_MD = (name: string, description: string): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nBody.\n`

// ---------------------------------------------------------------------------
// scanNodeSkills unit tests
// ---------------------------------------------------------------------------

test('scanNodeSkills: workspace without .helmx/skills is an ordinary empty (ok, no diagnostics)', { timeout: 60_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }), { timeout: 60_000 })
  const host: NodeSkillsHostPort = {
    executionEnv: (_nodeId, cwd) => new NodeExecutionEnv({ cwd }),
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
  assert.ok(!envCreated)

  const fakeHome = mkdtempSync(join(tmpdir(), 'helmx-node-home-'))
  t.after(() => rmSync(fakeHome, { recursive: true, force: true }), { timeout: 60_000 })
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
  assert.deepEqual((remoteScan as { skills: SkillSummary[] }).skills.map((s) => s.id), ['remote-shared'])
})

// ---------------------------------------------------------------------------
// TurnContextAssembler skill catalog injection & isolation
// ---------------------------------------------------------------------------

test('TurnContextAssembler injects node skills into <available_skills> and skips invalid entries', { timeout: 60_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }), { timeout: 60_000 })
  writeNodeSkill(workspace, 'deploy-helper', SKILL_MD('Deploy Helper', 'Node-local deploy runbook'), {
    'references/runbook.md': '# runbook\nstep 1\n',
    'references/advanced/tuning.md': '# tuning\n',
  })
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
  const sections = await assembleTurn(env, workspace)
  const catalog = skillSection(sections)
  assert.ok(catalog !== undefined)
  assert.ok(catalog.includes('<skill id="deploy-helper">'))
  assert.ok(catalog.includes('<name>Deploy Helper</name>'))
  assert.ok(catalog.includes('<description>Node-local deploy runbook</description>'))
  assert.ok(catalog.includes('<references>references/advanced/tuning.md, references/runbook.md</references>'))
  for (const missing of ['.hidden-skill', 'in-node-modules', 'bad id', 'no-skill-md', 'broken-frontmatter']) {
    assert.ok(!catalog.includes(missing), `skipped entry not in catalog: ${missing}`)
  }
  assert.ok(sections.every((s) => s.id !== 'profile.node-skills-unavailable'))
})

test('node SKILL.md managedByPlugin is stripped — the node cannot fake a host-managed skill', { timeout: 60_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }), { timeout: 60_000 })
  writeNodeSkill(workspace, 'fake-managed', '---\nname: Fake\nmanagedByPlugin: builtin:mentions\n---\nbody\n')
  const host: NodeSkillsHostPort = {
    executionEnv: (_nodeId, cwd) => new NodeExecutionEnv({ cwd }),
    redact: (text) => text,
    nodeIpc: { isOnline: () => true },
  }
  const scan = await scanNodeSkills(host, 'local', workspace)
  assert.equal(scan.kind, 'ok')
  const skill = (scan as { skills: SkillSummary[] }).skills.find((s) => s.id === 'fake-managed')
  assert.ok(skill !== undefined)
  assert.equal(skill.managedByPlugin, undefined)
  assert.equal(skill.source, 'node')
})

test('same-name priority: Hub dataDir skill wins the catalog and load_skill; the node version is unreachable', { timeout: 60_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }), { timeout: 60_000 })
  writeNodeSkill(workspace, 'shared-name', SKILL_MD('Node Variant', 'node description must not surface'))
  const env = await makeEnv()
  t.after(() => env.close(), { timeout: 60_000 })
  writeHubSkill(env.dataDir, 'shared-name', SKILL_MD('Hub Variant', 'hub description wins'))
  env.conversations.set(1, makeConversation(1, { cwd: workspace }))

  const catalog = skillSection(await assembleTurn(env, workspace))
  assert.ok(catalog !== undefined)
  assert.ok(catalog.includes('<skill id="shared-name">'))
  assert.ok(catalog.includes('Hub Variant') && catalog.includes('hub description wins'))
  assert.ok(!catalog.includes('Node Variant') && !catalog.includes('node description must not surface'))

  const text = await loadSkillOk(env, 1, { skillId: 'shared-name' })
  assert.ok(text.includes('Hub Variant'))
  assert.ok(!text.includes('Node Variant'))
  const callsAfterCatalog = env.envCalls.length
  await loadSkillOk(env, 1, { skillId: 'shared-name' })
  assert.equal(env.envCalls.length, callsAfterCatalog)
})

test('node skills are isolated per conversation (nodeId, cwd)', { timeout: 60_000 }, async (t) => {
  const wsA = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  const wsB = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => {
    rmSync(wsA, { recursive: true, force: true })
    rmSync(wsB, { recursive: true, force: true })
  }, { timeout: 60_000 })
  writeNodeSkill(wsA, 'ws-a-only', SKILL_MD('A Only', 'from workspace A'))
  const env = await makeEnv()
  t.after(() => env.close(), { timeout: 60_000 })

  const catalogA = skillSection(await assembleTurn(env, wsA))
  const catalogB = skillSection(await assembleTurn(env, wsB))
  assert.ok(catalogA?.includes('ws-a-only'))
  assert.ok(!catalogB?.includes('ws-a-only'))
})

test('remote node skills route through executionEnv(nodeId, cwd) with online precheck; offline surfaces explicit diagnostic', { timeout: 60_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }), { timeout: 60_000 })
  writeNodeSkill(workspace, 'remote-skill', SKILL_MD('Remote Skill', 'lives on the remote node'))
  const onlineChecked: string[] = []
  const env = await makeEnv({ online: (nodeId) => (onlineChecked.push(nodeId), true) })
  t.after(() => env.close(), { timeout: 60_000 })

  const catalog = skillSection(await assembleTurn(env, workspace, { nodeId: 'remote-1' }))
  assert.ok(catalog?.includes('remote-skill'))
  assert.ok(onlineChecked.length >= 1 && onlineChecked.every((id) => id === 'remote-1'))
  assert.deepEqual(env.envCalls[0], { nodeId: 'remote-1', cwd: workspace })

  // Offline node
  const offlineEnv = await makeEnv({ online: () => false })
  t.after(() => offlineEnv.close(), { timeout: 60_000 })
  offlineEnv.conversations.set(1, makeConversation(1, { cwd: workspace, nodeId: 'remote-1' }))
  const sections = await assembleTurn(offlineEnv, workspace, { nodeId: 'remote-1' })
  const unavailable = sections.find((s) => s.id === 'profile.node-skills-unavailable')
  assert.ok(unavailable !== undefined)
  assert.ok(unavailable.text.includes('<node_skills_unavailable'))
  assert.ok(unavailable.text.includes('remote-1'))
  assert.ok(unavailable.text.includes('离线'))
  assert.deepEqual(offlineEnv.envCalls, [])

  const err = await loadSkillErr(offlineEnv, 1, { skillId: 'remote-skill' })
  assert.equal(err.code, 'node_offline')
  assert.equal(err.status, 409)

  // isOnline throwing node_ipc_unavailable
  const unwiredEnv = await makeEnv({
    online: () => {
      throw new HelmxError('node_ipc_unavailable', 'EnvFabric not wired', 501)
    },
  })
  t.after(() => unwiredEnv.close(), { timeout: 60_000 })
  const unwiredSections = await assembleTurn(unwiredEnv, workspace, { nodeId: 'remote-1' })
  assert.ok(unwiredSections.find((s) => s.id === 'profile.node-skills-unavailable')!.text.includes('node_ipc_unavailable'))
})

test('load_skill reads node SKILL.md and references live, enforces path safety & Profile whitelist', { timeout: 60_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }), { timeout: 60_000 })
  const dir = writeNodeSkill(
    workspace,
    'node-tool',
    SKILL_MD('Node Tool', 'v1 description'),
    { 'references/guide.md': '# guide v1\n' },
  )
  writeNodeSkill(workspace, 'node-other', SKILL_MD('Node Other', 'd'))
  const env = await makeEnv()
  t.after(() => env.close(), { timeout: 60_000 })
  env.conversations.set(1, makeConversation(1, { cwd: workspace }))

  assert.ok((await loadSkillOk(env, 1, { skillId: 'node-tool' })).includes('# Node Tool'))
  assert.equal(await loadSkillOk(env, 1, { skillId: 'node-tool', path: 'references/guide.md' }), '# guide v1\n')

  writeFileSync(join(dir, 'SKILL.md'), SKILL_MD('Node Tool', 'v2 description'))
  writeFileSync(join(dir, 'references', 'guide.md'), '# guide v2\n')
  assert.ok((await loadSkillOk(env, 1, { skillId: 'node-tool' })).includes('v2 description'))
  assert.equal(await loadSkillOk(env, 1, { skillId: 'node-tool', path: 'references/guide.md' }), '# guide v2\n')
  assert.ok(skillSection(await assembleTurn(env, workspace))?.includes('v2 description'))

  // Path traversal / absolute / backslash errors (load_skill tool returns isError: true with code)
  for (const path of ['../outside.md', 'references/../../outside.md', '/etc/passwd', 'a\\b.md']) {
    const err = await loadSkillErr(env, 1, { skillId: 'node-tool', path })
    assert.equal(err.code, 'validation_error')
    assert.equal(err.status, 400)
    const toolRes = await env.loadSkillTool.execute({ skillId: 'node-tool', path }, { conversationId: 1 } as never, {} as never)
    assert.equal(toolRes.isError, true)
    assert.ok(toolRes.output && toolRes.output[0])
    assert.ok((toolRes.output[0] as { text: string }).text.startsWith('validation_error:'))
  }

  const missing = await loadSkillErr(env, 1, { skillId: 'never-exists' })
  assert.equal(missing.code, 'not_found')
  assert.equal(missing.status, 404)

  // Profile whitelist
  const assistant = await env.profiles.get('assistant')
  await env.profiles.save({ ...assistant!, skills: ['node-tool'] })
  const catalog = skillSection(await assembleTurn(env, workspace))
  assert.ok(catalog?.includes('node-tool'))
  assert.ok(!catalog?.includes('node-other'))
  assert.ok((await loadSkillOk(env, 1, { skillId: 'node-tool' })).includes('# Node Tool'))
  const denied = await loadSkillErr(env, 1, { skillId: 'node-other' })
  assert.equal(denied.code, 'skill_not_available')
  assert.equal(denied.status, 403)
})

function sepLike(path: string): string {
  return path.includes('\\') && !path.includes('/') ? '\\' : '/'
}

function controlledEnv(
  workspace: string,
  over: {
    listDir?: (path: string) => Result<FileInfo[], FileError>
    wrapReader?: (path: string, reader: BinaryReader) => BinaryReader
  },
): ExecutionEnv {
  const real = new NodeExecutionEnv({ cwd: workspace })
  const listDir: ExecutionEnv['listDir'] = async (p, c) => (over.listDir ? over.listDir(p) : real.listDir(p, c))
  const openBinaryReader: ExecutionEnv['openBinaryReader'] = async (p, o, c) => {
    const opened = await real.openBinaryReader(p, o, c)
    if (!opened.ok || over.wrapReader === undefined) return opened
    return { ok: true, value: over.wrapReader(p, opened.value) }
  }
  return Object.assign(Object.create(real) as ExecutionEnv, {
    id: real.id,
    cwd: real.cwd,
    listDir,
    openBinaryReader,
  })
}

test('listDir permission failure, oversized SKILL.md, MAX_NODE_SKILLS cap, symlink dir skip, mid-read size change (502)', { timeout: 60_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }), { timeout: 60_000 })
  writeNodeSkill(workspace, 'node-tool', SKILL_MD('Node Tool', 'd'))

  const permEnv = await makeEnv({
    envFor: () =>
      controlledEnv(workspace, {
        listDir: (path) =>
          path.split(sepLike(path)).includes('skills') && path.includes('.helmx')
            ? { ok: false, error: new FileError('permission_denied', 'EACCES: permission denied', path) }
            : { ok: true, value: [] as FileInfo[] },
      }),
  })
  t.after(() => permEnv.close(), { timeout: 60_000 })
  writeHubSkill(permEnv.dataDir, 'hub-sample', SKILL_MD('Hub Sample', 'Hub fallback skill'))
  const sections = await assembleTurn(permEnv, workspace, { nodeId: 'remote-1' })
  assert.ok(sections.find((s) => s.id === 'profile.node-skills-unavailable')!.text.includes('permission_denied'))
  assert.ok(skillSection(sections) !== undefined)

  // Oversized & MAX_NODE_SKILLS & symlink
  const hostPort: NodeSkillsHostPort = {
    executionEnv: (_n, cwd) => new NodeExecutionEnv({ cwd }),
    redact: (text) => text,
    nodeIpc: { isOnline: () => true },
  }
  const hugeWs = mkdtempSync(join(tmpdir(), 'helmx-node-huge-'))
  t.after(() => rmSync(hugeWs, { recursive: true, force: true }), { timeout: 60_000 })
  const hugeDir = join(hugeWs, NODE_SKILLS_RELATIVE_DIR, 'huge-skill')
  mkdirSync(hugeDir, { recursive: true })
  writeFileSync(join(hugeDir, 'SKILL.md'), 'x'.repeat(MAX_NODE_SKILL_FILE_BYTES + 1))
  const hugeScan = await scanNodeSkills(hostPort, 'local', hugeWs)
  assert.equal(hugeScan.kind, 'unavailable')
  assert.ok((hugeScan as { reason: string }).reason.includes('huge-skill'))

  const capWs = mkdtempSync(join(tmpdir(), 'helmx-node-cap-'))
  t.after(() => rmSync(capWs, { recursive: true, force: true }), { timeout: 60_000 })
  for (let i = 0; i <= MAX_NODE_SKILLS; i++) {
    writeNodeSkill(capWs, `s${i.toString().padStart(4, '0')}`, SKILL_MD(`s${i}`, 'd'))
  }
  const capScan = await scanNodeSkills(hostPort, 'local', capWs)
  assert.equal(capScan.kind, 'unavailable')
  assert.ok((capScan as { reason: string }).reason.includes(String(MAX_NODE_SKILLS)))

  const symWs = mkdtempSync(join(tmpdir(), 'helmx-node-sym-'))
  t.after(() => rmSync(symWs, { recursive: true, force: true }), { timeout: 60_000 })
  const real = writeNodeSkill(symWs, 'real-skill', SKILL_MD('Real', 'd'))
  symlinkSync(real, join(symWs, NODE_SKILLS_RELATIVE_DIR, 'linked-skill'))
  const symScan = await scanNodeSkills(hostPort, 'local', symWs)
  assert.equal(symScan.kind, 'ok')
  const symIds = (symScan as { skills: SkillSummary[] }).skills.map((s) => s.id)
  assert.ok(symIds.includes('real-skill'))
  assert.ok(!symIds.includes('linked-skill'))

  // Mid-read size change (502)
  const raceEnv = await makeEnv({
    envFor: () =>
      controlledEnv(workspace, {
        wrapReader: (path, reader): BinaryReader => {
          if (!path.endsWith('SKILL.md')) return reader
          let infoCalls = 0
          return {
            info: async (ctx) => {
              infoCalls += 1
              if (infoCalls === 2) {
                writeFileSync(path, SKILL_MD('Node Tool', 'changed mid-read'))
              }
              return reader.info(ctx)
            },
            read: (offset, length, ctx) => reader.read(offset, length, ctx),
            scanLines: (o, ctx) => reader.scanLines(o, ctx),
            close: (ctx) => reader.close(ctx),
          }
        },
      }),
  })
  t.after(() => raceEnv.close(), { timeout: 60_000 })
  raceEnv.conversations.set(1, makeConversation(1, { cwd: workspace, nodeId: 'remote-1' }))
  const err = await loadSkillErr(raceEnv, 1, { skillId: 'node-tool' })
  assert.equal(err.code, 'node_skill_read_failed')
  assert.equal(err.status, 502)
})

// ---------------------------------------------------------------------------
// Core actions (`core:skills.catalog` / `core:skills.read`) & HTTP `/api/skills*`
// ---------------------------------------------------------------------------

async function actionErr(
  env: TestEnv,
  actionId: 'catalog' | 'read',
  input: unknown,
  context?: { conversationId: number },
): Promise<HelmxError> {
  try {
    await env.host.invokeAction('core:skills', actionId, input, context)
  } catch (err) {
    assert.ok(err instanceof HelmxError, `expected HelmxError, got: ${String(err)}`)
    return err
  }
  assert.fail(`expected core:skills.${actionId} to throw`)
}

test('core:skills.{catalog,read}: ACL scope excludes session contexts, requires explicit coordinates, shadows node duplicates, reports races', { timeout: 60_000 }, async (t) => {
  const manifests = (await (async () => {
    const env = await makeEnv()
    t.after(() => env.close(), { timeout: 60_000 })
    return env.host.listActions().filter((m) => m.pluginId === 'core:skills')
  })())
  assert.equal(manifests.length, 3)
  for (const manifest of manifests) {
    assert.equal(manifest.exposeToPrompt, false)
    assert.deepEqual(manifest.scope, { conversationIds: [] })
    assert.equal(manifest.idempotent, true)
  }

  const wsA = mkdtempSync(join(tmpdir(), 'helmx-core-skills-a-'))
  const wsB = mkdtempSync(join(tmpdir(), 'helmx-core-skills-b-'))
  t.after(() => {
    rmSync(wsA, { recursive: true, force: true })
    rmSync(wsB, { recursive: true, force: true })
  }, { timeout: 60_000 })
  writeNodeSkill(wsA, 'shared-name', SKILL_MD('Node Variant', 'shadowed node copy'))
  writeNodeSkill(wsA, 'node-only', SKILL_MD('Node Only', 'node body'), { 'references/guide.md': '# node guide\n' })
  writeNodeSkill(wsB, 'ws-b-skill', SKILL_MD('WS B', 'from B'))

  const env = await makeEnv()
  t.after(() => env.close(), { timeout: 60_000 })
  writeHubSkill(env.dataDir, 'shared-name', SKILL_MD('Hub Variant', 'hub wins'))
  env.conversations.set(1, makeConversation(1, { cwd: wsA }))

  // Session context blocked (403)
  for (const input of [{ nodeId: 'local' }, { nodeId: 'local', cwd: wsA }]) {
    const err = await actionErr(env, 'catalog', input, { conversationId: 1 })
    assert.equal(err.code, 'conversation_scope_violation')
    assert.equal(err.status, 403)
  }
  const readBlocked = await actionErr(env, 'read', { id: 'node-only', nodeId: 'local', cwd: wsA }, { conversationId: 1 })
  assert.equal(readBlocked.code, 'conversation_scope_violation')
  assert.equal(readBlocked.status, 403)

  // Validation errors
  for (const input of [{}, { cwd: wsA }, { nodeId: '  ' }]) {
    const err = await actionErr(env, 'catalog', input)
    assert.equal(err.code, 'validation_error')
  }
  assert.equal((await actionErr(env, 'catalog', { nodeId: 'local', cwd: 'relative/path' })).code, 'validation_error')
  assert.equal((await actionErr(env, 'catalog', { nodeId: 'local', cwd: wsA, bogus: true })).code, 'validation_error')

  // Local without cwd skips executionEnv
  const localOnly = (await env.host.invokeAction('core:skills', 'catalog', { nodeId: 'local' })) as {
    nodeId: string
    cwd?: string
    skills: SkillSummary[]
    shadowedNodeSkillIds: string[]
  }
  assert.equal(localOnly.nodeId, 'local')
  assert.equal(localOnly.cwd, undefined)
  assert.deepEqual(env.envCalls, [])

  // Local with cwd shadows duplicate node skill
  const catalog = (await env.host.invokeAction('core:skills', 'catalog', { nodeId: 'local', cwd: wsA })) as {
    nodeId: string
    cwd?: string
    skills: SkillSummary[]
    shadowedNodeSkillIds: string[]
  }
  assert.equal(catalog.skills.find((s) => s.id === 'shared-name')?.name, 'Hub Variant')
  assert.deepEqual(catalog.shadowedNodeSkillIds, ['shared-name'])
  assert.ok(catalog.skills.some((s) => s.id === 'node-only' && s.source === 'node'))

  // core:skills.read Hub wins over node; node references read live; traversal/missing rejected
  const hubRead = (await env.host.invokeAction('core:skills', 'read', { id: 'shared-name', nodeId: 'local', cwd: wsA })) as { text: string }
  assert.ok(hubRead.text.includes('Hub Variant'))
  const nodeRefRead = (await env.host.invokeAction('core:skills', 'read', {
    id: 'node-only',
    path: 'references/guide.md',
    nodeId: 'local',
    cwd: wsA,
  })) as { text: string }
  assert.equal(nodeRefRead.text, '# node guide\n')
  const readB = (await env.host.invokeAction('core:skills', 'read', { id: 'ws-b-skill', nodeId: 'local', cwd: wsB })) as { text: string }
  assert.ok(readB.text.includes('WS B'))
  assert.equal((await actionErr(env, 'read', { id: 'missing-everywhere', nodeId: 'local', cwd: wsA })).status, 404)
  assert.equal((await actionErr(env, 'read', { id: 'node-only', path: '../escape.md', nodeId: 'local', cwd: wsA })).code, 'path_traversal')

  // Real HTTP route dispatch (`GET /api/skills/scoped/catalog` and `GET /api/skills/:id?...`)
  const httpCatalogRes = await handleSkillsDomain(
    {
      request: new Request(`http://hub/api/skills/scoped/catalog?nodeId=local&cwd=${encodeURIComponent(wsA)}`),
      method: 'GET',
      segments: ['skills', 'scoped', 'catalog'].map(decodeSegment),
      url: new URL(`http://hub/api/skills/scoped/catalog?nodeId=local&cwd=${encodeURIComponent(wsA)}`),
    },
    { skills: env.skills, scopedSkills: env.scopedSkills },
    undefined,
  )
  assert.equal(httpCatalogRes.status, 200)
  const httpCatalog = (await httpCatalogRes.json()) as { shadowedNodeSkillIds: string[] }
  assert.deepEqual(httpCatalog.shadowedNodeSkillIds, ['shared-name'])

  const httpReadRes = await handleSkillsDomain(
    {
      request: new Request(`http://hub/api/skills/node-only?path=${encodeURIComponent('references/guide.md')}&nodeId=local&cwd=${encodeURIComponent(wsA)}`),
      method: 'GET',
      segments: ['skills', 'node-only'].map(decodeSegment),
      url: new URL(`http://hub/api/skills/node-only?path=${encodeURIComponent('references/guide.md')}&nodeId=local&cwd=${encodeURIComponent(wsA)}`),
    },
    { skills: env.skills, scopedSkills: env.scopedSkills },
    undefined,
  )
  assert.equal(httpReadRes.status, 200)
  assert.equal(((await httpReadRes.json()) as { text: string }).text, '# node guide\n')

  // Unregistered/offline rejection + post-boundary TOCTOU race
  const offlineEnv = await makeEnv({ online: () => false })
  t.after(() => offlineEnv.close(), { timeout: 60_000 })
  const ghostErr = await actionErr(offlineEnv, 'catalog', { nodeId: 'ghost-node', cwd: wsA })
  assert.equal(ghostErr.code, 'validation_error')
  assert.ok(ghostErr.message.includes('not currently registered'))

  let onlineCalls = 0
  const raceEnv = await makeEnv({ online: () => (onlineCalls += 1) === 1 })
  t.after(() => raceEnv.close(), { timeout: 60_000 })
  writeHubSkill(raceEnv.dataDir, 'hub-skill', SKILL_MD('Hub Skill', 'still listed'))
  const raceCatalog = (await raceEnv.host.invokeAction('core:skills', 'catalog', { nodeId: 'remote-1', cwd: wsA })) as {
    nodeUnavailable?: string
    skills: SkillSummary[]
  }
  assert.equal(onlineCalls, 2)
  assert.ok(raceCatalog.nodeUnavailable?.includes('remote-1'))
  assert.ok(raceCatalog.skills.some((s) => s.id === 'hub-skill'))

  let readCalls = 0
  const readRaceEnv = await makeEnv({ online: () => (readCalls += 1) === 1 })
  t.after(() => readRaceEnv.close(), { timeout: 60_000 })
  const readRaceErr = await actionErr(readRaceEnv, 'read', { id: 'node-only', nodeId: 'remote-1', cwd: wsA })
  assert.equal(readRaceErr.code, 'node_offline')
  assert.equal(readRaceErr.status, 409)
})

test('remote node machine roots (~/.helmx/skills > ~/.agents/skills > <cwd>/.helmx/skills): priority, read isolation, and home-as-cwd dedup', { timeout: 60_000 }, async (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => rmSync(ws, { recursive: true, force: true }), { timeout: 60_000 })
  const env = await makeEnv()
  t.after(() => env.close(), { timeout: 60_000 })

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
  writeRootSkill(nodeHelmxRoot, 'hub-wins', SKILL_MD('Node Helmx Shadowed', 'shadowed by Hub'))
  writeRootSkill(nodeHelmxRoot, 'node-helmx-only', SKILL_MD('Node Helmx', 'personal root'))
  writeRootSkill(nodeHelmxRoot, 'node-override', SKILL_MD('Node Helmx Override', 'wins over node agents'))
  writeRootSkill(nodeAgentsRoot, 'node-override', SKILL_MD('Node Agents Lower', 'shadowed'), {
    'references/only-in-agents.md': 'must not leak across roots\n',
  })
  writeRootSkill(nodeAgentsRoot, 'node-agents-only', SKILL_MD('Node Agents', 'shared root'), {
    'references/guide.md': '# agents guide\n',
  })
  writeRootSkill(nodeAgentsRoot, 'ws-override', SKILL_MD('Node Agents Higher', 'wins over workspace'))
  writeNodeSkill(ws, 'ws-override', SKILL_MD('Workspace Lower', 'shadowed by node ~/.agents'))
  writeNodeSkill(ws, 'ws-only', SKILL_MD('Workspace Only', 'project supplement'))

  const nodeOnly = (await env.host.invokeAction('core:skills', 'catalog', { nodeId: 'remote-1' })) as {
    skills: SkillSummary[]
    shadowedNodeSkillIds: string[]
  }
  assert.deepEqual(nodeOnly.shadowedNodeSkillIds, ['hub-wins'])
  const byId = new Map(nodeOnly.skills.map((s) => [s.id, s]))
  assert.equal(byId.get('node-override')?.name, 'Node Helmx Override')
  assert.equal(byId.has('ws-only'), false)

  const agentsRead = (await env.host.invokeAction('core:skills', 'read', {
    nodeId: 'remote-1',
    id: 'node-agents-only',
    path: 'references/guide.md',
  })) as { text: string }
  assert.equal(agentsRead.text, '# agents guide\n')
  const crossRootMiss = await actionErr(env, 'read', {
    nodeId: 'remote-1',
    id: 'node-override',
    path: 'references/only-in-agents.md',
  })
  assert.equal(crossRootMiss.code, 'not_found')

  const fullCatalog = (await env.host.invokeAction('core:skills', 'catalog', { nodeId: 'remote-1', cwd: ws })) as {
    skills: SkillSummary[]
  }
  assert.equal(new Map(fullCatalog.skills.map((s) => [s.id, s])).get('ws-only')?.source, 'node')

  env.conversations.set(99, makeConversation(99, { nodeId: 'remote-1', cwd: ws }))
  assert.equal(await loadSkillOk(env, 99, { skillId: 'node-agents-only', path: 'references/guide.md' }), '# agents guide\n')

  const homeAsCwd = (await env.host.invokeAction('core:skills', 'catalog', { nodeId: 'remote-1', cwd: env.homeDir })) as {
    skills: SkillSummary[]
  }
  assert.equal(homeAsCwd.skills.filter((s) => s.id === 'node-helmx-only').length, 1)
})

test('TurnContextAssembler deduplicates profiles.get(profileId) to a single lookup per turn', { timeout: 60_000 }, async (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'helmx-profile-dedup-'))
  t.after(() => rmSync(ws, { recursive: true, force: true }), { timeout: 60_000 })
  const env = await makeEnv()
  t.after(() => env.close(), { timeout: 60_000 })

  let getCount = 0
  const originalGet = env.profiles.get.bind(env.profiles)
  env.profiles.get = async (id: string) => {
    getCount += 1
    return originalGet(id)
  }

  await assembleTurn(env, ws)
  assert.equal(getCount, 1)
})

test('node-skills optimizations: shadowed Hub IDs skip IO, reference depth/cap bounds, frontmatter.name redacts, and TTL cache invalidates on miss', { timeout: 60_000 }, async (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'helmx-node-skills-opt-'))
  t.after(() => rmSync(ws, { recursive: true, force: true }), { timeout: 60_000 })

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
  assert.equal(openedShadowedSkillMd, false)
  assert.deepEqual(first.shadowedSkillIds, ['hub-shadowed'])
  assert.equal(first.skills[0]!.name, 'Visible [REDACTED] Skill')
  assert.ok(first.skills[0]!.references.includes(deepWithinCap))
  assert.equal(first.skills[0]!.references.includes(deepBeyondCap), false)
  assert.equal(listRootCalls, 1)

  fakeNow += 1_000
  await scanNodeSkills(trackingHost as never, 'local', ws, {
    shadowedIds: new Set(['hub-shadowed']),
    cacheTtlMs: 5_000,
    now: () => fakeNow,
  })
  assert.equal(listRootCalls, 1)

  await assert.rejects(
    () => readNodeSkillFile(trackingHost as never, 'local', ws, 'newly-added-skill', 'SKILL.md'),
    (err: unknown) => err instanceof HelmxError && err.code === 'not_found',
  )
  await scanNodeSkills(trackingHost as never, 'local', ws, {
    shadowedIds: new Set(['hub-shadowed']),
    cacheTtlMs: 5_000,
    now: () => fakeNow,
  })
  assert.equal(listRootCalls, 2)

  const manyWs = mkdtempSync(join(tmpdir(), 'helmx-node-skills-cap-'))
  t.after(() => rmSync(manyWs, { recursive: true, force: true }), { timeout: 60_000 })
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
  assert.ok(bucketListCalls <= 6)
})

test('node skill ID / fallback name / references / shadowedSkillIds / diagnostics / readNodeSkillFile errors are redacted', { timeout: 60_000 }, async (t) => {
  const secretA = 'sk-id-secret-alpha'
  const secretB = 'sk-id-secret-beta'
  const ws = mkdtempSync(join(tmpdir(), 'helmx-node-skills-id-redact-'))
  t.after(() => rmSync(ws, { recursive: true, force: true }), { timeout: 60_000 })

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

  const fresh = await scanNodeSkills(host as never, 'local', ws, {
    shadowedIds: new Set([`hub-${secretA}`]),
    cacheTtlMs: 5_000,
    now: () => fakeNow,
  })
  assert.equal(fresh.kind, 'ok')
  assert.equal(JSON.stringify(fresh).includes(secretA), false)
  assert.equal(fresh.skills[0]!.id, `tool-[REDACTED]-${secretB}`)
  assert.equal(fresh.skills[0]!.name, `tool-[REDACTED]-${secretB}`)
  assert.deepEqual(fresh.skills[0]!.references, ['references/[REDACTED].md'])
  assert.deepEqual(fresh.shadowedSkillIds, ['hub-[REDACTED]'])

  activeSecrets = [secretA, secretB]
  fakeNow += 1_000
  const cached = await scanNodeSkills(host as never, 'local', ws, {
    shadowedIds: new Set([`hub-${secretA}`]),
    cacheTtlMs: 5_000,
    now: () => fakeNow,
  })
  assert.equal(cached.kind, 'ok')
  assert.equal(JSON.stringify(cached).includes(secretA), false)
  assert.equal(JSON.stringify(cached).includes(secretB), false)
  assert.equal(cached.skills[0]!.id, 'tool-[REDACTED]-[REDACTED]')
  assert.equal(cached.skills[0]!.name, 'tool-[REDACTED]-[REDACTED]')

  const env = await makeEnv({ redact: dynamicRedact })
  t.after(() => env.close(), { timeout: 60_000 })
  const catalog = skillSection(await assembleTurn(env, ws))
  assert.ok(catalog !== undefined)
  assert.equal(catalog.includes(secretA), false)
  assert.equal(catalog.includes(secretB), false)
  assert.ok(catalog.includes('tool-[REDACTED]-[REDACTED]'))

  const badWs = mkdtempSync(join(tmpdir(), 'helmx-node-skills-bad-id-'))
  t.after(() => rmSync(badWs, { recursive: true, force: true }), { timeout: 60_000 })
  writeNodeSkill(badWs, `big-${secretA}`, 'x'.repeat(MAX_NODE_SKILL_FILE_BYTES + 16))
  const unavail = await scanNodeSkills(
    { nodeIpc: { isOnline: () => true }, redact: dynamicRedact, executionEnv: () => new NodeExecutionEnv({ cwd: badWs }) } as never,
    'local',
    badWs,
    { cacheTtlMs: 0 },
  )
  assert.equal(unavail.kind, 'unavailable')
  assert.equal(unavail.reason.includes(secretA), false)
  assert.ok(unavail.reason.includes('[REDACTED]'))

  const assertErrRedacted = async (fn: () => Promise<unknown>, expectedCode: string): Promise<void> => {
    try {
      await fn()
      assert.fail(`expected ${expectedCode}`)
    } catch (err) {
      assert.ok(err instanceof HelmxError)
      assert.equal(err.code, expectedCode)
      assert.equal(err.message.includes(secretA), false)
      assert.equal(JSON.stringify(err.details ?? {}).includes(secretA), false)
    }
  }
  await assertErrRedacted(() => readNodeSkillFile(host as never, 'local', ws, `../${secretA}`, 'SKILL.md'), 'validation_error')
  await assertErrRedacted(() => readNodeSkillFile(host as never, 'local', ws, 'valid-id', `../${secretA}`), 'validation_error')
  await assertErrRedacted(() => readNodeSkillFile(host as never, 'local', ws, `missing-${secretA}`, 'SKILL.md'), 'not_found')
  const offlineHost = { ...host, nodeIpc: { isOnline: () => false } }
  await assertErrRedacted(() => readNodeSkillFile(offlineHost as never, 'remote-1', ws, `remote-${secretA}`, 'SKILL.md'), 'node_offline')
})
