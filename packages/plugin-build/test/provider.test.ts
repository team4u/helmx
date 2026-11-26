/**
 * @helmx/plugin-build port tests:
 * - minimal real-behavior verification of both tracks of createPluginBuildProvider
 *   (compileClientModule / transformBackendTs) (the full compilation chain is covered by
 *   plugin-client-css.test.ts and the kernel integration tests);
 * - transformBackendTs: ts / tsx transform to ESM, JSX automatic runtime imports, syntax errors re-thrown
 *   verbatim with locations (diagnostics are never swallowed, no silent degradation);
 * - compileClientModule: compiles a real module through the port (a cache hit yields the same hash).
 */
import assert from 'node:assert/strict'
import { test, beforeEach, afterEach } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearClientCompilerMemoryCache,
  compilePluginClientModule,
  createPluginBuildProvider,
  safeDirName,
  safeFileName,
  transformBackendTs,
} from '../src/index.js'
import { assertModuleRefShape, clientNpmRootsOf } from '@helmx/protocol'
import { HelmxError } from '@helmx/protocol'

let workDir: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'helmx-plugin-build-'))
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

test('transformBackendTs: transforms ts source to ESM, preserving import/export semantics', { timeout: 60_000 }, () => {
  const code = transformBackendTs({
    source: 'export const x: number = 1;\nimport { join } from "node:path";\nexport { join };',
    file: join(workDir, 'a.ts'),
    kind: 'ts',
  })
  assert.match(code, /\bx\s*=\s*1/)
  assert.match(code, /node:path/)
})

test('transformBackendTs: tsx uses JSX automatic (the output imports react/jsx-runtime, no inlined React)', { timeout: 60_000 }, () => {
  const code = transformBackendTs({
    source: 'export const El = () => <div>hi</div>;',
    file: join(workDir, 'b.tsx'),
    kind: 'tsx',
  })
  assert.match(code, /react\/jsx-runtime/)
  assert.match(code, /jsx/)
})

test('transformBackendTs: syntax errors are re-thrown verbatim with locations (diagnostics never silently swallowed)', { timeout: 60_000 }, () => {
  const file = join(workDir, 'bad.ts')
  assert.throws(
    () =>
      transformBackendTs({
        source: 'export const = ;',
        file,
        kind: 'ts',
      }),
    (err: unknown) => {
      const errors = (err as { errors?: Array<{ location?: { line: number; column: number } }> }).errors
      assert.ok(Array.isArray(errors) && errors.length > 0, 'esbuild diagnostics must be preserved')
      assert.ok(errors[0]!.location, 'diagnostics must carry a line/column location')
      return true
    },
  )
})

test('port: compileClientModule compiles a real module and hits the disk cache (same hash)', { timeout: 60_000 }, async () => {
  const clientRoot = join(workDir, 'client')
  mkdirSync(clientRoot, { recursive: true })
  writeFileSync(join(clientRoot, 'index.tsx'), 'export const v = 41;\n')

  const provider = createPluginBuildProvider()
  const first = await provider.compileClientModule({
    pluginId: 'test:port',
    clientRoot,
    moduleRef: 'index.tsx',
    cacheDir: workDir,
    npmRoots: [],
  })
  assert.ok(first.code.length > 0)
  assert.ok(first.contentHash.length > 0)
  assert.ok(first.exports.includes('v'))
  assert.ok(first.gzipped && first.gzipped.byteLength > 0, 'the artifact must carry gzip pre-compressed bytes')

  // a repeated request from the same source (new provider instance, exercising the disk-manifest
  // re-validation path) yields the same hash
  const second = await createPluginBuildProvider().compileClientModule({
    pluginId: 'test:port',
    clientRoot,
    moduleRef: 'index.tsx',
    cacheDir: workDir,
    npmRoots: [],
  })
  assert.equal(second.contentHash, first.contentHash)
  assert.equal(second.code, first.code)
})

test('port: compileClientModule rejects an illegal moduleRef (the same validation as the kernel registration boundary)', { timeout: 60_000 }, async () => {
  const clientRoot = join(workDir, 'client2')
  mkdirSync(clientRoot, { recursive: true })
  writeFileSync(join(clientRoot, 'index.tsx'), 'export const v = 1;\n')
  const provider = createPluginBuildProvider()
  await assert.rejects(
    provider.compileClientModule({
      pluginId: 'test:port-shape',
      clientRoot,
      moduleRef: '../escape.tsx',
      cacheDir: workDir,
      npmRoots: [],
    }),
    (err: unknown) => err instanceof HelmxError && err.code === 'invalid_client_module',
  )
})

