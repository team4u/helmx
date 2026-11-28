/**
 * kernel local machine tool real behavior test (bash / read / read_artifact).
 *
 * honest principle: all away real child_process, real ArtifactService(InMemory repository +
 * real file), real SDK defineTool execute;faux provider only alternative model decide policy
 * (what when start tool invoke), never use sync false fixture mask service Promise signature.
 */

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { ExecutionEnv } from '@earendil-works/pi-durable/env'
import {
  fauxAssistantMessage,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ARTIFACT_READ_META_SCHEMA,
  ARTIFACT_REGISTER_META_SCHEMA,
  BASH_TOOL_META_SCHEMA,
  EDIT_TOOL_RESULT_SCHEMA,
  assertBoundedPresentationMeta,
  validateOrThrow,
  type EditToolResult,
} from '@helmx/protocol'
import { createLocalExecutionEnv } from '../src/env/local-host-env.js'
import { KernelRuntime } from '../src/runtime/index.js'
import {
  ArtifactService,
  AuthService,
  InMemoryArtifactRepository,
  SecretStash,
  ensureDataDir,
} from '../src/services/index.js'
import {
  buildToolEnv,
  createBashTool,
  createEditTool,
  createReadArtifactTool,
  createReadTool,
  createRegisterArtifactTool,
  createWriteTool,
  runGate,
  runShell,
} from '../src/runtime/tools.js'
import type { HelmxToolDeps } from '../src/runtime/tool-deps.js'
import { cleanupDir, makeFauxModels, makeTempDir } from './helpers.js'

type FauxHandle = ReturnType<typeof makeFauxModels>['faux']

async function openRuntime(dir: string) {
  const { models, faux } = makeFauxModels()
  const runtime = await KernelRuntime.open({
    dataDir: dir,
    cwd: dir,
    model: 'faux/faux-1',
    models,
  })
  return Object.assign(runtime, { __faux: faux })
}

/** real service dependency: real ArtifactService(Promise signature)+ real SecretStash. */
async function makeRealDeps(dir: string, stash = new SecretStash()): Promise<HelmxToolDeps> {
  await ensureDataDir(dir)
  const artifacts = new ArtifactService(dir, new InMemoryArtifactRepository(), stash)
  return {
    dataDir: dir,
    defaultCwd: dir,
    hubUrl: 'http://127.0.0.1:3202',
    redact: (t) => stash.redact(t),
    createStreamingRedactor: () => stash.createStreamingRedactor(),
    artifacts,
  }
}

let rootDir: string

before(async () => {
  rootDir = await makeTempDir('helmx-tools-test-')
})

after(async () => {
  await cleanupDir(rootDir)
})

