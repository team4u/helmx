/**
 * Kernel workspace AGENTS.md injection tests (`TurnContextAssembler` + `computeAgentsMdSection`).
 *
 * Covers:
 * - AGENTS.md in workspace -> `profile.agents` (<project_instructions path="...">), ordered between
 *   `profile.system` and `profile.skills`; re-read every turn so edits take effect immediately;
 * - missing file / whitespace-only / directory / dangling symlink -> omitted cleanly;
 * - secret redaction before injection;
 * - truncation over MAX_AGENTS_MD_CHARS (64k) with explicit note;
 * - remote node online via executionEnv (POSIX + Win32 path joins, noFollow bounded reader);
 * - offline (`isOnline === false`) short-circuits without touching executionEnv and injects `profile.agents-unavailable`;
 * - unwired capabilities (`isOnline` throwing `node_ipc_unavailable`, `executionEnv` throwing `unsupported`)
 *   explicitly inject `profile.agents-unavailable` rather than silently skipping;
 * - bounded `openBinaryReader({ noFollow: true })` same-handle `info/read/info/close` discipline:
 *   size > MAX_AGENTS_MD_BYTES rejected from handle info without reading, read bounded to MAX+1,
 *   non-regular kind / ELOOP / mtime or size change / short-read / close error all surface cleanly.
 *
 * Runner: node --test / run-tests; timeout: 60_000.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HelmxError, type ConversationSummary } from '@helmx/protocol'
import {
  FileError,
  type BinaryReader,
  type ExecutionEnv,
  type FileInfo,
  type FileErrorCode,
  type Result,
} from '@earendil-works/pi-durable/env'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { makeConversationSummary } from './helpers.js'
import { ProfileService, SkillService } from '../src/services/index.js'
import {
  AGENTS_MD_FILENAME,
  MAX_AGENTS_MD_BYTES,
  MAX_AGENTS_MD_CHARS,
  computeAgentsMdSection,
  type AgentsMdHostPort,
} from '../src/runtime/agents-md.js'
import { ScopedSkillService } from '../src/runtime/scoped-skills.js'
import { TurnContextAssembler } from '../src/runtime/turn-context.js'
import { HookBridge, prepareToolResultWith } from '../src/runtime/hook-bridge.js'
import { RuntimeToolRegistry } from '../src/runtime/tool-registry.js'

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
}

interface Env {
  dataDir: string
  workspace: string
  profiles: ProfileService
  skills: SkillService
  assembler: TurnContextAssembler
  envCalls: EnvCall[]
  notifications: Array<{ title: string; body: string }>
  close(): Promise<void>
}

async function makeEnv(workspace: string, opts: EnvOptions = {}): Promise<Env> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helmx-kernel-agents-'))
  const profiles = new ProfileService(dataDir)
  await profiles.ensureDefault()
  const skills = new SkillService(dataDir, { externalRoots: [] })
  const envCalls: EnvCall[] = []
  const notifications: Array<{ title: string; body: string }> = []
  const executionEnv = (nodeId: string, cwd: string): ExecutionEnv => {
    envCalls.push({ nodeId, cwd })
    return opts.envFor ? opts.envFor(nodeId, cwd) : new NodeExecutionEnv({ cwd })
  }
  const isNodeOnline = opts.online ?? (() => true)
  const redact = opts.redact ?? ((t: string) => t)
  const scopedSkills = new ScopedSkillService({
    skills,
    profiles,
    getConversation: (id) => makeConversation(id, { cwd: workspace }),
    executionEnv,
    redact,
    isNodeOnline,
    listPlugins: () => [],
  })
  const assembler = new TurnContextAssembler({
    profiles,
    scopedSkills,
    executionEnv,
    isNodeOnline,
    redact,
    notifyWarning: (n) => {
      notifications.push(n)
    },
  })
  return {
    dataDir,
    workspace,
    profiles,
    skills,
    assembler,
    envCalls,
    notifications,
    async close() {
      rmSync(dataDir, { recursive: true, force: true })
      rmSync(workspace, { recursive: true, force: true })
    },
  }
}

interface TurnLike {
  conversation: ConversationSummary
  sections: Array<{ id: string; text: string }>
}

function makeTurn(cwd: string, over: Partial<ConversationSummary> = {}): TurnLike {
  return {
    conversation: makeConversation(1, { cwd, ...over }),
    sections: [],
  }
}

async function assembleTurn(
  env: Env,
  turn: TurnLike,
  loadSkillActive = true,
): Promise<Array<{ id: string; text: string }>> {
  const prepared = await env.assembler.prepare(turn.conversation)
  const pre = env.assembler.applyPreSections(turn.sections, prepared.preSections)
  return env.assembler.applyPostSections(pre, prepared.resolvePostSections(loadSkillActive))
}

type FakeCall =
  | { op: 'canonicalPath' | 'openBinaryReader' | 'readTextFile' | 'fileInfo'; path: string }
  | { op: 'openBinaryReader'; path: string; noFollow: boolean }
  | { op: 'info' }
  | { op: 'read'; offset: number; length: number }
  | { op: 'close' }

interface FakeHandle {
  infos?: Array<Result<FileInfo, FileError>>
  read?: (offset: number, length: number) => Result<Uint8Array, FileError>
  bytes?: Uint8Array
  text?: string
  kind?: FileInfo['kind']
  size?: number
  mtimeMs?: number
  closeError?: unknown
}

interface FakeEnvStages {
  canonicalPath?: (path: string) => Result<string, FileError>
  openBinaryReader?: (path: string) => Result<FakeHandle, FileError>
}

interface FakeEnv extends ExecutionEnv {
  calls: FakeCall[]
  readLengths: number[]
}

function isNodeSkillsRootPath(path: string): boolean {
  return (
    path === '~/.helmx/skills' ||
    path === '~/.agents/skills' ||
    path.endsWith('/.helmx/skills') ||
    path.endsWith('\\.helmx\\skills')
  )
}

function fakeEnv(stages: FakeEnvStages = {}): FakeEnv {
  const calls: FakeCall[] = []
  const readLengths: number[] = []
  const encoder = new TextEncoder()
  const openFor = (path: string): Result<FakeHandle, FileError> =>
    stages.openBinaryReader
      ? stages.openBinaryReader(path)
      : { ok: true, value: { text: '# 受控桩默认约定\n' } }

  const env = {
    calls,
    readLengths,
    async canonicalPath(path: string): Promise<Result<string, FileError>> {
      if (isNodeSkillsRootPath(path)) {
        return { ok: false, error: new FileError('not_found', 'ENOENT: no such directory', path) }
      }
      calls.push({ op: 'canonicalPath', path })
      return stages.canonicalPath ? stages.canonicalPath(path) : { ok: true, value: path }
    },
    async listDir(path: string): Promise<Result<FileInfo[], FileError>> {
      if (isNodeSkillsRootPath(path)) {
        return { ok: false, error: new FileError('not_found', 'ENOENT: no such directory', path) }
      }
      throw new Error(`fake listDir must not participate in AGENTS.md reading: ${path}`)
    },
    async openBinaryReader(
      path: string,
      options: { noFollow?: boolean } | undefined,
    ): Promise<Result<BinaryReader, FileError>> {
      calls.push({ op: 'openBinaryReader', path, noFollow: options?.noFollow === true })
      const opened = openFor(path)
      if (!opened.ok) return opened
      const script = opened.value
      const bytes = script.bytes ?? encoder.encode(script.text ?? '')
      const baseInfo = (): FileInfo => ({
        name: AGENTS_MD_FILENAME,
        path,
        kind: script.kind ?? 'file',
        size: script.size ?? bytes.byteLength,
        mtimeMs: script.mtimeMs ?? 1_000,
      })
      const scriptedInfos = [...(script.infos ?? [])]
      const takeInfo = (): Result<FileInfo, FileError> => {
        if (scriptedInfos.length > 1) return scriptedInfos.shift()!
        if (scriptedInfos.length === 1) return scriptedInfos[0]!
        return { ok: true, value: baseInfo() }
      }
      let closed = false
      const handle: BinaryReader = {
        async info(): Promise<Result<FileInfo, FileError>> {
          calls.push({ op: 'info' })
          if (closed) return { ok: false, error: new FileError('invalid', 'Binary reader is closed', path) }
          return takeInfo()
        },
        async read(offset: number, length: number): Promise<Result<Uint8Array, FileError>> {
          calls.push({ op: 'read', offset, length })
          readLengths.push(length)
          if (length > MAX_AGENTS_MD_BYTES + 1) {
            throw new Error(`fake reader rejects oversized length=${length} (max ${MAX_AGENTS_MD_BYTES + 1})`)
          }
          if (closed) return { ok: false, error: new FileError('invalid', 'Binary reader is closed', path) }
          if (script.read) return script.read(offset, length)
          return { ok: true, value: bytes.subarray(offset, Math.min(offset + length, bytes.byteLength)) }
        },
        async scanLines(): Promise<Result<never, FileError>> {
          throw new Error('fake reader scanLines must not be called for AGENTS.md')
        },
        async close(): Promise<void> {
          calls.push({ op: 'close' })
          closed = true
          if (script.closeError !== undefined) throw script.closeError
        },
      }
      return { ok: true, value: handle }
    },
    async readTextFile(path: string): Promise<Result<string, FileError>> {
      calls.push({ op: 'readTextFile', path })
      throw new Error(`readTextFile must never be called for AGENTS.md: ${path}`)
    },
    async fileInfo(path: string): Promise<Result<FileInfo, FileError>> {
      calls.push({ op: 'fileInfo', path })
      throw new Error(`fileInfo must never be called for AGENTS.md: ${path}`)
    },
  }
  return env as unknown as FakeEnv
}

function opsOf(env: FakeEnv): string[] {
  return env.calls.map((c) => c.op)
}

function readCallLengths(env: FakeEnv): number[] {
  return env.readLengths
}

function fileInfoOf(path: string, over: Partial<FileInfo> = {}): FileInfo {
  return { name: AGENTS_MD_FILENAME, path, kind: 'file', size: 128, mtimeMs: 0, ...over }
}

function hostOf(env: ExecutionEnv, over: Partial<AgentsMdHostPort> = {}): AgentsMdHostPort {
  return {
    executionEnv: () => env,
    redact: (t: string) => t,
    nodeIpc: { isOnline: () => true },
    ...over,
  }
}

function freshWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'helmx-kernel-agents-ws-'))
}

// ---------------------------------------------------------------------------
// Local workspace integration via TurnContextAssembler
// ---------------------------------------------------------------------------

test('TurnContextAssembler: AGENTS.md -> profile.agents between profile.system and profile.skills, updated on next turn', { timeout: 60_000 }, async (t) => {
  const workspace = freshWorkspace()
  writeFileSync(join(workspace, AGENTS_MD_FILENAME), '# 项目约定\n\n所有提交使用中文 Conventional Commits。\n')
  const env = await makeEnv(workspace)
  t.after(() => env.close(), { timeout: 60_000 })

  const hubSkillDir = join(env.dataDir, 'skills', 'hub-sample')
  mkdirSync(hubSkillDir, { recursive: true })
  writeFileSync(join(hubSkillDir, 'SKILL.md'), '---\nname: Hub Sample\ndescription: Hub skill fixture\n---\n\n# Hub Sample\n')

  const sections = await assembleTurn(env, makeTurn(workspace))
  const ids = sections.map((s) => s.id)
  assert.ok(ids.includes('profile.system'))
  assert.ok(ids.includes('profile.skills'))
  assert.ok(
    ids.indexOf('profile.system') < ids.indexOf('profile.agents') && ids.indexOf('profile.agents') < ids.indexOf('profile.skills'),
    `profile.agents must sit between profile.system and profile.skills: ${ids.join(', ')}`,
  )
  const agents = sections.find((s) => s.id === 'profile.agents')!
  assert.ok(agents.text.startsWith(`<project_instructions path="${workspace}/AGENTS.md">\n`))
  assert.ok(agents.text.endsWith('</project_instructions>'))
  assert.ok(agents.text.includes('所有提交使用中文 Conventional Commits。'))
  assert.ok(!sections.some((s) => s.id === 'profile.agents-unavailable'))

  writeFileSync(join(workspace, AGENTS_MD_FILENAME), '# 新约定\n\n禁止 force push。\n')
  const again = await assembleTurn(env, makeTurn(workspace))
  const agentsAgain = again.find((s) => s.id === 'profile.agents')!
  assert.ok(agentsAgain.text.includes('禁止 force push。'))
  assert.ok(!agentsAgain.text.includes('所有提交使用中文 Conventional Commits'))
})

test('TurnContextAssembler: missing / blank / directory AGENTS.md emits no AGENTS section', { timeout: 60_000 }, async (t) => {
  const emptyWs = freshWorkspace()
  const noFile = await makeEnv(emptyWs)
  t.after(() => noFile.close(), { timeout: 60_000 })
  const s1 = await assembleTurn(noFile, makeTurn(emptyWs))
  assert.ok(!s1.some((s) => s.id === 'profile.agents' || s.id === 'profile.agents-unavailable'))

  const blankWs = freshWorkspace()
  writeFileSync(join(blankWs, AGENTS_MD_FILENAME), '   \n\t\n')
  const blank = await makeEnv(blankWs)
  t.after(() => blank.close(), { timeout: 60_000 })
  const s2 = await assembleTurn(blank, makeTurn(blankWs))
  assert.ok(!s2.some((s) => s.id === 'profile.agents' || s.id === 'profile.agents-unavailable'))

  const dirWs = freshWorkspace()
  mkdirSync(join(dirWs, AGENTS_MD_FILENAME))
  const dirEnv = await makeEnv(dirWs)
  t.after(() => dirEnv.close(), { timeout: 60_000 })
  const s3 = await assembleTurn(dirEnv, makeTurn(dirWs))
  assert.ok(!s3.some((s) => s.id === 'profile.agents' || s.id === 'profile.agents-unavailable'))
})

test('TurnContextAssembler: AGENTS.md secrets are redacted before injection', { timeout: 60_000 }, async (t) => {
  const workspace = freshWorkspace()
  const fakeSecret = 'FAKE_SECRET_TOKEN_42'
  writeFileSync(join(workspace, AGENTS_MD_FILENAME), `部署令牌：${fakeSecret}，请保密。\n`)
  const env = await makeEnv(workspace, {
    redact: (text) => text.replaceAll(fakeSecret, 'REDACTED_MARKER'),
  })
  t.after(() => env.close(), { timeout: 60_000 })
  const sections = await assembleTurn(env, makeTurn(workspace))
  const agents = sections.find((s) => s.id === 'profile.agents')!
  assert.ok(agents.text.includes('REDACTED_MARKER'))
  assert.ok(!agents.text.includes(fakeSecret))
})

test(`TurnContextAssembler: AGENTS.md over ${MAX_AGENTS_MD_CHARS} chars is truncated with explicit note`, { timeout: 60_000 }, async (t) => {
  const workspace = freshWorkspace()
  const filler = '约'.repeat(500)
  const long = `${filler}\n`.repeat(MAX_AGENTS_MD_CHARS / 500 + 2)
  writeFileSync(join(workspace, AGENTS_MD_FILENAME), long)
  const env = await makeEnv(workspace)
  t.after(() => env.close(), { timeout: 60_000 })
  const sections = await assembleTurn(env, makeTurn(workspace))
  const agents = sections.find((s) => s.id === 'profile.agents')!
  const note = `[ helmx 提示：AGENTS.md 超过 ${MAX_AGENTS_MD_CHARS} 字符上限，以上为前 ${MAX_AGENTS_MD_CHARS} 字符 ]`
  assert.ok(agents.text.includes(note))
  const body = agents.text.slice(
    `<project_instructions path="${workspace}/AGENTS.md">\n`.length,
    agents.text.length - `\n${note}\n</project_instructions>`.length,
  )
  assert.equal(body.length, MAX_AGENTS_MD_CHARS)
  assert.equal(body, long.slice(0, MAX_AGENTS_MD_CHARS))
})

test(`TurnContextAssembler: local file exceeding ${MAX_AGENTS_MD_BYTES} bytes fails handle info check without reading body`, { timeout: 60_000 }, async (t) => {
  const workspace = freshWorkspace()
  const size = MAX_AGENTS_MD_BYTES + 1
  writeFileSync(join(workspace, AGENTS_MD_FILENAME), Buffer.alloc(size, 0x61))
  const env = await makeEnv(workspace)
  t.after(() => env.close(), { timeout: 60_000 })
  const sections = await assembleTurn(env, makeTurn(workspace))
  const unavailable = sections.find((s) => s.id === 'profile.agents-unavailable')!
  assert.ok(unavailable.text.includes(`为 ${size} 字节`))
  assert.ok(unavailable.text.includes(`超过 ${MAX_AGENTS_MD_BYTES} 字节读取上限`))
  assert.ok(!sections.some((s) => s.id === 'profile.agents'))
})

test('TurnContextAssembler: executionEnv throwing unsupported surfaces profile.agents-unavailable rather than skipping', { timeout: 60_000 }, async (t) => {
  const workspace = freshWorkspace()
  writeFileSync(join(workspace, AGENTS_MD_FILENAME), '# 约定\n')
  const env = await makeEnv(workspace, {
    envFor: () => {
      throw new HelmxError('unsupported', 'test fixture does not implement host capability: host.executionEnv', 501)
    },
  })
  t.after(() => env.close(), { timeout: 60_000 })
  const sections = await assembleTurn(env, makeTurn(workspace))
  const unavailable = sections.find((s) => s.id === 'profile.agents-unavailable')!
  assert.ok(unavailable)
  assert.ok(unavailable.text.includes('（unsupported）'))
  assert.ok(unavailable.text.includes('host.executionEnv'))
  assert.ok(!sections.some((s) => s.id === 'profile.agents'))
})

// ---------------------------------------------------------------------------
// Remote node controlled executionEnv / bounded openBinaryReader contract
// ---------------------------------------------------------------------------

test('TurnContextAssembler: remote online node reads via openBinaryReader (Windows path + noFollow)', { timeout: 60_000 }, async (t) => {
  const workspace = 'C:\\repo'
  const remoteEnv = fakeEnv({
    openBinaryReader: () => ({ ok: true, value: { text: '# 远端约定\n\n使用 pnpm。\n' } }),
  })
  const env = await makeEnv(workspace, {
    envFor: (nodeId, cwd) => {
      assert.equal(nodeId, 'remote-1')
      assert.equal(cwd, workspace)
      return remoteEnv
    },
  })
  t.after(() => env.close(), { timeout: 60_000 })
  const sections = await assembleTurn(env, makeTurn(workspace, { nodeId: 'remote-1' }))
  const agents = sections.find((s) => s.id === 'profile.agents')!
  assert.ok(agents.text.includes('<project_instructions path="C:\\repo\\AGENTS.md">'))
  assert.ok(agents.text.includes('使用 pnpm。'))
  assert.ok(env.envCalls.length >= 1 && env.envCalls.every((e) => e.nodeId === 'remote-1' && e.cwd === workspace))
  const openCalls = remoteEnv.calls.filter((c) => c.op === 'openBinaryReader') as Array<{
    op: 'openBinaryReader'
    path: string
    noFollow: boolean
  }>
  assert.deepEqual(openCalls.map((c) => c.path), ['C:\\repo\\AGENTS.md'])
  assert.equal(openCalls[0]!.noFollow, true)
  assert.ok(!remoteEnv.calls.some((c) => c.op === 'readTextFile'))
})

test('TurnContextAssembler: remote POSIX path joins cleanly with noFollow', { timeout: 60_000 }, async (t) => {
  const workspace = '/srv/app'
  const remoteEnv = fakeEnv({ openBinaryReader: () => ({ ok: true, value: { text: '# srv 约定\n' } }) })
  const env = await makeEnv(workspace, { envFor: () => remoteEnv })
  t.after(() => env.close(), { timeout: 60_000 })
  await assembleTurn(env, makeTurn(workspace, { nodeId: 'remote-2' }))
  const openCalls = remoteEnv.calls.filter((c) => c.op === 'openBinaryReader') as Array<{
    op: 'openBinaryReader'
    path: string
    noFollow: boolean
  }>
  assert.deepEqual(openCalls.map((c) => c.path), ['/srv/app/AGENTS.md'])
  assert.equal(openCalls[0]!.noFollow, true)
  assert.ok(!remoteEnv.calls.some((c) => c.op === 'readTextFile'))
})

test('TurnContextAssembler: remote offline node injects agents-unavailable without touching executionEnv', { timeout: 60_000 }, async (t) => {
  const workspace = '/srv/app'
  const env = await makeEnv(workspace, {
    online: (nodeId) => nodeId !== 'remote-1',
    envFor: () => {
      throw new Error('must not touch executionEnv when offline')
    },
  })
  t.after(() => env.close(), { timeout: 60_000 })
  const sections = await assembleTurn(env, makeTurn(workspace, { nodeId: 'remote-1' }))
  const unavailable = sections.find((s) => s.id === 'profile.agents-unavailable')!
  assert.ok(unavailable.text.startsWith('<project_instructions_unavailable path="/srv/app/AGENTS.md" node="remote-1">'))
  assert.ok(unavailable.text.includes('目标节点 remote-1 当前离线'))
  assert.ok(!sections.some((s) => s.id === 'profile.agents'))
  assert.equal(env.envCalls.length, 0)
})

test('TurnContextAssembler: isOnline throwing node_ipc_unavailable injects agents-unavailable', { timeout: 60_000 }, async (t) => {
  const workspace = '/srv/app'
  const env = await makeEnv(workspace, {
    online: () => {
      throw new HelmxError('node_ipc_unavailable', 'EnvFabric IPC unavailable', 501)
    },
    envFor: () => {
      throw new Error('must not touch executionEnv after probe failure')
    },
  })
  t.after(() => env.close(), { timeout: 60_000 })
  const sections = await assembleTurn(env, makeTurn(workspace, { nodeId: 'remote-1' }))
  const unavailable = sections.find((s) => s.id === 'profile.agents-unavailable')!
  assert.ok(unavailable.text.includes('在线状态失败（node_ipc_unavailable）'))
  assert.ok(unavailable.text.includes('EnvFabric IPC unavailable'))
  assert.ok(!sections.some((s) => s.id === 'profile.agents'))
  assert.equal(env.envCalls.length, 0)
})

test('TurnContextAssembler: remote read errors & close errors close handles and redact diagnostics', { timeout: 60_000 }, async (t) => {
  const workspace = '/srv/app'
  const envDenied = await makeEnv(workspace, {
    envFor: () =>
      fakeEnv({
        openBinaryReader: (path) => ({
          ok: true,
          value: {
            read: () => ({
              ok: false,
              error: new FileError('permission_denied', `EACCES: permission denied, read '${path}'`, path),
            }),
          },
        }),
      }),
  })
  t.after(() => envDenied.close(), { timeout: 60_000 })
  const s1 = await assembleTurn(envDenied, makeTurn(workspace, { nodeId: 'remote-1' }))
  const u1 = s1.find((s) => s.id === 'profile.agents-unavailable')!
  assert.ok(u1.text.includes('读取工作区 /srv/app/AGENTS.md 失败（permission_denied）'))
  assert.ok(u1.text.includes('EACCES'))

  const throwEnv = fakeEnv({
    openBinaryReader: () => ({
      ok: true,
      value: {
        read: () => {
          throw new HelmxError('node_offline', '节点 remote-1 连接中断', 409)
        },
      },
    }),
  })
  const envThrow = await makeEnv('/srv/app-throw', { envFor: () => throwEnv })
  t.after(() => envThrow.close(), { timeout: 60_000 })
  const s2 = await assembleTurn(envThrow, makeTurn(workspace, { nodeId: 'remote-1' }))
  const u2 = s2.find((s) => s.id === 'profile.agents-unavailable')!
  assert.ok(u2.text.includes('（node_offline）'))
  assert.deepEqual(opsOf(throwEnv), ['canonicalPath', 'openBinaryReader', 'info', 'read', 'close'])

  const closeErrEnv = fakeEnv({
    openBinaryReader: () => ({
      ok: true,
      value: { text: '# 约定\n', closeError: new Error('close 失败 SECRET_c1') },
    }),
  })
  const envClose = await makeEnv('/srv/app-close', {
    redact: (text) => text.replaceAll('SECRET_c1', '[REDACTED]'),
    envFor: () => closeErrEnv,
  })
  t.after(() => envClose.close(), { timeout: 60_000 })
  const s3 = await assembleTurn(envClose, makeTurn(workspace, { nodeId: 'remote-1' }))
  const u3 = s3.find((s) => s.id === 'profile.agents-unavailable')!
  assert.ok(u3.text.includes('close 失败'))
  assert.ok(u3.text.includes('[REDACTED]'))
  assert.ok(!u3.text.includes('SECRET_c1'))
  assert.deepEqual(opsOf(closeErrEnv), ['canonicalPath', 'openBinaryReader', 'info', 'read', 'info', 'close'])
})

test('TurnContextAssembler: bounded handle invariants (oversized info/read, non-regular kind, noFollow, symlink, mtime/size shift, short read, UTF-8)', { timeout: 60_000 }, async (t) => {
  const workspace = '/srv/app'

  // 1. handle info > MAX_AGENTS_MD_BYTES skips read
  const overEnv = fakeEnv({ openBinaryReader: () => ({ ok: true, value: { size: MAX_AGENTS_MD_BYTES + 1, mtimeMs: 5 } }) })
  const e1 = await makeEnv(workspace, { envFor: () => overEnv })
  t.after(() => e1.close(), { timeout: 60_000 })
  const s1 = await assembleTurn(e1, makeTurn(workspace, { nodeId: 'remote-1' }))
  assert.ok(s1.find((s) => s.id === 'profile.agents-unavailable')!.text.includes(`为 ${MAX_AGENTS_MD_BYTES + 1} 字节`))
  assert.deepEqual(opsOf(overEnv), ['canonicalPath', 'openBinaryReader', 'info', 'close'])

  // 2. growth between info and read
  const growEnv = fakeEnv({
    openBinaryReader: () => ({
      ok: true,
      value: {
        infos: [{ ok: true, value: fileInfoOf('/srv/app/AGENTS.md', { size: 1, mtimeMs: 1 }) }],
        read: () => ({ ok: true, value: new Uint8Array(MAX_AGENTS_MD_BYTES + 1) }),
      },
    }),
  })
  const e2 = await makeEnv('/srv/app-2', { envFor: () => growEnv })
  t.after(() => e2.close(), { timeout: 60_000 })
  const s2 = await assembleTurn(e2, makeTurn(workspace, { nodeId: 'remote-1' }))
  assert.ok(
    s2.find((s) => s.id === 'profile.agents-unavailable')!.text.includes(
      `读取到 ${MAX_AGENTS_MD_BYTES + 1} 字节，超过 ${MAX_AGENTS_MD_BYTES} 字节读取上限`,
    ),
  )
  assert.deepEqual(readCallLengths(growEnv), [MAX_AGENTS_MD_BYTES + 1])

  // 3. invalid (FIFO) and directory kind stop safely
  const invalidEnv = fakeEnv({ openBinaryReader: (path) => ({ ok: false, error: new FileError('invalid', 'Not a regular file', path) }) })
  const e3 = await makeEnv('/srv/app-3', { envFor: () => invalidEnv })
  t.after(() => e3.close(), { timeout: 60_000 })
  const s3 = await assembleTurn(e3, makeTurn(workspace, { nodeId: 'remote-1' }))
  assert.ok(s3.find((s) => s.id === 'profile.agents-unavailable')!.text.includes('（invalid）'))
  assert.deepEqual(opsOf(invalidEnv), ['canonicalPath', 'openBinaryReader'])

  const dirEnv = fakeEnv({ openBinaryReader: () => ({ ok: true, value: { kind: 'directory' } }) })
  const e4 = await makeEnv('/srv/app-4', { envFor: () => dirEnv })
  t.after(() => e4.close(), { timeout: 60_000 })
  const s4 = await assembleTurn(e4, makeTurn(workspace, { nodeId: 'remote-1' }))
  assert.ok(s4.find((s) => s.id === 'profile.agents-unavailable')!.text.includes('在打开后不是普通文件（kind=directory）'))
  assert.deepEqual(opsOf(dirEnv), ['canonicalPath', 'openBinaryReader', 'info', 'close'])

  // 4. symlink canonicalization + ELOOP
  const realTarget = '/srv/shared/AGENTS.md'
  const linkEnv = fakeEnv({
    canonicalPath: () => ({ ok: true, value: realTarget }),
    openBinaryReader: () => ({ ok: true, value: { text: '# 共享约定\n' } }),
  })
  const e5 = await makeEnv('/srv/app-5', { envFor: () => linkEnv })
  t.after(() => e5.close(), { timeout: 60_000 })
  const s5 = await assembleTurn(e5, makeTurn('/repo', { nodeId: 'remote-1' }))
  assert.ok(s5.find((s) => s.id === 'profile.agents')!.text.includes('<project_instructions path="/repo/AGENTS.md">'))
  assert.deepEqual(
    linkEnv.calls.filter((c) => c.op === 'openBinaryReader').map((c) => (c as { path: string }).path),
    [realTarget],
  )

  const eloopEnv = fakeEnv({
    canonicalPath: () => ({ ok: true, value: realTarget }),
    openBinaryReader: (path) => ({ ok: false, error: new FileError('invalid', 'ELOOP: symbolic links', path) }),
  })
  const e6 = await makeEnv('/srv/app-6', { envFor: () => eloopEnv })
  t.after(() => e6.close(), { timeout: 60_000 })
  const s6 = await assembleTurn(e6, makeTurn('/repo', { nodeId: 'remote-1' }))
  assert.ok(s6.find((s) => s.id === 'profile.agents-unavailable')!.text.includes('ELOOP'))

  // 5. mtime change & short read & UTF-8 preservation
  const mtimeEnv = fakeEnv({
    openBinaryReader: () => ({
      ok: true,
      value: {
        text: 'stable!',
        infos: [
          { ok: true, value: fileInfoOf('/srv/app/AGENTS.md', { size: 7, mtimeMs: 1 }) },
          { ok: true, value: fileInfoOf('/srv/app/AGENTS.md', { size: 7, mtimeMs: 2 }) },
        ],
      },
    }),
  })
  const e7 = await makeEnv('/srv/app-7', { envFor: () => mtimeEnv })
  t.after(() => e7.close(), { timeout: 60_000 })
  const s7 = await assembleTurn(e7, makeTurn(workspace, { nodeId: 'remote-1' }))
  assert.ok(s7.find((s) => s.id === 'profile.agents-unavailable')!.text.includes('mtime 1 -> 2'))

  const shortEnv = fakeEnv({
    openBinaryReader: () => ({
      ok: true,
      value: {
        text: '0123456789',
        read: (offset, length) => ({
          ok: true,
          value: new TextEncoder().encode('0123456789').subarray(offset, Math.min(offset + length, 7)),
        }),
      },
    }),
  })
  const e8 = await makeEnv('/srv/app-8', { envFor: () => shortEnv })
  t.after(() => e8.close(), { timeout: 60_000 })
  const s8 = await assembleTurn(e8, makeTurn(workspace, { nodeId: 'remote-1' }))
  assert.ok(s8.find((s) => s.id === 'profile.agents-unavailable')!.text.includes('读取到 7 字节与稳定大小 10 不一致'))

  const utf8Text = '# 约定 𠮷 中文 emoji 🚀 конец\n'
  const utf8Env = fakeEnv({ openBinaryReader: () => ({ ok: true, value: { text: utf8Text } }) })
  const e9 = await makeEnv('/srv/app-9', { envFor: () => utf8Env })
  t.after(() => e9.close(), { timeout: 60_000 })
  const s9 = await assembleTurn(e9, makeTurn(workspace, { nodeId: 'remote-1' }))
  const body = s9
    .find((s) => s.id === 'profile.agents')!
    .text.slice('<project_instructions path="/srv/app/AGENTS.md">\n'.length, -'\n</project_instructions>'.length)
  assert.equal(body, utf8Text)
})

test('TurnContextAssembler + HookBridge: restrictToCwd, missing SYSTEM.md warning dedupe, and load_skill stripping clearing profile.skills', { timeout: 60_000 }, async (t) => {
  const workspace = freshWorkspace()
  writeFileSync(join(workspace, AGENTS_MD_FILENAME), '# 约定\n')
  const env = await makeEnv(workspace)
  t.after(() => env.close(), { timeout: 60_000 })

  const hubSkillDir = join(env.dataDir, 'skills', 'demo-skill')
  mkdirSync(hubSkillDir, { recursive: true })
  writeFileSync(join(hubSkillDir, 'SKILL.md'), '---\nname: Demo\ndescription: Demo skill\n---\n# Demo\n')

  // Restrict to CWD + missing SYSTEM.md + hook stripping `load_skill`
  const assistant = (await env.profiles.get('assistant'))!
  await env.profiles.save({ ...assistant, restrictToCwd: true, system: '' })
  const { unlinkSync } = await import('node:fs')
  unlinkSync(join(env.dataDir, 'profiles', 'assistant', 'SYSTEM.md'))

  let stripLoadSkill = false
  let installedExt: { hooks?: Array<{ handlers: { beforeRequest: (req: { messages: unknown[] }, api: { conversationId: number }) => Promise<{ messages: Array<Record<string, unknown>> } | undefined> } }> } | undefined
  const bridge = new HookBridge({
    registry: {
      install(ext) {
        installedExt = ext as never
      },
    },
    pluginHost: () =>
      ({
        listTools: () => [],
        listActions: () => [],
        runHook: async (
          _name: string,
          payloadOrFactory:
            | { tools: Array<{ name: string }> }
            | (() => Promise<{ tools: Array<{ name: string }> }> | { tools: Array<{ name: string }> }),
        ) => {
          const payload = typeof payloadOrFactory === 'function' ? await payloadOrFactory() : payloadOrFactory
          return stripLoadSkill
            ? { action: 'transform', value: { ...payload, tools: payload.tools.filter((x) => x.name !== 'load_skill') } }
            : { action: 'continue' }
        },
        runHookAround: async (_name: string, payload: unknown, next: (p: unknown) => Promise<unknown>) => next(payload),
      }) as never,
    prepareToolResult: (cid, res, opts) =>
      prepareToolResultWith({ spill: async (_c, _i, text) => ({ text }) }, (x) => x, cid, res, opts),
    safeSummary: (id) => makeConversation(id, { cwd: workspace }),
    currentRunInputs: () => [],
    redact: (x) => x,
    artifacts: { spill: async (_c, _i, text) => ({ text }) },
    turnContext: env.assembler,
  })
  const toolRegistry = new RuntimeToolRegistry({
    registry: { install() {} },
    toolDeps: {
      dataDir: env.dataDir,
      defaultCwd: workspace,
      hubUrl: 'http://127.0.0.1:3202',
      redact: (x) => x,
      artifacts: {
        spill: async (_c, _i, text) => ({ text }),
        get: async () => ({}) as never,
        readContent: async () => '',
        readBuffer: async () => new Uint8Array(),
      },
    },
    getPluginHost: () => undefined,
    isArtifactAuthorized: () => true,
    redact: (x) => x,
    getConversation: (id) => makeConversation(id, { cwd: workspace }),
  })
  void toolRegistry
  bridge.install()

  const beforeRequest = installedExt!.hooks!.find((h) => typeof h.handlers.beforeRequest === 'function')!.handlers.beforeRequest
  const request = {
    messages: [
      {
        role: 'system',
        sections: { base: 'base prompt' },
        toolsAdded: [{ name: 'load_skill', description: 'load skill', parameters: {} }],
      },
      { role: 'user', content: 'hi' },
    ],
  }

  // Round 1: SYSTEM missing + restrictToCwd + agents + skills injected; notification sent once
  const r1 = await beforeRequest(request, { conversationId: 1 })
  assert.ok(r1 !== undefined)
  const sections1 = (r1.messages[0] as { sections: Record<string, string> }).sections
  assert.ok(sections1['profile.assets-missing']?.includes('SYSTEM.md'))
  assert.ok(sections1['profile.workspace-boundary']?.includes(workspace))
  assert.ok(sections1['profile.workspace-boundary']?.includes('path_outside_workspace'))
  assert.ok(sections1['profile.agents']?.includes('# 约定'))
  assert.ok(sections1['profile.skills']?.includes('id="demo-skill"'))
  assert.equal(env.notifications.length, 1)

  // Round 2 (still missing): deduped human notification, model still sees assets-missing
  const r2 = await beforeRequest(request, { conversationId: 1 })
  assert.ok(r2 !== undefined)
  assert.equal(env.notifications.length, 1)

  // Round 3: plugin strips `load_skill` -> profile.skills must disappear while profile.assets-missing/agents/boundary remain
  stripLoadSkill = true
  const r3 = await beforeRequest(request, { conversationId: 1 })
  assert.ok(r3 !== undefined)
  const sections3 = (r3.messages[0] as { sections: Record<string, string> }).sections
  assert.equal(sections3['profile.skills'], undefined, 'stripped load_skill must leave no phantom skills catalog')
  assert.ok(sections3['profile.agents'] !== undefined)
  assert.ok(sections3['profile.workspace-boundary'] !== undefined)
})

// ---------------------------------------------------------------------------
// Direct pure function tests: computeAgentsMdSection
// ---------------------------------------------------------------------------

test('computeAgentsMdSection: empty cwd skips executionEnv and nodeIpc', { timeout: 60_000 }, async () => {
  const host: AgentsMdHostPort = {
    executionEnv() {
      throw new Error('empty cwd must not call executionEnv')
    },
    redact: (t: string) => t,
    nodeIpc: {
      isOnline() {
        throw new Error('empty cwd must not call nodeIpc')
      },
    },
  }
  assert.deepEqual(await computeAgentsMdSection(host, 'remote-1', ''), { kind: 'none' })
  assert.deepEqual(await computeAgentsMdSection(host, undefined, ''), { kind: 'none' })
})

test('computeAgentsMdSection: open errors (not_found, is_directory, EISDIR), dangling symlink, blank content, and isOnline error redaction', { timeout: 60_000 }, async () => {
  const hostOfOpenError = (code: FileErrorCode, message: string): AgentsMdHostPort =>
    hostOf(
      fakeEnv({
        openBinaryReader: (path) => ({ ok: false, error: new FileError(code, message, path) }),
      }),
    )
  assert.deepEqual(await computeAgentsMdSection(hostOfOpenError('not_found', 'ENOENT'), 'remote-1', '/srv/app'), { kind: 'none' })
  assert.deepEqual(await computeAgentsMdSection(hostOfOpenError('is_directory', 'EISDIR'), 'remote-1', '/srv/app'), { kind: 'none' })
  assert.deepEqual(await computeAgentsMdSection(hostOfOpenError('unknown', 'EISDIR: read'), 'remote-1', '/srv/app'), { kind: 'none' })

  const danglingEnv = fakeEnv({
    canonicalPath: (path) => ({ ok: false, error: new FileError('not_found', 'ENOENT', path) }),
  })
  assert.deepEqual(await computeAgentsMdSection(hostOf(danglingEnv), 'remote-1', '/srv/app'), { kind: 'none' })
  assert.deepEqual(opsOf(danglingEnv), ['canonicalPath'])

  const refusedEnv = fakeEnv({
    canonicalPath: (path) => ({ ok: false, error: new FileError('permission_denied', 'EACCES: realpath', path) }),
  })
  const refused = await computeAgentsMdSection(hostOf(refusedEnv), 'remote-1', '/srv/app')
  assert.equal(refused.kind, 'section')
  if (refused.kind === 'section') {
    assert.equal(refused.id, 'profile.agents-unavailable')
    assert.ok(refused.text.includes('（permission_denied）'))
  }

  const blankEnv = fakeEnv({ openBinaryReader: () => ({ ok: true, value: { text: '   \n\t\n' } }) })
  assert.deepEqual(await computeAgentsMdSection(hostOf(blankEnv), 'remote-1', '/srv/app'), { kind: 'none' })
  assert.deepEqual(opsOf(blankEnv), ['canonicalPath', 'openBinaryReader', 'info', 'read', 'info', 'close'])

  const onlineErrHost: AgentsMdHostPort = {
    executionEnv() {
      throw new Error('must not touch executionEnv')
    },
    redact: (text: string) => text.replaceAll('SECRET_probe', '[REDACTED]'),
    nodeIpc: {
      isOnline() {
        throw new Error('探测失败 SECRET_probe')
      },
    },
  }
  const res = await computeAgentsMdSection(onlineErrHost, 'remote-1', '/srv/app')
  assert.equal(res.kind, 'section')
  if (res.kind === 'section') {
    assert.equal(res.id, 'profile.agents-unavailable')
    assert.ok(res.text.includes('在线状态失败（unknown）'))
    assert.ok(res.text.includes('[REDACTED]'))
    assert.ok(!res.text.includes('SECRET_probe'))
  }
})