test('contract pure functions: assertModuleRefShape and clientNpmRootsOf shapes (protocol as the single source of truth)', { timeout: 60_000 }, () => {
  assert.throws(() => assertModuleRefShape('p', 'a/../b.tsx'), (err: unknown) => {
    assert.ok(err instanceof HelmxError)
    assert.equal((err as HelmxError).code, 'invalid_client_module')
    return true
  })
  assert.doesNotThrow(() => assertModuleRefShape('p', 'a/b.tsx'))

  const roots = clientNpmRootsOf({ 'chart.js': '/pkgs/a', 'date-fns': '/pkgs/a', react: '/pkgs/b' })
  assert.deepEqual(
    roots.map((r) => [r.packageRoot, [...r.specifiers].sort()]),
    [
      ['/pkgs/a', ['chart.js', 'date-fns']],
      ['/pkgs/b', ['react']],
    ],
  )
})

test('concurrent compilePluginClientModule calls safely share the cache directory with no leftover temp files', { timeout: 60_000 }, async () => {
  clearClientCompilerMemoryCache()
  const clientRoot = join(workDir, 'concurrent-client')
  const sharedCacheDir = join(workDir, 'shared-cache')
  mkdirSync(clientRoot, { recursive: true })
  writeFileSync(join(clientRoot, 'dep.ts'), 'export const label = "concurrent-ok";\n')
  writeFileSync(join(clientRoot, 'index.tsx'), 'import { label } from "./dep.js";\nexport const value = label;\n')

  const firstWave = await Promise.all([
    compilePluginClientModule('test:concurrent-a', clientRoot, 'index.tsx', sharedCacheDir),
    compilePluginClientModule('test:concurrent-a', clientRoot, 'index.tsx', sharedCacheDir),
    compilePluginClientModule('test:concurrent-a', clientRoot, 'index.tsx', sharedCacheDir),
    compilePluginClientModule('test:concurrent-b', clientRoot, 'index.tsx', sharedCacheDir),
  ])

  for (const res of firstWave) {
    assert.ok(res.code.includes('concurrent-ok'))
    assert.ok(res.exports.includes('value'))
    assert.equal(res.contentHash, firstWave[0]!.contentHash)
  }
  assert.equal(firstWave[1]!.code, firstWave[0]!.code)
  assert.equal(firstWave[2]!.code, firstWave[0]!.code)

  const baseName = safeFileName('index.tsx')
  for (const pluginId of ['test:concurrent-a', 'test:concurrent-b']) {
    const stagingDir = join(sharedCacheDir, 'plugin-staging', safeDirName(pluginId))
    const files = readdirSync(stagingDir)
    assert.ok(!files.some((f) => f.includes('.tmp-')), `no temp files may be left behind: ${files.join(', ')}`)
    assert.ok(existsSync(join(stagingDir, `${baseName}.deps.json`)), `${pluginId} should have a deps.json`)
    const manifest = JSON.parse(readFileSync(join(stagingDir, `${baseName}.deps.json`), 'utf8')) as {
      contentHash: string
    }
    assert.equal(manifest.contentHash, firstWave[0]!.contentHash)
    assert.ok(existsSync(join(stagingDir, `${baseName}.${manifest.contentHash}.mjs`)))
  }

  // clear the in-memory cache and call concurrently again, verifying safe disk-cache reuse across
  // instances and under concurrency
  clearClientCompilerMemoryCache()
  const secondWave = await Promise.all([
    compilePluginClientModule('test:concurrent-a', clientRoot, 'index.tsx', sharedCacheDir),
    compilePluginClientModule('test:concurrent-a', clientRoot, 'index.tsx', sharedCacheDir),
    compilePluginClientModule('test:concurrent-b', clientRoot, 'index.tsx', sharedCacheDir),
  ])
  for (const res of secondWave) {
    assert.equal(res.contentHash, firstWave[0]!.contentHash)
    assert.equal(res.code, firstWave[0]!.code)
  }
  clearClientCompilerMemoryCache()
})