describe('runShell real process behavior', { timeout: 60_000 }, () => {
  it('succeeded and failed such as return exitCode;stdout/stderr by reach order concatenate', { timeout: 60_000 }, async () => {
    const deps = await makeRealDeps(join(rootDir, 'rs1'))
    const ok = await runShell(deps, 'echo out; echo err >&2; echo tail')
    assert.equal(ok.ok, true)
    assert.equal(ok.exitCode, 0)
    assert.ok(ok.output.includes('out'))
    assert.ok(ok.output.includes('err'))
    assert.ok(ok.output.includes('tail'))
    const fail = await runShell(deps, 'echo oops >&2; exit 3')
    assert.equal(fail.ok, false)
    assert.equal(fail.exitCode, 3)
    assert.ok(fail.output.includes('oops'))
  })

  it('run in abort kill process group:sentinel file forever do not appear, without waiting 120s timeout', { timeout: 60_000 }, async () => {
    const deps = await makeRealDeps(join(rootDir, 'rs2'))
    const sentinel = join(rootDir, 'rs2', 'sentinel.txt')
    const controller = new AbortController()
    const started = Date.now()
    // command sleep after write sentinel;abort takes effect then forever write do not out.
    const p = runShell(deps, `sleep 30 && touch ${sentinel}`, {
      timeoutMs: 120_000,
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 300)
    const result = await p
    const elapsed = Date.now() - started
    assert.equal(result.ok, false)
    assert.ok(elapsed < 10_000, `abort should second kill while non- etc. full timeout (time cost ${elapsed}ms)`)
    // wait for enough long after confirm sentinel not by write (process group indeed already terminate).
    await new Promise((r) => setTimeout(r, 700))
    assert.ok(!existsSyncSafe(sentinel), 'abort after shell must not store write sentinel')
  })

  it('pre- first aborted  signal never spawn command', { timeout: 60_000 }, async () => {
    const deps = await makeRealDeps(join(rootDir, 'rs3'))
    const sentinel = join(rootDir, 'rs3', 'pre.txt')
    const controller = new AbortController()
    controller.abort()
    const result = await runShell(deps, `touch ${sentinel}`, { signal: controller.signal })
    assert.equal(result.ok, false)
    assert.ok(result.output.includes('aborted'))
    await new Promise((r) => setTimeout(r, 300))
    assert.ok(!existsSyncSafe(sentinel), 'pre- aborted must not spawn any command')
  })

  it('timeoutMs validate: non- correct count / non- integer / Infinity / over cap all explicit reject', { timeout: 60_000 }, async () => {
    const deps = await makeRealDeps(join(rootDir, 'rs4'))
    for (const bad of [0, -5, 1.5, Number.POSITIVE_INFINITY, Number.NaN, 601_000]) {
      await assert.rejects(
        () => runShell(deps, 'true', { timeoutMs: bad }),
        /invalid_timeout/,
        `timeoutMs=${bad} should explicit reject`,
      )
    }
  })

  it('timeout kill group and explicit mark note timeout', { timeout: 60_000 }, async () => {
    const deps = await makeRealDeps(join(rootDir, 'rs5'))
    const started = Date.now()
    const result = await runShell(deps, 'sleep 30', { timeoutMs: 500 })
    assert.equal(result.ok, false)
    assert.equal(result.timedOut, true)
    assert.ok(Date.now() - started < 10_000)
  })

  it('redaction: registered secret disappears from shell output', { timeout: 60_000 }, async () => {
    const stash = new SecretStash()
    const secretValue = 'sk-super-secret-abcdef123456'
    stash.addRedaction(secretValue)
    const deps = await makeRealDeps(join(rootDir, 'rs6'), stash)
    const result = await runShell(deps, `echo "token=${secretValue}"`, { conversationId: 1 })
    assert.equal(result.ok, true)
    assert.ok(!result.output.includes(secretValue), 'secret plaintext never can appear in output')
    assert.ok(result.output.includes('[REDACTED]'), 'should replace with redaction marker')
  })

  it('across chunk tear secret in all text aggregate after still by complete redaction', { timeout: 60_000 }, async () => {
    const stash = new SecretStash()
    const secretValue = 'sk-cross-chunk-secret-ZZZZ9999'
    stash.addRedaction(secretValue)
    const deps = await makeRealDeps(join(rootDir, 'rs7'), stash)
    // use dd by 1 byte chunked output, force secret across multiple stdout chunk tear.
    const result = await runShell(deps, `printf '%s' '${secretValue}' | dd bs=1 2>/dev/null`, {
      conversationId: 1,
    })
    assert.equal(result.ok, true)
    assert.ok(!result.output.includes(secretValue), 'across chunk tear secret also must not leak')
    assert.ok(result.output.includes('[REDACTED]'))
  })

  it('multibyte UTF-8 character across chunk do not tear (without replace symbol)', { timeout: 60_000 }, async () => {
    const deps = await makeRealDeps(join(rootDir, 'rs8'))
    // Chinese character 3 byte;dd bs=1 force one by one byte chunk,StringDecoder semantics under should complete restore.
    const result = await runShell(
      deps,
      `printf '%s' '你好世界Han characters fidelity test' | dd bs=1 2>/dev/null`,
    )
    assert.equal(result.ok, true)
    assert.equal(result.output, '你好世界Han characters fidelity test')
    assert.ok(!result.output.includes('\uFFFD'), 'must not appear UTF-8 replace symbol')
  })

  it('output over maxOutputBytes explicit output_limit_exceeded, never truncate when succeeded', { timeout: 60_000 }, async () => {
    const deps = await makeRealDeps(join(rootDir, 'rs9'))
    const result = await runShell(deps, `head -c 200000 /dev/zero | tr '\\0' 'A'`, {
      maxOutputBytes: 100_000,
    })
    assert.equal(result.ok, false)
    assert.ok(result.output.includes('output_limit_exceeded'))
    assert.ok(!result.output.includes('AAAA'), 'over limit after must not back visible truncate content smoke fill result')
  })

  it('streaming pattern (onOutputChunk): aggregate pre- compute converge is STREAM_AGGREGATE_LIMIT_BYTES, one by one chunk still all push, over limit explicit output_limit_exceeded', { timeout: 60_000 }, async () => {
    const deps = await makeRealDeps(join(rootDir, 'rs-stream'))
    const chunks: Array<{ stream: 'stdout' | 'stderr'; text: string }> = []
    // explicit to out far greater than streaming pre- compute maxOutputBytes: streaming pattern under also must by
    // STREAM_AGGREGATE_LIMIT_BYTES override (old 64MiB all text duplicate is memory leak leak).
    const result = await runShell(deps, `head -c 600000 /dev/zero | tr '\\0' 'B'`, {
      maxOutputBytes: 64 * 1024 * 1024,
      onOutputChunk: (chunk) => chunks.push(chunk),
    })
    assert.equal(result.ok, false, 'exceeds streaming aggregate pre- compute must explicit failed')
    assert.ok(result.output.includes('output_limit_exceeded'), 'must explicit output_limit_exceeded')
    assert.ok(result.output.includes('262144'), `error information must carry real pre- compute (${result.output.slice(0, 120)})`)
    assert.ok(!result.output.includes('BBBB'), 'terminal state diagnose must not back visible over limit content')
    // streaming client already receives all one by one chunk output (600000 byte B),Hub side only abandon terminal state aggregate.
    const streamedBytes = chunks
      .filter((c) => c.stream === 'stdout')
      .reduce((sum, c) => sum + Buffer.byteLength(c.text, 'utf8'), 0)
    assert.equal(streamedBytes, 600000, 'one by one chunk push do not because aggregate over limit while interrupt')
    // not over streaming pre- compute command: aggregate result normal return (streaming pre- compute do not mistakenly damage small output).
    const okResult = await runShell(deps, `printf 'small-stream'`, {
      maxOutputBytes: 64 * 1024 * 1024,
      onOutputChunk: () => undefined,
    })
    assert.equal(okResult.ok, true)
    assert.equal(okResult.output, 'small-stream')
  })

  it('buildToolEnv: populates host variables and HELMX_DATA_DIR from deps', { timeout: 60_000 }, () => {
    const deps: HelmxToolDeps = {
      dataDir: '/d',
      defaultCwd: '/base',
      hubUrl: 'http://127.0.0.1:3202',
      redact: (t) => t,
      artifacts: null as never,
    }
    const env = buildToolEnv(deps, '/work', 7)
    assert.equal(env['HELMX_ENV'], '1')
    assert.equal(env['HELMX_HUB_URL'], 'http://127.0.0.1:3202')
    assert.equal(env['HELMX_CONVERSATION_ID'], '7')
    assert.equal(env['HELMX_CWD'], '/work')
    assert.equal(env['HELMX_DATA_DIR'], '/d')
    // without provider: inherit HELMX_TOKEN must by strip except (without leaking host token)
    assert.equal(env['HELMX_TOKEN'], undefined)
  })

  it('buildToolEnv: strips inherited HELMX_TOKEN without provider and injects managed token with provider', { timeout: 60_000 }, () => {
    const base: HelmxToolDeps = {
      dataDir: '/d',
      defaultCwd: '/base',
      hubUrl: 'http://127.0.0.1:3202',
      redact: (t) => t,
      artifacts: null as never,
    }
    const withProvider = buildToolEnv({ ...base, processToken: () => 'managed-tok-1' }, '/work', 8)
    assert.equal(withProvider['HELMX_TOKEN'], 'managed-tok-1')
    const noProvider = buildToolEnv(base, '/work', 8)
    assert.equal(noProvider['HELMX_TOKEN'], undefined)
  })

  it('runShell: child process hold managed HELMX_TOKEN and output redaction inside outside token; without provider when child process without HELMX_TOKEN', { timeout: 60_000 }, async () => {
    // has provider: child process visible managed token(honest boundary: can message code solid has permission), but output redaction
    const auth = new AuthService(join(rootDir, 'rs10'))
    const managed = auth.createProcessToken()
    const releaseRedaction = (() => {
      const stash = new SecretStash()
      return { stash, release: stash.addRedaction(managed.token) }
    })()
    const depsManaged = await makeRealDeps(join(rootDir, 'rs11'), releaseRedaction.stash)
    const depsWithToken: HelmxToolDeps = {
      ...depsManaged,
      processToken: () => managed.token,
    }
    const echo = await runShell(depsWithToken, 'printf %s "$HELMX_TOKEN" | dd bs=1 2>/dev/null', { conversationId: 1 })
    assert.equal(echo.ok, true)
    assert.ok(!echo.output.includes(managed.token), 'managed token plaintext must not appear in output')
    assert.ok(echo.output.includes('[REDACTED]'), 'should replace is REDACTED mark record')

    // also contains inherit host token and managed token output: two all must not leak leak
    const hostEnv = process.env['HELMX_TOKEN']
    const both = await runShell(
      depsWithToken,
      `printf '%s %s' "${hostEnv ?? 'inherited-host-token'}" "$HELMX_TOKEN" | dd bs=1 2>/dev/null`,
      { conversationId: 1 },
    )
    assert.equal(both.ok, true)
    assert.ok(!both.output.includes(managed.token), 'managed token must not leak leak')
    assert.ok(!hostEnv || !both.output.includes(hostEnv), 'inherit host token must not leak leak')

    // without provider: child process environment in no HELMX_TOKEN(inherit value by strip except)
    const depsPlain = await makeRealDeps(join(rootDir, 'rs12'))
    const absent = await runShell(depsPlain, 'echo "${HELMX_TOKEN:-UNSET}"', { conversationId: 1 })
    assert.equal(absent.ok, true)
    assert.ok(absent.output.includes('UNSET'), 'without provider when child process must not inherit HELMX_TOKEN')

    // dispose after managed token expires (process inside lifecycle)
    managed.dispose()
    assert.equal(await new AuthService(join(rootDir, 'rs10')).verifyToken(managed.token), false)
    releaseRedaction.release()
  })
})

describe('runGate gate real execute', { timeout: 60_000 }, () => {
  it('through out underlying result:exitCode/timedOut such as (succeeded 0, failed non- 0)', { timeout: 60_000 }, async () => {
    const deps = await makeRealDeps(join(rootDir, 'rg1'))
    const ok = await runGate(deps, 'echo gate-ok')
    assert.equal(ok.ok, true)
    assert.equal(ok.exitCode, 0)
    assert.equal(ok.timedOut, false)
    assert.ok(ok.output.includes('gate-ok'))
    const fail = await runGate(deps, 'echo gate-err >&2; exit 3')
    assert.equal(fail.ok, false)
    assert.equal(fail.exitCode, 3)
    assert.equal(fail.timedOut, false)
    assert.ok(fail.output.includes('gate-err'))
  })

  it('timeoutMs can match: short timeout kill process group and return timedOut=true / exitCode=null', { timeout: 60_000 }, async () => {
    const deps = await makeRealDeps(join(rootDir, 'rg2'))
    const started = Date.now()
    const result = await runGate(deps, 'sleep 30', { timeoutMs: 500 })
    assert.equal(result.ok, false)
    assert.equal(result.timedOut, true)
    assert.equal(result.exitCode, null)
    assert.ok(Date.now() - started < 10_000, 'timeout should kill group while non- etc. full 30s')
    assert.ok(result.output.includes('timeout'))
  })

  it('timeoutMs illegal value via runShell explicit reject (not silently change by default)', { timeout: 60_000 }, async () => {
    const deps = await makeRealDeps(join(rootDir, 'rg3'))
    for (const bad of [0, -5, 1.5, Number.NaN, 601_000]) {
      await assert.rejects(
        () => runGate(deps, 'true', { timeoutMs: bad }),
        /invalid_timeout/,
        `timeoutMs=${bad} should explicit reject`,
      )
    }
  })
})

describe('read tool real file behavior', { timeout: 60_000 }, () => {
  it('read cwd inside file succeeded; content via spill return', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'rd1')
    const deps = await makeRealDeps(dir)
    writeFileSync(join(dir, 'note.md'), '# title\nbody text')
    const tool = createReadTool(deps)
    const result = await tool.execute(
      { path: 'note.md' },
      makeApi(dir),
      BACKGROUND_CONTEXT,
    )
    assert.equal(!!result.isError, false)
    const structured = result.structuredOutput as { content: string }
    assert.ok(structured.content.includes('# title'))
    // details is persist UI channel: only carry fact metadata, do not double write content.
    const details = result.details as { path?: string; nodeId?: string; content?: string }
    assert.equal(typeof details.path, 'string')
    assert.equal(details.nodeId, 'local')
    assert.equal('content' in details, false)
  })

  it('../ across directory and cwd outside absolute path read succeeded (and bash same right)', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'rd2')
    mkdirSync(join(dir, 'inner'), { recursive: true })
    const deps = await makeRealDeps(join(dir, 'inner'))
    writeFileSync(join(dir, 'secret.txt'), 'outside')
    const tool = createReadTool(deps)
    for (const p of ['../secret.txt', join(dir, 'secret.txt'), '/etc/hostname']) {
      const result = await tool.execute({ path: p }, makeApi(join(dir, 'inner')), BACKGROUND_CONTEXT)
      assert.equal(!!result.isError, false, `path ${p} should allows read`)
    }
    const structured = (
      await tool.execute({ path: '../secret.txt' }, makeApi(join(dir, 'inner')), BACKGROUND_CONTEXT)
    ).structuredOutput as { content: string }
    assert.ok(structured.content.includes('outside'), 'should read to cwd outside file content')
  })

  it('symlink with follow read (points to cwd outside target also allows)', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'rd3')
    const outer = join(rootDir, 'rd3-outer')
    mkdirSync(outer, { recursive: true })
    mkdirSync(join(dir, 'inner'), { recursive: true })
    writeFileSync(join(outer, 'linked.txt'), 'via-symlink')
    symlinkSync(join(outer, 'linked.txt'), join(dir, 'inner', 'link.txt'))
    const deps = await makeRealDeps(join(dir, 'inner'))
    const tool = createReadTool(deps)
    const result = await tool.execute(
      { path: 'link.txt' },
      makeApi(join(dir, 'inner')),
      BACKGROUND_CONTEXT,
    )
    assert.equal(!!result.isError, false, 'symlink should with follow read (and bash same right)')
    const structured = result.structuredOutput as { content: string }
    assert.ok(structured.content.includes('via-symlink'))
  })

  it('directory reject; large file (>128 KiB) paginates via offset/limit, strips BOM, and reads PNG image', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'rd4')
    const deps = await makeRealDeps(dir)
    const tool = createReadTool(deps)
    const dirResult = await tool.execute({ path: '.' }, makeApi(dir), BACKGROUND_CONTEXT)
    assert.equal(dirResult.isError, true)
    assert.ok(((dirResult.output as Array<{ text: string }>)[0]!.text).includes('is directory'))

    const lines = Array.from({ length: 2400 }, (_, i) => `L${i + 1}:${'a'.repeat(60)}`)
    writeFileSync(join(dir, 'big.txt'), `\uFEFF${lines.join('\n')}\n`, 'utf8')
    const first = await tool.execute({ path: 'big.txt' }, makeApi(dir), BACKGROUND_CONTEXT)
    assert.equal(!!first.isError, false)
    const firstOut = first.structuredOutput as { content: string; truncation?: { truncated: boolean; outputLines: number } }
    assert.equal(firstOut.content.startsWith('\uFEFF'), false, 'UTF-8 BOM must be stripped')
    assert.ok(firstOut.content.startsWith('L1:'))
    assert.equal(firstOut.truncation?.truncated, true)
    assert.ok(first.diagnostics?.some((d) => d.message.includes('Use offset=')))

    const tail = await tool.execute({ path: 'big.txt', offset: 2350, limit: 100 }, makeApi(dir), BACKGROUND_CONTEXT)
    assert.equal(!!tail.isError, false)
    const tailOut = tail.structuredOutput as { content: string }
    assert.ok(tailOut.content.includes('L2400:'))

    // Real 1x1 PNG multimodal image read
    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    writeFileSync(join(dir, 'pixel.png'), Buffer.from(pngBase64, 'base64'))
    const imgRes = await tool.execute({ path: 'pixel.png' }, makeApi(dir), BACKGROUND_CONTEXT)
    assert.equal(!!imgRes.isError, false)
    const imgBlock = (imgRes.output as Array<{ type: string; mimeType?: string; data?: string }>)[0]!
    assert.equal(imgBlock.type, 'image')
    assert.equal(imgBlock.mimeType, 'image/png')
    assert.ok(typeof imgBlock.data === 'string' && imgBlock.data.length > 0)
    assert.equal((imgRes.details as { mimeType?: string }).mimeType, 'image/png')
  })

  it('read error redaction (secret does not enter error text)', { timeout: 60_000 }, async () => {
    const stash = new SecretStash()
    const secretValue = 'sk-read-error-secret-777'
    stash.addRedaction(secretValue)
    const dir = join(rootDir, 'rd5')
    const deps = await makeRealDeps(dir, stash)
    const tool = createReadTool(deps)
    const result = await tool.execute(
      { path: 'no-such-file.txt' },
      makeApi(dir, 1),
      BACKGROUND_CONTEXT,
    )
    assert.equal(result.isError, true)
    assert.ok(!JSON.stringify(result).includes(secretValue), 'error text same must redaction')
  })

  it('read remote offline node rejects explicitly with node_offline and never falls back to local disk', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'rd-offline')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'local-only.txt'), 'must-not-leak', 'utf8')
    const baseDeps = await makeRealDeps(dir)
    const offlineDeps: HelmxToolDeps = {
      ...baseDeps,
      nodeIdOf: () => 'remote-offline',
      envFabric: {
        isOnline: () => false,
        nodePlatformOf: () => 'linux',
        envFor: () => {
          throw new Error('must not be called when offline')
        },
        envForTarget: () => {
          throw new Error('must not be called when offline')
        },
      } as never,
    }
    const tool = createReadTool(offlineDeps)
    const res = await tool.execute({ path: 'local-only.txt' }, makeApi(dir, 1), BACKGROUND_CONTEXT)
    assert.equal(res.isError, true)
    const text = (res.output as Array<{ type: string; text: string }>)[0]!.text
    assert.ok(text.includes('node_offline'), `expected node_offline error, got: ${text}`)
    assert.ok(!text.includes('must-not-leak'))
  })
})

