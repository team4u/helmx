/**
 * Unit and tool-integration tests for `edit-engine.ts` and upgraded `createEditTool`:
 * - dual-form input (`oldText`/`newText` vs `edits[]`), mutual exclusivity, `prepareEditArguments` repair;
 * - BOM and per-line mixed `\r\n` / `\n` / `\r` separator preservation without collateral line rewrites;
 * - per-item exact-first matching with independent fuzzy fallback (trailing spaces, smart quotes, dashes, NBSP);
 * - `replaceAll: true` identifier-boundary isolation guard (`\p{ID_Continue}$`) and `allowEmbeddedMatch: true`;
 * - near-miss `(line, col)` + invisible Unicode diagnostics and multi-occurrence line/context diagnostics (all redacted);
 * - atomic multi-hunk `edits[]` end-to-end execution via `createEditTool` (conforms to `EDIT_TOOL_RESULT_SCHEMA`).
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { EDIT_TOOL_RESULT_SCHEMA, validateOrThrow, type EditToolResult } from '@helmx/protocol'
import { ArtifactService, InMemoryArtifactRepository, SecretStash, ensureDataDir } from '../src/services/index.js'
import { createEditTool } from '../src/runtime/tools.js'
import {
  applyEditOperations,
  extractEditOperations,
  prepareEditArguments,
} from '../src/runtime/tools/edit-engine.js'
import type { HelmxToolDeps } from '../src/runtime/tool-deps.js'
import type { EnvFabric } from '../src/env/index.js'
import { cleanupDir, makeTempDir } from './helpers.js'

let rootDir: string

before(async () => {
  rootDir = await makeTempDir('helmx-edit-engine-')
})

after(async () => {
  await cleanupDir(rootDir)
}, { timeout: 60_000 })

async function makeDepsWithArtifacts(
  dir: string,
  stash = new SecretStash(),
): Promise<{ deps: HelmxToolDeps; artifacts: ArtifactService }> {
  mkdirSync(dir, { recursive: true })
  await ensureDataDir(dir)
  const artifacts = new ArtifactService(dir, new InMemoryArtifactRepository(), stash)
  return {
    deps: {
      dataDir: dir,
      defaultCwd: dir,
      hubUrl: 'http://127.0.0.1:3202',
      redact: (text) => stash.redact(text),
      artifacts,
    },
    artifacts,
  }
}

async function makeDeps(dir: string, stash = new SecretStash()): Promise<HelmxToolDeps> {
  return (await makeDepsWithArtifacts(dir, stash)).deps
}

function makeApi(cwd: string, conversationId = 1) {
  return {
    taskId: 'test-task',
    conversationId,
    callId: 'call-edit-1',
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
      throw new Error('unused')
    },
    getTask: async () => undefined,
    waitForTask: async () => {
      throw new Error('unused')
    },
    conversation: async () => undefined,
    executeTool: async () => {
      throw new Error('unused')
    },
  } as never
}

describe('edit-engine: argument normalization & validation', { timeout: 60_000 }, () => {
  it('repairs stringified edits JSON and single-object edits while rejecting invalid or mixed shapes', { timeout: 60_000 }, () => {
    const fromJson = extractEditOperations({
      path: 'a.ts',
      edits: JSON.stringify([{ oldText: 'a', newText: 'b' }]),
    })
    assert.equal(fromJson.ok, true)
    if (fromJson.ok) {
      assert.deepEqual(fromJson.operations, [
        { oldText: 'a', newText: 'b', replaceAll: false, allowEmbeddedMatch: false },
      ])
    }

    const fromSingleObj = prepareEditArguments({
      path: 'a.ts',
      edits: { oldText: 'x', newText: 'y', replaceAll: true },
    }) as { edits?: unknown[] }
    assert.ok(Array.isArray(fromSingleObj.edits) && fromSingleObj.edits.length === 1)

    const mixed = extractEditOperations({
      path: 'a.ts',
      oldText: 'a',
      newText: 'b',
      edits: [{ oldText: 'c', newText: 'd' }],
    })
    assert.equal(mixed.ok, false)
    if (!mixed.ok) assert.ok(mixed.error.includes('not both'))

    const emptyEdits = extractEditOperations({ path: 'a.ts', edits: [] })
    assert.equal(emptyEdits.ok, false)

    const emptyOld = extractEditOperations({ path: 'a.ts', oldText: '', newText: 'x' })
    assert.equal(emptyOld.ok, false)
  })
})

describe('edit-engine: BOM, CRLF/mixed line endings, fuzzy fallback, and diagnostics', { timeout: 60_000 }, () => {
  it('preserves UTF-8 BOM and untouched lines mixed LF/CRLF/CR endings', { timeout: 60_000 }, () => {
    const raw = '\uFEFFfirst\r\nsecond\nthird\rfourth\r\n'
    const res = applyEditOperations(
      raw,
      [{ oldText: 'second', newText: 'SECOND_A\nSECOND_B', replaceAll: false, allowEmbeddedMatch: false }],
      '/repo/mixed.txt',
      (t) => t,
    )
    assert.equal(res.ok, true)
    if (res.ok) {
      assert.equal(res.updatedFileContent, '\uFEFFfirst\r\nSECOND_A\nSECOND_B\nthird\rfourth\r\n')
    }

    const crlfRaw = 'line1\r\nline2\r\nline3\r\n'
    const crlfRes = applyEditOperations(
      crlfRaw,
      [{ oldText: 'line1\nline2', newText: 'L1\nL2\nL2b', replaceAll: false, allowEmbeddedMatch: false }],
      '/repo/win.txt',
      (t) => t,
    )
    assert.equal(crlfRes.ok, true)
    if (crlfRes.ok) {
      assert.equal(crlfRes.updatedFileContent, 'L1\r\nL2\r\nL2b\r\nline3\r\n')
    }
  })

  it('per-item fuzzy fallback preserves untouched lines and exact-matched sibling edits', { timeout: 60_000 }, () => {
    const raw = 'const a = “hi”  \nconst b = 1\nconst c = 2  \n'
    const res = applyEditOperations(
      raw,
      [
        { oldText: 'const a = "hi"', newText: 'const a = "bye"', replaceAll: false, allowEmbeddedMatch: false },
        { oldText: 'const b = 1', newText: 'const b = 10', replaceAll: false, allowEmbeddedMatch: false },
      ],
      '/repo/fuzzy.ts',
      (t) => t,
    )
    assert.equal(res.ok, true)
    if (res.ok) {
      // Untouched line 3 keeps its original trailing spaces `  `!
      assert.equal(res.updatedFileContent, 'const a = "bye"\nconst b = 10\nconst c = 2  \n')
    }
  })

  it('replaceAll enforces identifier-boundary isolation unless allowEmbeddedMatch is true', { timeout: 60_000 }, () => {
    const raw = 'const x: Context = createContext()\nconst y: Context = defaultContext()\n'
    const blocked = applyEditOperations(
      raw,
      [{ oldText: 'Context', newText: 'AppContext', replaceAll: true, allowEmbeddedMatch: false }],
      '/repo/ctx.ts',
      (t) => t,
    )
    assert.equal(blocked.ok, false)
    if (!blocked.ok) {
      assert.ok(blocked.error.includes('embedded inside identifier'))
      assert.ok(blocked.error.includes('createContext'))
      assert.ok(blocked.error.includes('allowEmbeddedMatch: true'))
    }

    const allowed = applyEditOperations(
      raw,
      [{ oldText: 'Context', newText: 'AppContext', replaceAll: true, allowEmbeddedMatch: true }],
      '/repo/ctx.ts',
      (t) => t,
    )
    assert.equal(allowed.ok, true)
    if (allowed.ok) {
      assert.equal(allowed.totalReplacements, 4)
      assert.equal(
        allowed.updatedFileContent,
        'const x: AppContext = createAppContext()\nconst y: AppContext = defaultAppContext()\n',
      )
    }

    const standaloneOnly = 'function f(Context: number) {\n  return Context + 1\n}\n'
    const safeOk = applyEditOperations(
      standaloneOnly,
      [{ oldText: 'Context', newText: 'Ctx', replaceAll: true, allowEmbeddedMatch: false }],
      '/repo/safe.ts',
      (t) => t,
    )
    assert.equal(safeOk.ok, true)
    if (safeOk.ok) {
      assert.equal(safeOk.updatedFileContent, 'function f(Ctx: number) {\n  return Ctx + 1\n}\n')
    }
  })

  it('rejects overlapping edits in edits[] without modifying content', { timeout: 60_000 }, () => {
    const raw = 'alpha beta gamma\n'
    const res = applyEditOperations(
      raw,
      [
        { oldText: 'alpha beta', newText: 'A', replaceAll: false, allowEmbeddedMatch: false },
        { oldText: 'beta gamma', newText: 'B', replaceAll: false, allowEmbeddedMatch: false },
      ],
      '/repo/overlap.txt',
      (t) => t,
    )
    assert.equal(res.ok, false)
    if (!res.ok) assert.ok(res.error.includes('overlap'))
  })

  it('emits redacted line/col near-miss hints when not found and line context snippets when ambiguous', { timeout: 60_000 }, () => {
    const secret = 'tok-edit-diag-999'
    const redact = (t: string) => t.replaceAll(secret, '[REDACTED]')

    const withInvisible = `header\nconst key = "${secret}"\nconst\u200Bval = 42\n`
    const missing = applyEditOperations(
      withInvisible,
      [{ oldText: `const key = "${secret}"\nconstval = 42`, newText: 'x', replaceAll: false, allowEmbeddedMatch: false }],
      '/repo/inv.ts',
      redact,
    )
    assert.equal(missing.ok, false)
    if (!missing.ok) {
      assert.ok(missing.error.includes('Closest match near line 3'))
      assert.ok(missing.error.includes('zero-width character'))
      assert.ok(!missing.error.includes(secret), 'diagnostic must redact secret')
    }

    const dupContent = `head\n${secret} dupBlock()\nendA\nmid\n${secret} dupBlock()\nendB\n`
    const dup = applyEditOperations(
      dupContent,
      [{ oldText: `${secret} dupBlock()`, newText: 'x', replaceAll: false, allowEmbeddedMatch: false }],
      '/repo/dup.ts',
      redact,
    )
    assert.equal(dup.ok, false)
    if (!dup.ok) {
      assert.ok(dup.error.includes('appeared 2 times'))
      assert.ok(dup.error.includes('Match 1 (line 2)'))
      assert.ok(dup.error.includes('Match 2 (line 5)'))
      assert.ok(dup.error.includes('[REDACTED]'))
      assert.ok(!dup.error.includes(secret), 'duplicate diagnostic must redact secret')
    }
  })
})

describe('createEditTool: end-to-end atomic edits[], CRLF, and schema output', { timeout: 60_000 }, () => {
  it('applies batched multi-hunk edits[] atomically on CRLF file and produces schema-valid merged EditToolResult', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'batch-crlf')
    const deps = await makeDeps(dir)
    const lines = Array.from({ length: 40 }, (_, i) => `line-${i + 1}`)
    const file = join(dir, 'app.ts')
    writeFileSync(file, `\uFEFF${lines.join('\r\n')}\r\n`, 'utf8')

    const tool = createEditTool(deps)
    const res = await tool.execute(
      {
        path: 'app.ts',
        edits: JSON.stringify([
          { oldText: 'line-2\nline-3', newText: 'line-2-new\nline-2b-new\nline-3-new' },
          { oldText: 'line-35', newText: 'line-35-new' },
        ]),
      } as never,
      makeApi(dir),
      BACKGROUND_CONTEXT,
    )
    assert.equal(!!res.isError, false)
    const structured = res.structuredOutput as unknown as EditToolResult
    validateOrThrow(EDIT_TOOL_RESULT_SCHEMA, structured, 'invalid edit result')
    assert.deepEqual(res.details, structured)
    assert.equal(structured.diff.addedLines, 4)
    assert.equal(structured.diff.removedLines, 3)
    assert.equal(structured.diff.firstChangedLine, 2)
    // Verify second hunk newLine accounts for +1 added line from first hunk (35 -> 36)!
    const secondAdd = structured.diff.rows.find((r) => r.kind === 'add' && r.text === 'line-35-new')
    assert.ok(secondAdd && secondAdd.kind === 'add' && secondAdd.newLine === 36)

    const disk = readFileSync(file, 'utf8')
    assert.ok(disk.startsWith('\uFEFF'))
    assert.ok(!disk.replace(/\r\n/g, '').includes('\n'), 'all endings must stay CRLF')
    assert.ok(disk.includes('line-2b-new\r\n'))
    assert.ok(disk.includes('line-35-new\r\n'))
  })
})

describe('createEditTool: artifact registration, error boundaries, remote node, and deletion', { timeout: 60_000 }, () => {
  it('local edit with artifact: true preserves BOM/CRLF, registers artifact, and passes EDIT_TOOL_RESULT_SCHEMA', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'local-art-true')
    const { deps, artifacts } = await makeDepsWithArtifacts(dir)
    mkdirSync(join(dir, 'reports'), { recursive: true })
    const file = join(dir, 'reports', 'summary.md')
    writeFileSync(file, '\uFEFF# Title\r\nold line\r\nfooter\r\n', 'utf8')

    const tool = createEditTool(deps)
    const res = await tool.execute(
      {
        path: 'reports/summary.md',
        oldText: 'old line',
        newText: 'new line',
        artifact: true,
      },
      makeApi(dir, 11),
      BACKGROUND_CONTEXT,
    )
    assert.equal(!!res.isError, false)
    const structured = res.structuredOutput as unknown as EditToolResult
    validateOrThrow(EDIT_TOOL_RESULT_SCHEMA, structured, 'invalid edit result')
    assert.deepEqual(res.details, structured)
    assert.equal(structured.path, file)
    assert.equal(structured.nodeId, 'local')
    assert.ok(typeof structured.artifactId === 'string' && structured.artifactId.length > 0)

    const outputText = (res.output as Array<{ text: string }>)[0]!.text
    assert.equal(
      outputText,
      `edit_ok: ${file} (node local, replaced 1 occurrence)\n[Artifact] id=${structured.artifactId} name=summary.md`,
    )

    const disk = readFileSync(file, 'utf8')
    assert.equal(disk, '\uFEFF# Title\r\nnew line\r\nfooter\r\n')
    assert.ok(disk.startsWith('\uFEFF'))
    assert.ok(!disk.replace(/\r\n/g, '').includes('\n'), 'all endings must stay CRLF')

    const metas = await artifacts.list(11)
    assert.equal(metas.length, 1)
    assert.equal(metas[0]!.id, structured.artifactId)
    assert.equal(metas[0]!.name, 'summary.md')
    assert.equal(await artifacts.readContent(structured.artifactId!), disk)
  })

  it('local edit with artifact: false or omitted does not register artifact or emit artifactId', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'local-art-off')
    const { deps, artifacts } = await makeDepsWithArtifacts(dir)
    const file = join(dir, 'plain.txt')
    writeFileSync(file, 'alpha\nbeta\ngamma\n', 'utf8')
    const tool = createEditTool(deps)

    const resOmitted = await tool.execute(
      { path: 'plain.txt', oldText: 'alpha', newText: 'ALPHA' },
      makeApi(dir, 12),
      BACKGROUND_CONTEXT,
    )
    assert.equal(!!resOmitted.isError, false)
    const outOmitted = (resOmitted.output as Array<{ text: string }>)[0]!.text
    assert.doesNotMatch(outOmitted, /\[Artifact\]/)
    const structOmitted = resOmitted.structuredOutput as unknown as EditToolResult
    validateOrThrow(EDIT_TOOL_RESULT_SCHEMA, structOmitted, 'invalid edit result')
    assert.equal(structOmitted.artifactId, undefined)
    assert.equal(Object.hasOwn(structOmitted, 'artifactId'), false)
    assert.deepEqual(resOmitted.details, structOmitted)

    const resFalse = await tool.execute(
      { path: 'plain.txt', oldText: 'beta', newText: 'BETA', artifact: false },
      makeApi(dir, 12),
      BACKGROUND_CONTEXT,
    )
    assert.equal(!!resFalse.isError, false)
    const outFalse = (resFalse.output as Array<{ text: string }>)[0]!.text
    assert.doesNotMatch(outFalse, /\[Artifact\]/)
    const structFalse = resFalse.structuredOutput as unknown as EditToolResult
    validateOrThrow(EDIT_TOOL_RESULT_SCHEMA, structFalse, 'invalid edit result')
    assert.equal(structFalse.artifactId, undefined)
    assert.equal(Object.hasOwn(structFalse, 'artifactId'), false)
    assert.deepEqual(resFalse.details, structFalse)
    assert.equal((await artifacts.list(12)).length, 0)
  })

  it('edit with artifact: true fails before IO when deps.artifacts.writeUploaded is undefined', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'no-write-uploaded')
    mkdirSync(dir, { recursive: true })
    await ensureDataDir(dir)
    const stash = new SecretStash()
    const file = join(dir, 'untouched.txt')
    writeFileSync(file, 'keep-me\n', 'utf8')
    const deps: HelmxToolDeps = {
      dataDir: dir,
      defaultCwd: dir,
      hubUrl: 'http://127.0.0.1:3202',
      redact: (t) => stash.redact(t),
      artifacts: {
        spill: async () => ({ text: '' }),
        get: async () => {
          throw new Error('not implemented')
        },
        readContent: async () => '',
        readBuffer: async () => Buffer.alloc(0),
        writeUploaded: undefined,
      },
    }
    const tool = createEditTool(deps)
    const res = await tool.execute(
      { path: 'untouched.txt', oldText: 'keep-me', newText: 'changed', artifact: true },
      makeApi(dir, 13),
      BACKGROUND_CONTEXT,
    )
    assert.equal(res.isError, true)
    assert.equal(
      (res.output as Array<{ text: string }>)[0]!.text,
      'edit_failed: artifact service does not support writeUploaded; cannot register conversation artifact',
    )
    assert.equal(readFileSync(file, 'utf8'), 'keep-me\n')
  })

  it('edit with artifact: true redacts secret and reports disk update when writeUploaded throws', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'art-throw')
    const stash = new SecretStash()
    const secret = 'sk-edit-art-err-secret-777'
    stash.addRedaction(secret)
    const baseDeps = await makeDeps(dir, stash)
    const file = join(dir, 'partial.txt')
    writeFileSync(file, 'before\n', 'utf8')
    const deps: HelmxToolDeps = {
      ...baseDeps,
      artifacts: {
        ...baseDeps.artifacts,
        writeUploaded: async () => {
          throw new Error(`artifact store failure: ${secret}`)
        },
      },
    }
    const tool = createEditTool(deps)
    const res = await tool.execute(
      { path: 'partial.txt', oldText: 'before', newText: 'after', artifact: true },
      makeApi(dir, 14),
      BACKGROUND_CONTEXT,
    )
    assert.equal(res.isError, true)
    const outputText = (res.output as Array<{ text: string }>)[0]!.text
    assert.ok(outputText.includes(`edit_failed: file was updated at ${file}, but artifact registration failed:`))
    assert.ok(outputText.includes('[REDACTED]'))
    assert.ok(!outputText.includes(secret), 'thrown error must be redacted')
    assert.equal(readFileSync(file, 'utf8'), 'after\n')
  })

  it('remote node edit with artifact: true updates remote file and registers conversation artifact', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'remote-art-true')
    const stash = new SecretStash()
    const { deps: baseDeps, artifacts } = await makeDepsWithArtifacts(dir, stash)
    const remoteAbs = '/remote/workspace/sub/remote.txt'
    const remoteFiles = new Map<string, string>([[remoteAbs, 'remote-old\n']])
    const stubEnv = {
      id: 'remote:worker-node-1',
      async absolutePath(p: string) {
        return { ok: true as const, value: p }
      },
      async joinPath(parts: string[]) {
        return { ok: true as const, value: parts.join('/') }
      },
      async canonicalPath(p: string) {
        return { ok: true as const, value: p }
      },
      async readTextFile(p: string) {
        const content = remoteFiles.get(p)
        if (content === undefined) {
          return { ok: false as const, error: { code: 'not_found', message: `missing: ${p}` } }
        }
        return { ok: true as const, value: content }
      },
      async writeFile(p: string, content: string) {
        remoteFiles.set(p, content)
        return { ok: true as const, value: void 0 }
      },
    }
    const stubFabric: EnvFabric = {
      registry: {} as never,
      envFor: () => stubEnv as never,
      envForTarget: () => {
        throw new Error('not used')
      },
      isOnline: () => true,
      waitForOnline: () => Promise.resolve(true),
      getNodeHubUrl: () => 'http://10.0.0.5:3202',
      evictConversation: () => undefined,
      debugBaseCount: () => 0,
      debugBases: () => [],
      dispose: () => Promise.resolve(),
    } as never

    const deps: HelmxToolDeps = {
      ...baseDeps,
      defaultCwd: '/remote/workspace',
      envFabric: stubFabric,
      nodeIdOf: () => 'worker-node-1',
    }
    const tool = createEditTool(deps)
    const res = await tool.execute(
      { path: 'sub/remote.txt', oldText: 'remote-old', newText: 'remote-new', artifact: true },
      makeApi('/remote/workspace', 15),
      BACKGROUND_CONTEXT,
    )
    assert.equal(!!res.isError, false)
    assert.equal(remoteFiles.get(remoteAbs), 'remote-new\n')

    const structured = res.structuredOutput as unknown as EditToolResult
    validateOrThrow(EDIT_TOOL_RESULT_SCHEMA, structured, 'invalid remote edit result')
    assert.deepEqual(res.details, structured)
    assert.equal(structured.path, remoteAbs)
    assert.equal(structured.nodeId, 'worker-node-1')
    assert.ok(typeof structured.artifactId === 'string' && structured.artifactId.length > 0)

    const outputText = (res.output as Array<{ text: string }>)[0]!.text
    assert.equal(
      outputText,
      `edit_ok: ${remoteAbs} (node worker-node-1, replaced 1 occurrence)\n[Artifact] id=${structured.artifactId} name=remote.txt`,
    )
    const metas = await artifacts.list(15)
    assert.equal(metas.length, 1)
    assert.equal(metas[0]!.id, structured.artifactId)
    assert.equal(metas[0]!.name, 'remote.txt')
    assert.equal(await artifacts.readContent(structured.artifactId!), 'remote-new\n')
  })

  it('deletes matched text cleanly when newText is empty string and produces schema-valid diff', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'delete-empty-new')
    const deps = await makeDeps(dir)
    const file = join(dir, 'delete.txt')
    writeFileSync(file, 'keep-top\nremove-this\nkeep-bottom\n', 'utf8')

    const tool = createEditTool(deps)
    const res = await tool.execute(
      { path: 'delete.txt', oldText: 'remove-this\n', newText: '' },
      makeApi(dir, 16),
      BACKGROUND_CONTEXT,
    )
    assert.equal(!!res.isError, false)
    assert.equal(readFileSync(file, 'utf8'), 'keep-top\nkeep-bottom\n')
    const structured = res.structuredOutput as unknown as EditToolResult
    validateOrThrow(EDIT_TOOL_RESULT_SCHEMA, structured, 'invalid deletion edit result')
    assert.deepEqual(res.details, structured)
    assert.equal(structured.diff.removedLines, 1)
    assert.equal(structured.diff.addedLines, 0)
    assert.ok(structured.diff.rows.some((r) => r.kind === 'remove' && r.text === 'remove-this'))
  })
})