test('client-cache: recordMemoryCache skips on missing stat, readCachedResult validates containment, lazy chunk fails if deleted, and superseded bundles are pruned', { timeout: 60_000 }, async () => {
  const {
    DEPS_LIST_VERSION,
    lookupMemoryCache,
    readCachedResult,
    recordMemoryCache,
  } = await import('../src/client-cache.js')

  clearClientCompilerMemoryCache()
  const clientRoot = join(workDir, 'cache-hardening')
  const cacheDir = join(workDir, 'cache-store')
  mkdirSync(clientRoot, { recursive: true })
  writeFileSync(join(clientRoot, 'lazy.ts'), 'export const ans = 1;\n')
  writeFileSync(join(clientRoot, 'index.tsx'), 'export const load = async () => (await import("./lazy.js")).ans;\n')

  // 1. Missing dep file during recordMemoryCache must NOT insert into memory cache (no permanent stale hit).
  const first = await compilePluginClientModule('test:mem-skip', clientRoot, 'index.tsx', cacheDir)
  const missingList = {
    version: DEPS_LIST_VERSION as 9,
    module: 'index.tsx',
    root: clientRoot,
    contentHash: first.contentHash,
    dependencies: [{ path: 'missing-dep.ts', sha256: 'abc' }],
  }
  recordMemoryCache('missing-mem-key', clientRoot, missingList, first)
  assert.equal(lookupMemoryCache('missing-mem-key', clientRoot), undefined, 'failed statSync must skip storing into memory cache')

  // 2. readCachedResult rejects path traversal in dep.path, contentHash, and chunkName.
  const stagingDir = join(cacheDir, 'plugin-staging', safeDirName('test:mem-skip'))
  const baseName = safeFileName('index.tsx')
  const depsPath = join(stagingDir, `${baseName}.deps.json`)
  const validManifest = JSON.parse(readFileSync(depsPath, 'utf8')) as Record<string, unknown>
  writeFileSync(depsPath, JSON.stringify({ ...validManifest, contentHash: '../evil' }))
  assert.equal(readCachedResult(stagingDir, depsPath, clientRoot, 'index.tsx', []), undefined)

  writeFileSync(depsPath, JSON.stringify({ ...validManifest, dependencies: [{ path: '../outside.ts', sha256: '00' }] }))
  assert.equal(readCachedResult(stagingDir, depsPath, clientRoot, 'index.tsx', []), undefined)

  writeFileSync(depsPath, JSON.stringify({ ...validManifest, chunks: ['../evil.js'] }))
  assert.equal(readCachedResult(stagingDir, depsPath, clientRoot, 'index.tsx', []), undefined)

  // Restore valid manifest, then delete the chunk file after readCachedResult returns lazy getters.
  writeFileSync(depsPath, JSON.stringify(validManifest))
  clearClientCompilerMemoryCache()
  const hit = readCachedResult(stagingDir, depsPath, clientRoot, 'index.tsx', [])
  assert.ok(hit !== undefined)
  const chunkName = Object.keys(hit.result.chunks ?? {})[0]!
  rmSync(join(stagingDir, `${baseName}.${first.contentHash}.chunk.${chunkName}`))
  assert.throws(
    () => hit.result.chunks![chunkName],
    (err: unknown) => err instanceof HelmxError && err.code === 'client_chunk_not_found',
  )

  // 3. Updating source prunes superseded bundle files from stagingDir.
  writeFileSync(join(clientRoot, 'index.tsx'), 'export const load = async () => (await import("./lazy.js")).ans + 1;\n')
  const second = await compilePluginClientModule('test:mem-skip', clientRoot, 'index.tsx', cacheDir)
  assert.notEqual(second.contentHash, first.contentHash)
  const remaining = readdirSync(stagingDir).filter((f) => f.startsWith(`${baseName}.`) && f.endsWith('.mjs'))
  assert.deepEqual(remaining, [`${baseName}.${second.contentHash}.mjs`], 'superseded .mjs bundle files must be pruned')

  // 4. memoryCompiledCache LRU bound evicts oldest entries beyond 128.
  clearClientCompilerMemoryCache()
  const lruFile = join(clientRoot, 'lru.ts')
  writeFileSync(lruFile, 'export const k = 1;\n')
  const lruList = {
    version: DEPS_LIST_VERSION as 9,
    module: 'lru.ts',
    root: clientRoot,
    contentHash: first.contentHash,
    dependencies: [{ path: 'lru.ts', sha256: 'abc' }],
  }
  for (let i = 0; i < 140; i += 1) {
    recordMemoryCache(`lru-key-${i}`, clientRoot, lruList, first)
  }
  assert.equal(lookupMemoryCache('lru-key-0', clientRoot), undefined, 'oldest entry must be evicted by LRU bound')
  assert.ok(lookupMemoryCache('lru-key-139', clientRoot) !== undefined, 'newest entry must remain cached')
  clearClientCompilerMemoryCache()
})