describe('read_artifact real ArtifactService behavior', { timeout: 60_000 }, () => {
  it('read succeeded: real spill artifact page before enter until read completely', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'ra1')
    const deps = await makeRealDeps(dir)
    const fullText = 'Chinese'.repeat(8000) // 48000 byte > 32KiB trigger real spill
    const { artifact } = await deps.artifacts.spill(1, 'call-1', fullText)
    assert.ok(artifact, 'text >32KiB should produce spill artifact')
    const tool = createReadArtifactTool(deps, (conv, owner) => conv === owner)
    let offset = 0
    let chunks = ''
    let guard = 0
    for (;;) {
      const result = await tool.execute(
        { id: artifact!.id, offset, limit: 4096 },
        makeApi(dir, 1),
        BACKGROUND_CONTEXT,
      )
      assert.equal(!!result.isError, false)
      const structured = result.structuredOutput as { chunk: string; nextOffset?: number }
      chunks += structured.chunk
      if (structured.nextOffset === undefined) break
      assert.ok(structured.nextOffset > offset, `nextOffset must strictly before enter (${offset} -> ${structured.nextOffset})`)
      offset = structured.nextOffset
      assert.ok(++guard < 100, 'page loop must terminate')
    }
    assert.equal(chunks, fullText, 'page concatenate should restore all text (UTF-8 boundary without loss)')
  })

  it('any offset never produce replace symbol;limit=1 encounter multibyte character still guarantee before enter', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'ra2')
    const deps = await makeRealDeps(dir)
    const { artifact } = await deps.artifacts.spill(1, 'call-2', '漢字テスト'.repeat(3000))
    const tool = createReadArtifactTool(deps, (conv, owner) => conv === owner)
    const fullText = '漢字テスト'.repeat(3000)
    const buffer = Buffer.from(fullText, 'utf8')
    // iterate each byte offset:chunk must not contains replace symbol;limit=1 also must can read completely.
    for (let offset = 0; offset < buffer.length; offset += 997) {
      const result = await tool.execute(
        { id: artifact!.id, offset, limit: 1 },
        makeApi(dir, 1),
        BACKGROUND_CONTEXT,
      )
      const structured = result.structuredOutput as { chunk: string; nextOffset?: number }
      assert.ok(!structured.chunk.includes('\uFFFD'), `offset=${offset} must not tear out replace symbol`)
      assert.ok(
        structured.nextOffset === undefined || structured.nextOffset > offset,
        `offset=${offset} limit=1 also must before enter`,
      )
    }
    // ① limit=1 from character middle offset=1 start connect continue read 15 step, skip leftover missing first token symbol after one by one character restore
    const midCharOffset = 1 // Han 2 byte
    let headOffset = midCharOffset
    let headTotal = ''
    for (let step = 0; step < 15; step += 1) {
      const result = await tool.execute(
        { id: artifact!.id, offset: headOffset, limit: 1 },
        makeApi(dir, 1),
        BACKGROUND_CONTEXT,
      )
      const structured = result.structuredOutput as { chunk: string; nextOffset?: number }
      assert.ok(!structured.chunk.includes('\uFFFD'), `head step=${step} must not tear out replace symbol`)
      assert.ok(
        structured.nextOffset !== undefined && structured.nextOffset > headOffset,
        `head step=${step} nextOffset must strictly pass increase (${headOffset} -> ${structured.nextOffset})`,
      )
      headTotal += structured.chunk
      headOffset = structured.nextOffset
    }
    assert.equal(headTotal, fullText.slice(1, 16), 'from character middle start read should skip leftover missing first token symbol one by one character restore before 15 character')

    // ② from tail attach near byte (in multibyte character middle) start use limit=1 read until tail, precise restore tail part text and terminate
    let tailOffset = buffer.length - 17
    let tailTotal = ''
    let tailGuard = 0
    for (;;) {
      const result = await tool.execute(
        { id: artifact!.id, offset: tailOffset, limit: 1 },
        makeApi(dir, 1),
        BACKGROUND_CONTEXT,
      )
      const structured = result.structuredOutput as { chunk: string; nextOffset?: number }
      assert.ok(!structured.chunk.includes('\uFFFD'), `tail offset=${tailOffset} must not tear out replace symbol`)
      tailTotal += structured.chunk
      if (structured.nextOffset === undefined) break
      assert.ok(structured.nextOffset > tailOffset, `tail nextOffset must strictly before enter (${tailOffset} -> ${structured.nextOffset})`)
      tailOffset = structured.nextOffset
      assert.ok(++tailGuard < 20, 'tail part one by one character page must normal terminate')
    }
    assert.equal(tailTotal, fullText.slice(-5), 'from tail multibyte character middle start read should skip leftover missing first token symbol and precise restore tail part')
  })

  it('out of bounds conversation reject (authorization only when before conversation/parent chain)', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'ra3')
    const deps = await makeRealDeps(dir)
    const { artifact } = await deps.artifacts.spill(2, 'call-3', 'owner-2-content-'.repeat(3000))
    const tool = createReadArtifactTool(
      deps,
      (conv, owner) => conv === owner, // simulated runtime conversation/parent chain authorization
    )
    const denied = await tool.execute({ id: artifact!.id }, makeApi(dir, 1), BACKGROUND_CONTEXT)
    assert.equal(denied.isError, true)
    const allowed = await tool.execute({ id: artifact!.id }, makeApi(dir, 2), BACKGROUND_CONTEXT)
    assert.equal(!!allowed.isError, false)
  })

  it('store failed to read does not pretend to be into artifact_not_found(honest: real error such as through out)', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'ra3b')
    await ensureDataDir(dir)
    const real = new ArtifactService(dir, new InMemoryArtifactRepository(), new SecretStash())
    const storageBug = new Error('sqlite: disk I/O error')
    const deps: HelmxToolDeps = {
      dataDir: dir,
      defaultCwd: dir,
      hubUrl: 'http://127.0.0.1:3202',
      redact: (t) => t,
      artifacts: {
        spill: (conversationId, callId, text) => real.spill(conversationId, callId, text),
        get: async () => {
          throw storageBug
        },
        readContent: (id) => real.readContent(id),
        readBuffer: (id) => real.readBuffer(id),
      },
    }
    const tool = createReadArtifactTool(deps, () => true)
    const result = await tool.execute({ id: 'any-id' }, makeApi(dir, 1), BACKGROUND_CONTEXT)
    assert.equal(result.isError, true)
    const text = (result.output as Array<{ text: string }>)[0]!.text
    assert.ok(text.includes('artifact_read_failed'), `should such as report store failed to read:${text}`)
    assert.ok(text.includes('disk I/O error'), `real error text must through out:${text}`)
    assert.ok(!text.includes('artifact_not_found'), `store failed must not disguise into missing:${text}`)
  })

  it('missing artifact artifact_not_found;offset over scope explicit reject;nextOffset do not output undefined field', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'ra4')
    const deps = await makeRealDeps(dir)
    const tool = createReadArtifactTool(deps, () => true)
    const missing = await tool.execute({ id: 'no-such-id' }, makeApi(dir, 1), BACKGROUND_CONTEXT)
    assert.equal(missing.isError, true)
    assert.ok(
      ((missing.output as Array<{ text: string }>)[0]!.text).includes('artifact_not_found'),
    )
    const { artifact } = await deps.artifacts.spill(1, 'call-4', 'short-content-'.repeat(3000))
    const oob = await tool.execute(
      { id: artifact!.id, offset: 99999 },
      makeApi(dir, 1),
      BACKGROUND_CONTEXT,
    )
    assert.equal(oob.isError, true)
    assert.ok(((oob.output as Array<{ text: string }>)[0]!.text).includes('offset_out_of_range'))
    // page until finally one page after structuredOutput without nextOffset field (JSON-safe, non- undefined value)
    let lastOffset = 0
    let last: { structuredOutput?: Record<string, unknown> } = {}
    for (let guard = 0; guard < 100; guard++) {
      const page = (await tool.execute(
        { id: artifact!.id, offset: lastOffset },
        makeApi(dir, 1),
        BACKGROUND_CONTEXT,
      )) as { structuredOutput?: Record<string, unknown> }
      last = page
      const next = (page.structuredOutput as { nextOffset?: number }).nextOffset
      if (next === undefined) break
      lastOffset = next
    }
    const structured = last.structuredOutput as Record<string, unknown>
    assert.ok(!('nextOffset' in structured), 'read completely when must not appear undefined  nextOffset field')
    assert.equal(JSON.stringify(structured).includes('undefined'), false)
  })

  it('read_artifact & register_artifact emit schema-valid lightweight details across empty/UTF-8/EOF/error boundaries', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'ra-meta-bounds')
    mkdirSync(dir, { recursive: true })
    const deps = await makeRealDeps(dir)
    const registerTool = createRegisterArtifactTool(deps)
    const readTool = createReadArtifactTool(deps, (conv, owner) => conv === owner)

    // 1. register_artifact on normal file & 0-byte empty file + error paths.
    writeFileSync(join(dir, 'sample.txt'), 'hello-world')
    writeFileSync(join(dir, 'empty.txt'), '')
    mkdirSync(join(dir, 'subdir'), { recursive: true })

    const regOk = await registerTool.execute({ path: 'sample.txt' }, makeApi(dir, 1), BACKGROUND_CONTEXT)
    assert.equal(!!regOk.isError, false)
    const regDetails = assertBoundedPresentationMeta(regOk.details, { schema: ARTIFACT_REGISTER_META_SCHEMA })
    assert.deepEqual(regDetails, regOk.structuredOutput)
    assert.notEqual(regOk.details, regOk.structuredOutput, 'details should not alias structuredOutput reference')
    assert.equal(regDetails['size'], 11)
    assert.equal(regDetails['nodeId'], 'local')

    const regEmpty = await registerTool.execute({ path: 'empty.txt' }, makeApi(dir, 1), BACKGROUND_CONTEXT)
    assert.equal(!!regEmpty.isError, false)
    const emptyRegDetails = assertBoundedPresentationMeta(regEmpty.details, { schema: ARTIFACT_REGISTER_META_SCHEMA })
    assert.equal(emptyRegDetails['size'], 0)
    const emptyArtId = String(emptyRegDetails['artifactId'])

    const regDirErr = await registerTool.execute({ path: 'subdir' }, makeApi(dir, 1), BACKGROUND_CONTEXT)
    assert.equal(regDirErr.isError, true)
    assert.equal(regDirErr.details, undefined)
    const regMissingErr = await registerTool.execute({ path: 'missing.txt' }, makeApi(dir, 1), BACKGROUND_CONTEXT)
    assert.equal(regMissingErr.isError, true)
    assert.equal(regMissingErr.details, undefined)

    // 2. read_artifact on 0-byte artifact (EOF at offset 0).
    const readEmpty = await readTool.execute({ id: emptyArtId, offset: 0 }, makeApi(dir, 1), BACKGROUND_CONTEXT)
    assert.equal(!!readEmpty.isError, false)
    const emptyReadDetails = assertBoundedPresentationMeta(readEmpty.details, { schema: ARTIFACT_READ_META_SCHEMA })
    assert.deepEqual(emptyReadDetails, { id: emptyArtId, offset: 0, bytes: 0 })
    assert.equal('chunk' in emptyReadDetails, false)
    assert.equal('nextOffset' in emptyReadDetails, false)

    // 3. read_artifact mid-UTF-8 character offset: '中文a' (7 UTF-8 bytes: 中=0..2, 文=3..5, a=6).
    const utf8Meta = await deps.artifacts.writeUploaded!(1, {
      name: 'utf8.txt',
      bytes: Buffer.from('中文a', 'utf8'),
      mimeType: 'text/plain',
    })
    const midRead = await readTool.execute({ id: utf8Meta.id, offset: 1, limit: 4096 }, makeApi(dir, 1), BACKGROUND_CONTEXT)
    assert.equal(!!midRead.isError, false)
    assert.equal((midRead.structuredOutput as { chunk: string }).chunk, '文a')
    const midDetails = assertBoundedPresentationMeta(midRead.details, { schema: ARTIFACT_READ_META_SCHEMA })
    assert.deepEqual(midDetails, { id: utf8Meta.id, offset: 1, bytes: 4 })
    assert.equal('chunk' in midDetails, false)

    // Mid-UTF-8 offset inside final 3-byte char ('中文' = 6 bytes, offset=4 -> start aligns to 6 -> bytes=0).
    const utf8Tail = await deps.artifacts.writeUploaded!(1, {
      name: 'utf8-tail.txt',
      bytes: Buffer.from('中文', 'utf8'),
      mimeType: 'text/plain',
    })
    const tailMidRead = await readTool.execute({ id: utf8Tail.id, offset: 4, limit: 4096 }, makeApi(dir, 1), BACKGROUND_CONTEXT)
    assert.equal(!!tailMidRead.isError, false)
    assert.equal((tailMidRead.structuredOutput as { chunk: string }).chunk, '')
    const tailMidDetails = assertBoundedPresentationMeta(tailMidRead.details, { schema: ARTIFACT_READ_META_SCHEMA })
    assert.deepEqual(tailMidDetails, { id: utf8Tail.id, offset: 4, bytes: 0 })
    assert.equal('chunk' in tailMidDetails, false)

    // 4. Error paths omit details completely.
    const errMissing = await readTool.execute({ id: 'missing-id' }, makeApi(dir, 1), BACKGROUND_CONTEXT)
    assert.equal(errMissing.isError, true)
    assert.equal(errMissing.details, undefined)
    const errForbidden = await readTool.execute({ id: utf8Meta.id }, makeApi(dir, 2), BACKGROUND_CONTEXT)
    assert.equal(errForbidden.isError, true)
    assert.equal(errForbidden.details, undefined)
    const errOob = await readTool.execute({ id: utf8Meta.id, offset: 999 }, makeApi(dir, 1), BACKGROUND_CONTEXT)
    assert.equal(errOob.isError, true)
    assert.equal(errOob.details, undefined)
  })
})

describe('bash tool (SDK execute direct tune, real service dependency)', { timeout: 60_000 }, () => {
  it('succeeded execute and return structuredOutput(via real spill)', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'bt1')
    const deps = await makeRealDeps(dir)
    const tool = createBashTool(deps)
    const result = await tool.execute(
      { command: 'echo hello-tools' },
      makeApi(dir, 1),
      BACKGROUND_CONTEXT,
    )
    assert.equal(!!result.isError, false)
    const structured = result.structuredOutput as { ok: boolean; output: string }
    assert.equal(structured.ok, true)
    assert.ok(structured.output.includes('hello-tools'))
    // details persist UI channel: keep execute fact, no longer carry output text.
    const details = result.details as Record<string, unknown>
    assert.equal(details['ok'], true)
    assert.equal(details['exitCode'], 0)
    assert.equal(details['timedOut'], false)
    assert.equal('output' in details, false)
  })

  it('failed command isError such as;timeoutMs illegal value explicit reject', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'bt2')
    const deps = await makeRealDeps(dir)
    const tool = createBashTool(deps)
    const fail = await tool.execute(
      { command: 'exit 7' },
      makeApi(dir, 1),
      BACKGROUND_CONTEXT,
    )
    assert.equal(fail.isError, true)
    const bad = await tool.execute(
      { command: 'true', timeoutMs: -1 },
      makeApi(dir, 1),
      BACKGROUND_CONTEXT,
    )
    assert.equal(bad.isError, true)
    assert.ok(
      ((bad.output as Array<{ text: string }>)[0]!.text).includes('invalid_timeout'),
      'illegal timeout must not by static default change by default',
    )
  })

  it('>1.2 MiB output retains bounded tail without output_limit_exceeded, spills readable artifact, and cleans temp spillPath', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'bt-large-spill')
    const deps = await makeRealDeps(dir)
    const tool = createBashTool(deps)
    const realEnv = createLocalExecutionEnv({ cwd: dir })
    const removedPaths: string[] = []
    let capturedSpillPath: string | undefined
    const spyEnv: ExecutionEnv = Object.assign(Object.create(Object.getPrototypeOf(realEnv)), realEnv, {
      async exec(command: string | readonly string[], opts: Parameters<ExecutionEnv['exec']>[1], ctx: Parameters<ExecutionEnv['exec']>[2]) {
        const res = await realEnv.exec(command, opts, ctx)
        capturedSpillPath = res.ok ? res.value.spillPath : res.error.spillPath
        return res
      },
      async remove(path: string, opts: Parameters<ExecutionEnv['remove']>[1], ctx: Parameters<ExecutionEnv['remove']>[2]) {
        removedPaths.push(path)
        return realEnv.remove(path, opts, ctx)
      },
    })
    const liveChunks: string[] = []
    const baseApi = makeApi(dir, 1) as unknown as Record<string, unknown>
    const api = {
      ...baseApi,
      env: spyEnv,
      output(chunk: string) {
        liveChunks.push(chunk)
      },
    }
    try {
      // >1.2 MiB across 30,000 lines (far above legacy 1 MiB fail threshold).
      const cmd = `python3 -c "for i in range(1, 30001): print(f'line-{i:05d}-' + 'X'*32)"`
      const result = await tool.execute({ command: cmd }, api as never, BACKGROUND_CONTEXT)
      assert.equal(result.isError, false, 'large bash output must succeed with tail + artifact spill')
      const text = (result.output as Array<{ text: string }>)[0]!.text
      assert.ok(!text.includes('output_limit_exceeded'), 'model bash tool must no longer fail with output_limit_exceeded')
      assert.ok(text.includes('line-30000-'), 'trailing lines must be preserved in tool output')
      assert.ok(!text.includes('line-00001-'), 'early prefix lines must be trimmed from inline output')
      assert.match(text, /\[Output truncated \((lines|bytes)\):/, 'truncation summary should be present')
      const match = /\[Artifact\] id=([^\s]+)/.exec(text)
      assert.ok(match?.[1], 'artifact reference must be present in output')
      assert.ok(liveChunks.join('').includes('line-30000-'), 'api.output() must stream output chunks live')

      const details = assertBoundedPresentationMeta(result.details, { schema: BASH_TOOL_META_SCHEMA })
      assert.deepEqual(details, { ok: true, exitCode: 0, timedOut: false, nodeId: 'local', cwd: dir })

      // Verify full >1.2 MiB output is preserved in ArtifactService and readable via read_artifact.
      const readArt = createReadArtifactTool(deps, (c, o) => c === o)
      const firstPage = await readArt.execute({ id: match[1]!, offset: 0, limit: 4096 }, makeApi(dir, 1), BACKGROUND_CONTEXT)
      assert.equal(!!firstPage.isError, false)
      assert.ok((firstPage.structuredOutput as { chunk: string }).chunk.includes('line-00001-'))

      // Verify temporary node spillPath was both requested for removal and actually removed from disk.
      assert.ok(capturedSpillPath !== undefined, 'ExecutionEnv.exec should emit spillPath when thresholds exceeded')
      assert.ok(removedPaths.includes(capturedSpillPath!), 'spillPath must be deleted via env.remove in finally')
      assert.equal(existsSync(capturedSpillPath!), false, 'temp spillPath file must not remain on disk')
    } finally {
      await realEnv.cleanup(BACKGROUND_CONTEXT)
    }
  })

  it('split-chunk SecretStash secret is redacted in api.output() live stream, tail output, and spill artifact', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'bt-live-redact')
    const stash = new SecretStash()
    const secret = 'sk-bash-live-stream-secret-998877'
    stash.addRedaction(secret)
    const deps = await makeRealDeps(dir, stash)
    const tool = createBashTool(deps)
    const liveChunks: string[] = []
    const baseApi = makeApi(dir, 1) as unknown as Record<string, unknown>
    const api = {
      ...baseApi,
      output(chunk: string) {
        liveChunks.push(chunk)
      },
    }
    // Print >55 KiB so artifact spill also runs, with secret split by dd bs=1 right inside chunks.
    const cmd = `{ printf 'head=%s-tail\\n' '${secret}' | dd bs=1 2>/dev/null; python3 -c "print('P'*60000)"; printf 'end=%s!\\n' '${secret}' | dd bs=1 2>/dev/null; }`
    const result = await tool.execute({ command: cmd }, api as never, BACKGROUND_CONTEXT)
    assert.equal(result.isError, false)
    const liveAll = liveChunks.join('')
    assert.equal(liveAll.includes(secret), false, 'plaintext secret must never reach api.output()')
    assert.ok(liveAll.includes('head=[REDACTED]-tail'), 'live stream must emit redacted prefix')
    assert.ok(liveAll.includes('end=[REDACTED]!'), 'live stream must emit redacted suffix')

    const text = (result.output as Array<{ text: string }>)[0]!.text
    assert.equal(text.includes(secret), false, 'final output must not contain secret')
    const artMatch = /\[Artifact\] id=([^\s]+)/.exec(text)
    assert.ok(artMatch?.[1], 'spill artifact must be written')
    const artifactText = await deps.artifacts.readContent(artMatch[1]!)
    assert.equal(artifactText.includes(secret), false, 'spilled artifact must never contain plaintext secret')
    assert.ok(artifactText.includes('head=[REDACTED]-tail'))
    assert.ok(artifactText.includes('end=[REDACTED]!'))
  })

  it('timeout emits BASH_TOOL_META_SCHEMA details with timedOut=true and exitCode=null', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'bt-timeout-meta')
    const deps = await makeRealDeps(dir)
    const tool = createBashTool(deps)
    const result = await tool.execute(
      { command: 'echo before-timeout; sleep 30', timeoutMs: 400 },
      makeApi(dir, 1),
      BACKGROUND_CONTEXT,
    )
    assert.equal(result.isError, true)
    const text = (result.output as Array<{ text: string }>)[0]!.text
    assert.ok(text.includes('before-timeout'))
    assert.ok(text.includes('timeout after 400ms'))
    const details = assertBoundedPresentationMeta(result.details, { schema: BASH_TOOL_META_SCHEMA })
    assert.deepEqual(details, { ok: false, exitCode: null, timedOut: true, nodeId: 'local', cwd: dir })
  })
})

describe('SDK real link (faux model drive tool invoke)', { timeout: 60_000 }, () => {
  it('bash tool via harness real execute + spill artifact register + read_artifact page read back', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'sdk1')
    const kernel = (await openRuntime(dir)) as never as {
      __faux: FauxHandle
      close(): Promise<void>
      conversations: {
        submitInput(id: number, text: string): Promise<unknown>
        waitForIdle(id: number): Promise<void>
        getLastAssistantText(id: number): Promise<string>
      }
      services: { artifacts: ArtifactService }
    }
    try {
      const bigCommand = `python3 -c "print('B'*60000)"`
      kernel.__faux.setResponses([
        fauxAssistantMessage([fauxToolCall('bash', { command: bigCommand })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage('complete'),
      ])
      await kernel.conversations.submitInput(1, 'generate large output')
      await kernel.conversations.waitForIdle(1)
      assert.equal(await kernel.conversations.getLastAssistantText(1), 'complete')
      const artifacts = await kernel.services.artifacts.list(1)
      const spill = artifacts.find((a) => a.name.startsWith('tool-spill-'))
      assert.ok(spill, 'should has spill artifact')
      // real read_artifact link read back (authorization chain allows conversation 1)
      const content = await kernel.services.artifacts.readContent(spill!.id)
      assert.ok(content.includes('BBBBB'))
    } finally {
      await kernel.close()
    }
  })

  it('edit difference via real harness written to the database is toolResult message details(Web difference render persist channel)', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'sdk3')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'code.ts'), 'alpha\nbeta\n')
    const kernel = (await openRuntime(dir)) as never as {
      __faux: FauxHandle
      close(): Promise<void>
      conversations: {
        submitInput(id: number, text: string): Promise<unknown>
        waitForIdle(id: number): Promise<void>
        getConversationDetail(id: number): Promise<{ entries: Array<{ kind: string; model?: unknown[] }> }>
      }
    }
    try {
      kernel.__faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall('edit', { path: 'code.ts', oldText: 'beta', newText: 'BETA' })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('complete'),
      ])
      await kernel.conversations.submitInput(1, 'change file')
      await kernel.conversations.waitForIdle(1)
      assert.equal(readFileSync(join(dir, 'code.ts'), 'utf8'), 'alpha\nBETA\n')
      const detail = await kernel.conversations.getConversationDetail(1)
      const messages = detail.entries
        .filter((e: { kind: string; model?: unknown[] }) => e.kind === 'pi.tool-result')
        .flatMap((e: { kind: string; model?: unknown[] }) => ((e.model ?? []) as Array<Record<string, unknown>>))
      const editMessage = messages.find((m: Record<string, unknown>) => m['toolName'] === 'edit')
      assert.ok(editMessage, 'should has edit  toolResult message')
      // SDK contract:structuredOutput do not write conversation item (only to embed set caller) - - persist
      // UI channel is details,Web difference render read it (regression: once all read fewer than leads to cannot render difference).
      assert.equal('structuredOutput' in editMessage!, false)
      validateOrThrow(EDIT_TOOL_RESULT_SCHEMA, editMessage!['details'], 'details should conforms to EDIT_TOOL_RESULT_SCHEMA')
      assert.equal((editMessage!['details'] as EditToolResult).diff.addedLines, 1)
    } finally {
      await kernel.close()
    }
  })

  it('register_artifact & read_artifact persist lightweight schema-valid details across restart without duplicating chunk text, and HookBridge rejects injected chunk/hidden keys', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'sdk-artifact-meta')
    mkdirSync(dir, { recursive: true })
    const secret = 'TOP_SECRET_ART_TOKEN'
    const fileName = `report-${secret}.txt`
    const fileBody = `BODY_CHUNK_SENTINEL_${secret}\n`.repeat(220) // > 5 KiB, spans 2 pages at 4096B
    writeFileSync(join(dir, fileName), fileBody)

    const kernel = await openRuntime(dir)
    const disposeSecret = kernel.stash.addRedaction(secret)
    let artifactId = ''
    let artifactSize = 0
    try {
      // Turn 1: register_artifact via real harness.
      kernel.__faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall('register_artifact', { path: fileName }, { id: 'tc-art-reg' })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('registered'),
      ])
      await kernel.conversations.submitInput(1, 'register report artifact')
      await kernel.conversations.waitForIdle(1)

      const artifacts = await kernel.services.artifacts.list(1)
      assert.equal(artifacts.length, 1)
      artifactId = artifacts[0]!.id
      artifactSize = artifacts[0]!.size
      assert.ok(artifactSize > 4096, `expected multi-page artifact (>4096 bytes), got ${artifactSize}`)

      // Turn 2: read_artifact intermediate page, final page, EOF page, and missing-artifact error.
      kernel.__faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall('read_artifact', { id: artifactId, offset: 0, limit: 4096 }, { id: 'tc-art-read-p1' }),
            fauxToolCall('read_artifact', { id: artifactId, offset: 4096, limit: 4096 }, { id: 'tc-art-read-last' }),
            fauxToolCall('read_artifact', { id: artifactId, offset: artifactSize }, { id: 'tc-art-read-eof' }),
            fauxToolCall('read_artifact', { id: 'no-such-artifact-id' }, { id: 'tc-art-read-err' }),
          ],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('read complete'),
      ])
      await kernel.conversations.submitInput(1, 'read report artifact pages')
      await kernel.conversations.waitForIdle(1)

      const assertPersisted = async (rt: Awaited<ReturnType<typeof openRuntime>>) => {
        const detail = await rt.conversations.getConversationDetail(1, { limit: 100 })
        const byCallId = new Map<
          string,
          { isError?: boolean; details?: unknown; content?: Array<{ type?: string; text?: string }> }
        >()
        for (const entry of detail.entries) {
          if (entry.kind !== 'pi.tool-result') continue
          const msg = (entry.model as Array<Record<string, unknown>> | undefined)?.[0]
          if (typeof msg?.['toolCallId'] === 'string') {
            byCallId.set(msg['toolCallId'], msg as { isError?: boolean; details?: unknown; content?: Array<{ type?: string; text?: string }> })
          }
        }

        // 1. register_artifact persisted details: matches schema, secret redacted, no structuredOutput on entry.
        const reg = byCallId.get('tc-art-reg')!
        assert.equal(reg.isError, false)
        assert.equal('structuredOutput' in reg, false)
        const regDetails = assertBoundedPresentationMeta(reg.details, { schema: ARTIFACT_REGISTER_META_SCHEMA })
        assert.equal(regDetails['artifactId'], artifactId)
        assert.equal(regDetails['nodeId'], 'local')
        assert.equal(regDetails['size'], artifactSize)
        assert.equal(regDetails['mimeType'], 'text/plain')
        assert.ok(String(regDetails['name']).includes('[REDACTED]'))
        assert.ok(!JSON.stringify(regDetails).includes(secret))

        // 2. read_artifact intermediate page: matches schema, carries nextOffset & bytes, never duplicates chunk body.
        const p1 = byCallId.get('tc-art-read-p1')!
        assert.equal(p1.isError, false)
        assert.equal('structuredOutput' in p1, false)
        const p1Details = assertBoundedPresentationMeta(p1.details, { schema: ARTIFACT_READ_META_SCHEMA })
        assert.equal(p1Details['id'], artifactId)
        assert.equal(p1Details['offset'], 0)
        assert.equal(p1Details['nextOffset'], 4096)
        assert.equal(p1Details['bytes'], 4096)
        assert.equal('chunk' in p1Details, false)
        assert.ok(!JSON.stringify(p1Details).includes('BODY_CHUNK_SENTINEL'))

        // 3. read_artifact final page: matches schema, omits nextOffset, never duplicates chunk body.
        const last = byCallId.get('tc-art-read-last')!
        assert.equal(last.isError, false)
        assert.equal('structuredOutput' in last, false)
        const lastDetails = assertBoundedPresentationMeta(last.details, { schema: ARTIFACT_READ_META_SCHEMA })
        assert.equal(lastDetails['id'], artifactId)
        assert.equal(lastDetails['offset'], 4096)
        assert.equal(lastDetails['bytes'], artifactSize - 4096)
        assert.equal('nextOffset' in lastDetails, false)
        assert.equal('chunk' in lastDetails, false)
        assert.ok(!JSON.stringify(lastDetails).includes('BODY_CHUNK_SENTINEL'))

        // 4. read_artifact EOF page: bytes = 0, no nextOffset, no chunk.
        const eof = byCallId.get('tc-art-read-eof')!
        assert.equal(eof.isError, false)
        const eofDetails = assertBoundedPresentationMeta(eof.details, { schema: ARTIFACT_READ_META_SCHEMA })
        assert.deepEqual(eofDetails, { id: artifactId, offset: artifactSize, bytes: 0 })

        // 5. Error call: explicit isError and NO persisted details.
        const errRec = byCallId.get('tc-art-read-err')!
        assert.equal(errRec.isError, true, 'tc-art-read-err should be persisted as error')
        assert.equal(errRec.details, undefined, 'tc-art-read-err must not persist invalid details')
      }

      await assertPersisted(kernel)
    } finally {
      disposeSecret()
      await kernel.close()
    }

    // Reopen fresh KernelRuntime on the same dataDir to verify persisted details survive SQLite restart.
    const reopened = await openRuntime(dir)
    try {
      const detail = await reopened.conversations.getConversationDetail(1, { limit: 100 })
      const byCallId = new Map<string, { isError?: boolean; details?: unknown }>()
      for (const entry of detail.entries) {
        if (entry.kind !== 'pi.tool-result') continue
        const msg = (entry.model as Array<Record<string, unknown>> | undefined)?.[0]
        if (typeof msg?.['toolCallId'] === 'string') {
          byCallId.set(msg['toolCallId'], msg as { isError?: boolean; details?: unknown })
        }
      }
      const regAfter = assertBoundedPresentationMeta(byCallId.get('tc-art-reg')!.details, { schema: ARTIFACT_REGISTER_META_SCHEMA })
      assert.equal(regAfter['artifactId'], artifactId)
      const p1After = assertBoundedPresentationMeta(byCallId.get('tc-art-read-p1')!.details, { schema: ARTIFACT_READ_META_SCHEMA })
      assert.deepEqual(p1After, { id: artifactId, offset: 0, nextOffset: 4096, bytes: 4096 })
      const eofAfter = assertBoundedPresentationMeta(byCallId.get('tc-art-read-eof')!.details, { schema: ARTIFACT_READ_META_SCHEMA })
      assert.deepEqual(eofAfter, { id: artifactId, offset: artifactSize, bytes: 0 })
    } finally {
      await reopened.close()
    }
  })

  it('run in abortConversation kill bash tool shell(do not etc. 120s)', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'sdk2')
    const kernel = (await openRuntime(dir)) as never as {
      __faux: FauxHandle
      close(): Promise<void>
      conversations: {
        submitInput(id: number, text: string): Promise<unknown>
        waitForIdle(id: number): Promise<void>
        abortConversation(id: number): Promise<void>
        getConversation(id: number): { status: string }
      }
    }
    try {
      kernel.__faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall('bash', { command: `sleep 120` })],
          { stopReason: 'toolUse' },
        ),
      ])
      const started = Date.now()
      void kernel.conversations.submitInput(1, 'run long command').catch(() => {})
      await new Promise((r) => setTimeout(r, 400))
      await kernel.conversations.abortConversation(1)
      await kernel.conversations.waitForIdle(1).catch(() => {})
      const elapsed = Date.now() - started
      assert.ok(elapsed < 30_000, `abort should interrupt tool while non- etc. full timeout (${elapsed}ms)`)
      const conv = kernel.conversations.getConversation(1)
      assert.ok(['idle', 'error'].includes(conv.status))
    } finally {
      await kernel.close()
    }
  })
})

describe('closure stop abort state:spill protect and replay mark record', { timeout: 60_000 }, () => {
  it('createBashTool in run in by abort when throw abort exception and do not write spill artifact', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'abort-bash')
    const baseDeps = await makeRealDeps(dir)
    let spillCalled = 0
    const deps: HelmxToolDeps = {
      ...baseDeps,
      artifacts: {
        ...baseDeps.artifacts,
        spill: async (...args) => {
          spillCalled += 1
          return baseDeps.artifacts.spill(...args)
        },
      },
    }
    const tool = createBashTool(deps)
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(new Error('kernel closing')), 150)
    try {
      await assert.rejects(
        () =>
          (tool.execute as unknown as (a: unknown, api: unknown, ctx: unknown) => Promise<unknown>)(
            { command: 'sleep 30' },
            makeApi(dir),
            { abortSignal: ac.signal },
          ),
        (err: unknown) => err instanceof Error && err.message === 'kernel closing',
      )
      assert.equal(spillCalled, 0, 'abort after must not write without intent meaning spill file')
    } finally {
      clearTimeout(timer)
    }
  })

  it('createReadTool in read during or already abort when throw abort exception and do not invoke spill; only read tool explicit declaration replay: safe', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'abort-read')
    const baseDeps = await makeRealDeps(dir)
    writeFileSync(join(dir, 'sample.txt'), 'hello abort world\n', 'utf8')
    let spillCalled = 0
    const deps: HelmxToolDeps = {
      ...baseDeps,
      artifacts: {
        ...baseDeps.artifacts,
        spill: async (...args) => {
          spillCalled += 1
          return baseDeps.artifacts.spill(...args)
        },
      },
    }
    const readTool = createReadTool(deps)
    const readArtifactTool = createReadArtifactTool(deps, () => true)
    assert.equal(readTool.replay, 'safe')
    assert.equal(readArtifactTool.replay, 'safe')

    const ac = new AbortController()
    const abortReason = new Error('close during read')
    const baseApi = makeApi(dir) as unknown as Record<string, unknown>
    const api = {
      ...baseApi,
      agent: async () => {
        ac.abort(abortReason)
        return { cwd: dir }
      },
    }
    await assert.rejects(
      () =>
        (readTool.execute as unknown as (a: unknown, api: unknown, ctx: unknown) => Promise<unknown>)(
          { path: 'sample.txt' },
          api,
          { abortSignal: ac.signal },
        ),
      (err: unknown) => err === abortReason,
    )
    assert.equal(spillCalled, 0, 'read in abort state must not write spill file')
  })
})

/** most small real ToolExecutionApi:conversationId / callId / agent(cwd) all by SDK contract provide. */
function makeApi(cwd: string, conversationId = 1) {
  return {
    taskId: 'test-task',
    conversationId,
    callId: 'call-test-1',
    registry: { tools: [] },
    agent: async () => ({ cwd }),
    models: {},
    env: undefined,
    now: () => Date.now(),
    output: () => {},
    outputWindow: undefined,
    retainedOutput: () => ({ text: '', truncated: false }),
    diagnostic: () => {},
    details: async () => {},
    commit: async (change: () => unknown) => change(),
    memo: async () => undefined,
    createTask: async () => {
      throw new Error('test does not use')
    },
    getTask: async () => undefined,
    waitForTask: async () => {
      throw new Error('test does not use')
    },
    conversation: async () => undefined,
    executeTool: async () => {
      throw new Error('test does not use')
    },
  } as never
}

function existsSyncSafe(path: string): boolean {
  return existsSync(path)
}

describe('Profile.restrictToCwd guardrail: file tools confined to the conversation cwd', { timeout: 60_000 }, () => {
  async function makeRestrictedDeps(dir: string): Promise<HelmxToolDeps> {
    const deps = await makeRealDeps(dir)
    return { ...deps, restrictToCwdOf: async () => true }
  }

  it('read rejects ../ traversal and outside absolute paths, allows inside paths', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'rc1')
    mkdirSync(join(dir, 'inner'), { recursive: true })
    const outer = join(rootDir, 'rc1-outer')
    mkdirSync(outer, { recursive: true })
    writeFileSync(join(outer, 'secret.txt'), 'outside')
    writeFileSync(join(dir, 'inner', 'note.md'), 'inside')
    const deps = await makeRestrictedDeps(join(dir, 'inner'))
    const tool = createReadTool(deps)
    for (const p of ['../secret.txt', '@../secret.txt', join(outer, 'secret.txt'), '/etc/hostname']) {
      const result = await tool.execute({ path: p }, makeApi(join(dir, 'inner')), BACKGROUND_CONTEXT)
      assert.equal(result.isError, true, `path ${p} should be rejected under restrictToCwd`)
      const text = (result.output as Array<{ type: string; text: string }>)[0]!.text
      assert.ok(text.includes('path_outside_workspace'), `error should name path_outside_workspace for ${p}`)
    }
    const ok = await tool.execute({ path: 'note.md' }, makeApi(join(dir, 'inner')), BACKGROUND_CONTEXT)
    assert.equal(!!ok.isError, false, 'inside path should read normally')
  })

  it('write and edit reject outside targets before any IO (no file or parent dir created)', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'rc2')
    mkdirSync(dir, { recursive: true })
    const deps = await makeRestrictedDeps(dir)
    const outside = join(rootDir, 'rc2-escape-deep.txt')

    const writeTool = createWriteTool(deps)
    const writeResult = await writeTool.execute(
      { path: '../rc2-escape-deep.txt', content: 'x' },
      makeApi(dir),
      BACKGROUND_CONTEXT,
    )
    assert.equal(writeResult.isError, true)
    assert.ok(
      (writeResult.output as Array<{ type: string; text: string }>)[0]!.text.includes('path_outside_workspace'),
    )
    assert.equal(existsSync(outside), false, 'guardrail must reject before creating anything outside cwd')

    const editTool = createEditTool(deps)
    const editResult = await editTool.execute(
      { path: outside, oldText: 'a', newText: 'b' },
      makeApi(dir),
      BACKGROUND_CONTEXT,
    )
    assert.equal(editResult.isError, true)
    assert.ok(
      (editResult.output as Array<{ type: string; text: string }>)[0]!.text.includes('path_outside_workspace'),
    )
  })

  it('write and edit still work inside cwd under restriction', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'rc3')
    mkdirSync(dir, { recursive: true })
    const deps = await makeRestrictedDeps(dir)
    const writeTool = createWriteTool(deps)
    const written = await writeTool.execute({ path: 'file.txt', content: 'v1' }, makeApi(dir), BACKGROUND_CONTEXT)
    assert.equal(!!written.isError, false)
    const editTool = createEditTool(deps)
    const edited = await editTool.execute(
      { path: 'file.txt', oldText: 'v1', newText: 'v2' },
      makeApi(dir),
      BACKGROUND_CONTEXT,
    )
    assert.equal(!!edited.isError, false)
    assert.equal(readFileSync(join(dir, 'file.txt'), 'utf8'), 'v2')
  })

  it('register_artifact rejects outside sources, registers inside ones', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'rc4')
    mkdirSync(join(dir, 'sub'), { recursive: true })
    const outer = join(rootDir, 'rc4-outer')
    mkdirSync(outer, { recursive: true })
    writeFileSync(join(outer, 'outside.bin'), 'outside-bytes')
    writeFileSync(join(dir, 'sub', 'inside.txt'), 'inside-bytes')
    const deps = await makeRestrictedDeps(join(dir, 'sub'))
    const tool = createRegisterArtifactTool(deps)
    const rejected = await tool.execute(
      { path: '../../rc4-outer/outside.bin' },
      makeApi(join(dir, 'sub')),
      BACKGROUND_CONTEXT,
    )
    assert.equal(rejected.isError, true)
    assert.ok(
      (rejected.output as Array<{ type: string; text: string }>)[0]!.text.includes('path_outside_workspace'),
    )
    const registered = await tool.execute({ path: 'inside.txt' }, makeApi(join(dir, 'sub')), BACKGROUND_CONTEXT)
    assert.equal(!!registered.isError, false)
  })

  it('guardrail off (false) keeps the unrestricted boundary (../ reads still allowed)', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'rc5')
    mkdirSync(join(dir, 'inner'), { recursive: true })
    writeFileSync(join(dir, 'secret.txt'), 'outside')
    const deps = await makeRealDeps(join(dir, 'inner'))
    const scoped = { ...deps, restrictToCwdOf: async () => false }
    const tool = createReadTool(scoped)
    const result = await tool.execute({ path: '../secret.txt' }, makeApi(join(dir, 'inner')), BACKGROUND_CONTEXT)
    assert.equal(!!result.isError, false, 'restrictToCwd=false must keep the unrestricted boundary')
  })
})
