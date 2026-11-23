/**
 * Incremental build pipeline tests for:
 * 1. packages/plugins/scripts/copy-plugin-clients.mjs (per-plugin SHA-256 fingerprint caching,
 *    selective per-plugin rebuild on source/dist edits, invalidation on missing/tampered/stray
 *    dist-client outputs, mermaid-style source-mode npmDependencies recovery on cache miss, and
 *    HELMX_CLEAN_DIST=1 / --force bypass);
 * 2. scripts/lib/prune-dist.mjs (preserving dist/<name>/dist-client/** while src/<name>/client
 *    exists, pruning deleted plugins, keeping keptJsCount strict to TS outputs, and full wipe on
 *    --force / HELMX_CLEAN_DIST=1);
 * 3. packages/web/scripts/build-web.mjs (deterministic input-fingerprint skip, invalidation on
 *    src/public/workspace-input changes, invalidation on missing index.html or referenced/recorded
 *    dist assets, and HELMX_CLEAN_DIST=1 / --force bypass).
 *
 * Runner: node:test; every test sets an explicit timeout: 60_000.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildPluginClientBundleDir } from '@helmx/plugin-build'
import {
  PREBUILT_CLIENT_DIR_NAME,
  PREBUILT_CLIENT_MANIFEST_FILE,
  prebuiltChunkFileName,
  type BuildPluginClientBundleDirOptions,
  type BuildPluginClientBundleDirResult,
  type PrebuiltClientManifest,
} from '@helmx/protocol'
import { useTempDir } from '@helmx/test-kit/node'
import { pruneDist } from '../../../scripts/lib/prune-dist.mjs'

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(pkgRoot, '../..')

interface CopyPluginClientsResult {
  copied: number
  totalPlugins: number
  rebuilt: string[]
  cached: string[]
  totalModules: number
  totalBytes: number
}

interface CopyPluginClientsModule {
  copyAndPrebuildPluginClients: (options?: {
    pkgRoot?: string
    repoRoot?: string
    cacheFile?: string
    env?: NodeJS.ProcessEnv
    argv?: string[]
    force?: boolean
    quiet?: boolean
    pluginsModule?: Record<string, unknown>
    buildBundle?: (options: BuildPluginClientBundleDirOptions) => Promise<BuildPluginClientBundleDirResult>
  }) => Promise<CopyPluginClientsResult>
}

interface BuildWebResult {
  status: 'cached' | 'built'
  fingerprint: string
  outputCount: number
}

interface BuildWebModule {
  extractIndexAssetPaths: (indexHtml: string) => string[]
  runWebBuild: (options?: {
    pkgRoot?: string
    repoRoot?: string
    distDir?: string
    cacheFile?: string
    env?: NodeJS.ProcessEnv
    argv?: string[]
    force?: boolean
    quiet?: boolean
    runVite?: () => Promise<void>
  }) => Promise<BuildWebResult>
}

const copyClientsModPromise = import(
  pathToFileURL(path.join(pkgRoot, 'scripts', 'copy-plugin-clients.mjs')).href
) as Promise<CopyPluginClientsModule>

const buildWebModPromise = import(
  pathToFileURL(path.join(repoRoot, 'packages', 'web', 'scripts', 'build-web.mjs')).href
) as Promise<BuildWebModule>

function writeFixtureFile(root: string, rel: string, content: string): string {
  const abs = path.join(root, rel)
  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, content, 'utf8')
  return abs
}

function readManifest(outDir: string): PrebuiltClientManifest {
  return JSON.parse(readFileSync(path.join(outDir, PREBUILT_CLIENT_MANIFEST_FILE), 'utf8')) as PrebuiltClientManifest
}

interface PluginsFixture {
  root: string
  pluginsRoot: string
  distDir: string
  cacheFile: string
  pluginsModule: Record<string, unknown>
}

/** Creates an isolated workspace fixture with two real TSX UI plugins (`alpha`, `beta`) + optional dynamic chunk. */
function createPluginsFixture(root: string, options: { withChunkInAlpha?: boolean } = {}): PluginsFixture {
  const pluginsRoot = path.join(root, 'packages/plugins')
  const distDir = path.join(pluginsRoot, 'dist')
  const cacheFile = path.join(root, 'node_modules/.cache/helmx-build/plugin-clients-fingerprint.json')

  writeFixtureFile(root, 'pnpm-lock.yaml', 'lockfileVersion: 9.0\n')
  writeFixtureFile(root, 'packages/plugin-build/dist/index.js', 'export const version = 1;\n')
  writeFixtureFile(root, 'packages/protocol/dist/index.js', 'export const protocolVersion = 1;\n')
  writeFixtureFile(pluginsRoot, 'package.json', JSON.stringify({ name: '@helmx/plugins', version: '0.1.0' }))
  writeFixtureFile(pluginsRoot, 'dist/asset-paths.js', 'export const resolvePluginClientAssets = () => ({});\n')
  writeFixtureFile(pluginsRoot, 'dist/contracts.js', 'export const CONTRACTS = 1;\n')
  writeFixtureFile(pluginsRoot, 'dist/index.js', 'export const INDEX = 1;\n')
  writeFixtureFile(pluginsRoot, 'dist/alpha.js', 'export const alphaServer = 1;\n')
  writeFixtureFile(pluginsRoot, 'dist/beta.js', 'export const betaServer = 1;\n')

  if (options.withChunkInAlpha) {
    writeFixtureFile(
      pluginsRoot,
      'src/alpha/client/lazy.ts',
      'export const lazyLabel = "chunk-v1";\n',
    )
    writeFixtureFile(
      pluginsRoot,
      'src/alpha/client/index.tsx',
      'export async function loadAlpha() { const m = await import("./lazy.ts"); return m.lazyLabel; }\n',
    )
  } else {
    writeFixtureFile(
      pluginsRoot,
      'src/alpha/client/index.tsx',
      'export function AlphaView() { return "alpha-v1"; }\n',
    )
  }
  writeFixtureFile(
    pluginsRoot,
    'src/beta/client/index.tsx',
    'export function BetaView() { return "beta-v1"; }\n',
  )

  const alphaExport = options.withChunkInAlpha ? 'loadAlpha' : 'AlphaView'
  const pluginsModule: Record<string, unknown> = {
    createAlphaPlugin: () => ({
      id: 'builtin:alpha',
      clientRoot: path.join(distDir, 'alpha', 'client'),
      definePlugin(ctx: { ui: { screen: (spec: unknown) => void } }) {
        ctx.ui.screen({
          id: 'alpha-screen',
          client: { module: 'index.tsx', export: alphaExport },
        })
      },
    }),
    createBetaPlugin: () => ({
      id: 'builtin:beta',
      clientRoot: path.join(distDir, 'beta', 'client'),
      definePlugin(ctx: { ui: { screen: (spec: unknown) => void } }) {
        ctx.ui.screen({
          id: 'beta-screen',
          client: { module: 'index.tsx', export: 'BetaView' },
        })
      },
    }),
  }

  return { root, pluginsRoot, distDir, cacheFile, pluginsModule }
}

describe('copy-plugin-clients incremental fingerprint caching', () => {
  test('cache hit skips esbuild; editing one plugin rebuilds ONLY that plugin; shared input edits invalidate all', { timeout: 60_000 }, async (t) => {
    const { copyAndPrebuildPluginClients } = await copyClientsModPromise
    const root = useTempDir(t, 'helmx-copy-clients-hit-')
    const fixture = createPluginsFixture(root)

    const builtCalls: string[] = []
    const trackingBuild = async (opts: BuildPluginClientBundleDirOptions) => {
      builtCalls.push(opts.pluginId)
      return buildPluginClientBundleDir(opts)
    }

    // 1. Cold build compiles both alpha and beta via real esbuild
    const cold = await copyAndPrebuildPluginClients({
      pkgRoot: fixture.pluginsRoot,
      repoRoot: fixture.root,
      cacheFile: fixture.cacheFile,
      pluginsModule: fixture.pluginsModule,
      buildBundle: trackingBuild,
      env: {},
      quiet: true,
    })
    assert.deepEqual(cold.rebuilt, ['alpha', 'beta'])
    assert.deepEqual(cold.cached, [])
    assert.deepEqual(builtCalls, ['builtin:alpha', 'builtin:beta'])
    assert.ok(existsSync(path.join(fixture.distDir, 'alpha', PREBUILT_CLIENT_DIR_NAME, PREBUILT_CLIENT_MANIFEST_FILE)))
    assert.ok(existsSync(path.join(fixture.distDir, 'beta', PREBUILT_CLIENT_DIR_NAME, PREBUILT_CLIENT_MANIFEST_FILE)))

    // 2. Warm no-op build hits cache for both plugins with zero esbuild invocations
    builtCalls.length = 0
    const warm = await copyAndPrebuildPluginClients({
      pkgRoot: fixture.pluginsRoot,
      repoRoot: fixture.root,
      cacheFile: fixture.cacheFile,
      pluginsModule: fixture.pluginsModule,
      buildBundle: trackingBuild,
      env: {},
      quiet: true,
    })
    assert.deepEqual(warm.rebuilt, [])
    assert.deepEqual(warm.cached, ['alpha', 'beta'])
    assert.deepEqual(builtCalls, [])

    // 3. Edit ONLY alpha client source -> ONLY alpha rebuilds; beta stays cached
    builtCalls.length = 0
    writeFixtureFile(
      fixture.pluginsRoot,
      'src/alpha/client/index.tsx',
      'export function AlphaView() { return "alpha-v2"; }\n',
    )
    const afterAlphaEdit = await copyAndPrebuildPluginClients({
      pkgRoot: fixture.pluginsRoot,
      repoRoot: fixture.root,
      cacheFile: fixture.cacheFile,
      pluginsModule: fixture.pluginsModule,
      buildBundle: trackingBuild,
      env: {},
      quiet: true,
    })
    assert.deepEqual(afterAlphaEdit.rebuilt, ['alpha'])
    assert.deepEqual(afterAlphaEdit.cached, ['beta'])
    assert.deepEqual(builtCalls, ['builtin:alpha'])
    assert.match(
      readFileSync(path.join(fixture.distDir, 'alpha/client/index.tsx'), 'utf8'),
      /alpha-v2/,
      'updated source client file must be mirrored to dist/<name>/client',
    )

    // 4. Edit ONLY beta compiled server file -> ONLY beta rebuilds; alpha stays cached
    builtCalls.length = 0
    writeFixtureFile(fixture.pluginsRoot, 'dist/beta.js', 'export const betaServer = 2;\n')
    const afterBetaDistEdit = await copyAndPrebuildPluginClients({
      pkgRoot: fixture.pluginsRoot,
      repoRoot: fixture.root,
      cacheFile: fixture.cacheFile,
      pluginsModule: fixture.pluginsModule,
      buildBundle: trackingBuild,
      env: {},
      quiet: true,
    })
    assert.deepEqual(afterBetaDistEdit.rebuilt, ['beta'])
    assert.deepEqual(afterBetaDistEdit.cached, ['alpha'])
    assert.deepEqual(builtCalls, ['builtin:beta'])

    // 5. Edit shared workspace input (pnpm-lock.yaml) -> both plugins invalidate and rebuild
    builtCalls.length = 0
    writeFixtureFile(fixture.root, 'pnpm-lock.yaml', 'lockfileVersion: 9.0\n# updated\n')
    const afterLockEdit = await copyAndPrebuildPluginClients({
      pkgRoot: fixture.pluginsRoot,
      repoRoot: fixture.root,
      cacheFile: fixture.cacheFile,
      pluginsModule: fixture.pluginsModule,
      buildBundle: trackingBuild,
      env: {},
      quiet: true,
    })
    assert.deepEqual(afterLockEdit.rebuilt, ['alpha', 'beta'])
    assert.deepEqual(afterLockEdit.cached, [])
    assert.deepEqual(builtCalls, ['builtin:alpha', 'builtin:beta'])
  })

  test('missing, corrupted, or stray dist-client output files invalidate ONLY the affected plugin', { timeout: 60_000 }, async (t) => {
    const { copyAndPrebuildPluginClients } = await copyClientsModPromise
    const root = useTempDir(t, 'helmx-copy-clients-missing-')
    const fixture = createPluginsFixture(root, { withChunkInAlpha: true })

    const run = () =>
      copyAndPrebuildPluginClients({
        pkgRoot: fixture.pluginsRoot,
        repoRoot: fixture.root,
        cacheFile: fixture.cacheFile,
        pluginsModule: fixture.pluginsModule,
        env: {},
        quiet: true,
      })

    const initial = await run()
    assert.deepEqual(initial.rebuilt, ['alpha', 'beta'])

    const alphaOut = path.join(fixture.distDir, 'alpha', PREBUILT_CLIENT_DIR_NAME)
    const manifest = readManifest(alphaOut)
    const alphaEntry = manifest.modules['index.tsx']!
    assert.ok(alphaEntry.chunks && alphaEntry.chunks.length > 0, 'dynamic import in alpha must emit at least one split chunk')

    // 1. Delete entry .mjs file -> only alpha rebuilds and restores it
    rmSync(path.join(alphaOut, alphaEntry.entryFile))
    const afterMissingEntry = await run()
    assert.deepEqual(afterMissingEntry.rebuilt, ['alpha'])
    assert.deepEqual(afterMissingEntry.cached, ['beta'])
    assert.ok(existsSync(path.join(alphaOut, alphaEntry.entryFile)))

    // 2. Delete entry .mjs.gz file -> only alpha rebuilds and restores it
    rmSync(path.join(alphaOut, `${alphaEntry.entryFile}.gz`))
    const afterMissingGz = await run()
    assert.deepEqual(afterMissingGz.rebuilt, ['alpha'])
    assert.deepEqual(afterMissingGz.cached, ['beta'])
    assert.ok(existsSync(path.join(alphaOut, `${alphaEntry.entryFile}.gz`)))

    // 3. Delete a split chunk file -> only alpha rebuilds and restores it
    const chunkFile = prebuiltChunkFileName(alphaEntry.entryFile, alphaEntry.chunks[0]!, 'builtin:alpha')
    rmSync(path.join(alphaOut, chunkFile))
    const afterMissingChunk = await run()
    assert.deepEqual(afterMissingChunk.rebuilt, ['alpha'])
    assert.deepEqual(afterMissingChunk.cached, ['beta'])
    assert.ok(existsSync(path.join(alphaOut, chunkFile)))

    // 4. Delete manifest.json -> only alpha rebuilds and restores it
    rmSync(path.join(alphaOut, PREBUILT_CLIENT_MANIFEST_FILE))
    const afterMissingManifest = await run()
    assert.deepEqual(afterMissingManifest.rebuilt, ['alpha'])
    assert.deepEqual(afterMissingManifest.cached, ['beta'])
    assert.ok(existsSync(path.join(alphaOut, PREBUILT_CLIENT_MANIFEST_FILE)))

    // 5. Truncate emitted .mjs file -> size mismatch invalidates only alpha
    writeFileSync(path.join(alphaOut, alphaEntry.entryFile), '// truncated')
    const afterTamper = await run()
    assert.deepEqual(afterTamper.rebuilt, ['alpha'])
    assert.deepEqual(afterTamper.cached, ['beta'])
    assert.ok(readFileSync(path.join(alphaOut, alphaEntry.entryFile), 'utf8').length > 20)

    // 6. Drop stray untracked file inside dist-client -> wipes & rebuilds cleanly
    const stray = path.join(alphaOut, 'stray-leftover.txt')
    writeFileSync(stray, 'stray')
    const afterStray = await run()
    assert.deepEqual(afterStray.rebuilt, ['alpha'])
    assert.deepEqual(afterStray.cached, ['beta'])
    assert.equal(existsSync(stray), false, 'stray files in dist-client must be purged on rebuild')
  })

  test('HELMX_CLEAN_DIST=1 and --force bypass cache; cache miss wipes dist-client before re-calling factory for npmDependencies', { timeout: 60_000 }, async (t) => {
    const { copyAndPrebuildPluginClients } = await copyClientsModPromise
    const root = useTempDir(t, 'helmx-copy-clients-force-')
    const fixture = createPluginsFixture(root)

    // Simulate builtin:mermaid's factory pattern: npmDependencies is ONLY populated when
    // dist/<plugin>/dist-client does NOT exist on disk (source mode).
    const observedNpmRootsOnBuild: Array<number> = []
    const mermaidStyleModule: Record<string, unknown> = {
      createAlphaPlugin: () => {
        const hasPrebuilt = existsSync(path.join(fixture.distDir, 'alpha', PREBUILT_CLIENT_DIR_NAME))
        return {
          id: 'builtin:alpha',
          clientRoot: path.join(fixture.distDir, 'alpha', 'client'),
          ...(hasPrebuilt ? {} : { npmDependencies: { 'fake-pkg': fixture.pluginsRoot } }),
          definePlugin(ctx: { ui: { screen: (spec: unknown) => void } }) {
            ctx.ui.screen({
              id: 'alpha-screen',
              client: { module: 'index.tsx', export: 'AlphaView' },
            })
          },
        }
      },
      createBetaPlugin: fixture.pluginsModule['createBetaPlugin'],
    }

    const trackingBuild = async (opts: BuildPluginClientBundleDirOptions) => {
      if (opts.pluginId === 'builtin:alpha') {
        observedNpmRootsOnBuild.push((opts.npmRoots ?? []).length)
      }
      return buildPluginClientBundleDir(opts)
    }

    // 1. Cold build
    await copyAndPrebuildPluginClients({
      pkgRoot: fixture.pluginsRoot,
      repoRoot: fixture.root,
      cacheFile: fixture.cacheFile,
      pluginsModule: mermaidStyleModule,
      buildBundle: trackingBuild,
      env: {},
      quiet: true,
    })
    assert.deepEqual(observedNpmRootsOnBuild, [1])

    // 2. Edit alpha while dist/alpha/dist-client ALREADY exists -> must wipe dist-client BEFORE
    // re-invoking factory so npmDependencies is re-attached!
    writeFixtureFile(
      fixture.pluginsRoot,
      'src/alpha/client/index.tsx',
      'export function AlphaView() { return "alpha-v2"; }\n',
    )
    const afterEdit = await copyAndPrebuildPluginClients({
      pkgRoot: fixture.pluginsRoot,
      repoRoot: fixture.root,
      cacheFile: fixture.cacheFile,
      pluginsModule: mermaidStyleModule,
      buildBundle: trackingBuild,
      env: {},
      quiet: true,
    })
    assert.deepEqual(afterEdit.rebuilt, ['alpha'])
    assert.deepEqual(afterEdit.cached, ['beta'])
    assert.deepEqual(observedNpmRootsOnBuild, [1, 1], 'cache miss must wipe dist-client before re-calling factory so npmDependencies attaches')

    // 3. HELMX_CLEAN_DIST=1 bypasses cache and rebuilds all plugins
    const afterEnvForce = await copyAndPrebuildPluginClients({
      pkgRoot: fixture.pluginsRoot,
      repoRoot: fixture.root,
      cacheFile: fixture.cacheFile,
      pluginsModule: mermaidStyleModule,
      buildBundle: trackingBuild,
      env: { HELMX_CLEAN_DIST: '1' },
      quiet: true,
    })
    assert.deepEqual(afterEnvForce.rebuilt, ['alpha', 'beta'])
    assert.deepEqual(afterEnvForce.cached, [])
    assert.deepEqual(observedNpmRootsOnBuild, [1, 1, 1])

    // 4. --force CLI flag bypasses cache and rebuilds all plugins
    const afterCliForce = await copyAndPrebuildPluginClients({
      pkgRoot: fixture.pluginsRoot,
      repoRoot: fixture.root,
      cacheFile: fixture.cacheFile,
      pluginsModule: mermaidStyleModule,
      buildBundle: trackingBuild,
      env: {},
      argv: ['--force'],
      quiet: true,
    })
    assert.deepEqual(afterCliForce.rebuilt, ['alpha', 'beta'])
    assert.deepEqual(afterCliForce.cached, [])
    assert.deepEqual(observedNpmRootsOnBuild, [1, 1, 1, 1])
  })

  test('real dist/index.js fast path skips module import on warm hit and invalidates when dist/index.js changes', { timeout: 60_000 }, async (t) => {
    const { copyAndPrebuildPluginClients } = await copyClientsModPromise
    const root = useTempDir(t, 'helmx-copy-clients-fastpath-')
    const pluginsRoot = path.join(root, 'packages/plugins')
    const distDir = path.join(pluginsRoot, 'dist')
    const cacheFile = path.join(root, 'node_modules/.cache/helmx-build/plugin-clients-fingerprint.json')

    writeFixtureFile(root, 'pnpm-lock.yaml', 'lockfileVersion: 9.0\n')
    writeFixtureFile(pluginsRoot, 'package.json', JSON.stringify({ name: '@helmx/plugins', version: '0.1.0', type: 'module' }))
    writeFixtureFile(pluginsRoot, 'src/solo/client/index.tsx', 'export function SoloView() { return "solo-v1"; }\n')
    writeFixtureFile(pluginsRoot, 'dist/solo.js', 'export const soloServer = 1;\n')
    writeFixtureFile(
      pluginsRoot,
      'dist/index.js',
      `import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
export function createSoloPlugin() {
  return {
    id: 'builtin:solo',
    clientRoot: path.join(here, 'solo', 'client'),
    definePlugin(ctx) {
      ctx.ui.screen({ id: 'solo-screen', client: { module: 'index.tsx', export: 'SoloView' } });
    },
  };
}
`,
    )

    // 1. Cold run loads real dist/index.js and builds solo
    const cold = await copyAndPrebuildPluginClients({
      pkgRoot: pluginsRoot,
      repoRoot: root,
      cacheFile,
      env: {},
      quiet: true,
    })
    assert.deepEqual(cold.rebuilt, ['solo'])
    assert.deepEqual(cold.cached, [])

    // 2. Warm run hits fast path without even loading dist/index.js
    const warm = await copyAndPrebuildPluginClients({
      pkgRoot: pluginsRoot,
      repoRoot: root,
      cacheFile,
      env: {},
      quiet: true,
    })
    assert.deepEqual(warm.rebuilt, [])
    assert.deepEqual(warm.cached, ['solo'])

    // 3. Edit dist/index.js -> invalidates fast path and rebuilds solo
    writeFixtureFile(
      pluginsRoot,
      'dist/index.js',
      `${readFileSync(path.join(distDir, 'index.js'), 'utf8')}\n// entry touched\n`,
    )
    const afterIndexEdit = await copyAndPrebuildPluginClients({
      pkgRoot: pluginsRoot,
      repoRoot: root,
      cacheFile,
      env: {},
      quiet: true,
    })
    assert.deepEqual(afterIndexEdit.rebuilt, ['solo'])
    assert.deepEqual(afterIndexEdit.cached, [])
  })

  test('deleting a plugin client directory prunes stale dist/<deleted>/client, dist-client, and orphan plugin dirs in both clean-dist and copy-plugin-clients', { timeout: 60_000 }, async (t) => {
    const { copyAndPrebuildPluginClients } = await copyClientsModPromise
    const cleanDistMod = (await import(
      pathToFileURL(path.join(pkgRoot, 'scripts', 'clean-dist.mjs')).href
    )) as { pruneStalePluginDistDirs: (pkgRoot: string) => string[] }

    const root = useTempDir(t, 'helmx-copy-clients-prune-deleted-')
    const fixture = createPluginsFixture(root)

    await copyAndPrebuildPluginClients({
      pkgRoot: fixture.pluginsRoot,
      repoRoot: fixture.root,
      cacheFile: fixture.cacheFile,
      pluginsModule: fixture.pluginsModule,
      env: {},
      quiet: true,
    })
    assert.ok(existsSync(path.join(fixture.distDir, 'beta/client/index.tsx')))
    assert.ok(existsSync(path.join(fixture.distDir, 'beta', PREBUILT_CLIENT_DIR_NAME, PREBUILT_CLIENT_MANIFEST_FILE)))

    // Simulate removing plugin `beta` completely from `src/` (and compiled server `dist/beta.js`)
    rmSync(path.join(fixture.pluginsRoot, 'src/beta'), { recursive: true, force: true })
    rmSync(path.join(fixture.pluginsRoot, 'dist/beta.js'), { force: true })
    delete fixture.pluginsModule['createBetaPlugin']

    // 1) copyAndPrebuildPluginClients prunes stale dist/beta/{client,dist-client} and empty dist/beta
    const res = await copyAndPrebuildPluginClients({
      pkgRoot: fixture.pluginsRoot,
      repoRoot: fixture.root,
      cacheFile: fixture.cacheFile,
      pluginsModule: fixture.pluginsModule,
      env: {},
      quiet: true,
    })
    assert.deepEqual(res.cached, ['alpha'])
    assert.equal(existsSync(path.join(fixture.distDir, 'beta')), false, 'deleted plugin dist directory must be pruned')

    // 2) clean-dist pruneStalePluginDistDirs also cleans orphaned dist/<ghost> directories directly
    writeFixtureFile(fixture.pluginsRoot, 'dist/ghost/client/old.tsx', 'stale')
    writeFixtureFile(fixture.pluginsRoot, 'dist/ghost/dist-client/manifest.json', '{}')
    const removed = cleanDistMod.pruneStalePluginDistDirs(fixture.pluginsRoot)
    assert.ok(removed.includes('ghost'))
    assert.equal(existsSync(path.join(fixture.distDir, 'ghost')), false)
    assert.equal(existsSync(path.join(fixture.distDir, 'alpha', PREBUILT_CLIENT_DIR_NAME, PREBUILT_CLIENT_MANIFEST_FILE)), true)
  })
})

describe('pruneDist dist-client preservation', () => {
  test('preserves dist/<name>/dist-client for live plugins, prunes removed plugins, and excludes dist-client from keptJsCount', { timeout: 60_000 }, (t) => {
    const pkgRootDir = useTempDir(t, 'helmx-prune-dist-client-')
    writeFixtureFile(
      pkgRootDir,
      'tsconfig.json',
      JSON.stringify({ compilerOptions: { outDir: 'dist', tsBuildInfoFile: './cache/plugins.tsbuildinfo' } }),
    )
    const buildInfo = path.join(pkgRootDir, 'cache/plugins.tsbuildinfo')
    writeFixtureFile(pkgRootDir, 'cache/plugins.tsbuildinfo', '{}')

    // Live plugin `apps` with client/ + dist-client/, plus removed plugin `ghost`
    writeFixtureFile(pkgRootDir, 'src/index.ts', 'export const ok = true;\n')
    writeFixtureFile(pkgRootDir, 'src/apps/client/index.tsx', 'export const App = () => null;\n')

    writeFixtureFile(pkgRootDir, 'dist/index.js', 'export const ok = true;\n')
    writeFixtureFile(pkgRootDir, 'dist/apps/client/index.tsx', 'valid')
    writeFixtureFile(pkgRootDir, 'dist/apps/dist-client/manifest.json', '{}')
    writeFixtureFile(pkgRootDir, 'dist/apps/dist-client/index.abc123.mjs', 'export {};')
    writeFixtureFile(pkgRootDir, 'dist/apps/dist-client/index.abc123.mjs.gz', 'gz')
    writeFixtureFile(pkgRootDir, 'dist/ghost/dist-client/manifest.json', '{}')
    writeFixtureFile(pkgRootDir, 'dist/ghost/dist-client/index.dead.mjs', 'stale')

    const pruned = pruneDist({ pkgRoot: pkgRootDir, preserveClients: true, env: {} })
    assert.equal(pruned.mode, 'pruned')
    assert.deepEqual(pruned.removedFiles.sort(), [
      'ghost/dist-client/index.dead.mjs',
      'ghost/dist-client/manifest.json',
    ])
    assert.ok(existsSync(path.join(pkgRootDir, 'dist/apps/dist-client/manifest.json')))
    assert.ok(existsSync(path.join(pkgRootDir, 'dist/apps/dist-client/index.abc123.mjs')))
    assert.ok(!existsSync(path.join(pkgRootDir, 'dist/ghost')))
    assert.ok(existsSync(buildInfo), 'valid TS dist/index.js remains so tsbuildinfo must be kept')

    // If all TS-emitted JS files disappear while dist-client/*.mjs remains, tsbuildinfo MUST be cleared
    // so tsc incremental mode does not falsely skip re-emitting dist/index.js.
    rmSync(path.join(pkgRootDir, 'dist/index.js'))
    pruneDist({ pkgRoot: pkgRootDir, preserveClients: true, env: {} })
    assert.equal(existsSync(buildInfo), false, 'dist-client/*.mjs must not count as TS JS evidence when clearing tsbuildinfo')

    // HELMX_CLEAN_DIST=1 wipes everything including dist-client and tsbuildinfo
    writeFixtureFile(pkgRootDir, 'cache/plugins.tsbuildinfo', '{}')
    const wiped = pruneDist({ pkgRoot: pkgRootDir, preserveClients: true, env: { HELMX_CLEAN_DIST: '1' } })
    assert.equal(wiped.mode, 'wiped')
    assert.equal(existsSync(path.join(pkgRootDir, 'dist')), false)
    assert.equal(existsSync(buildInfo), false)
  })
})

describe('build-web incremental fingerprint caching', () => {
  test('cache hit skips vite build; source/public/workspace/output changes and HELMX_CLEAN_DIST=1 invalidate', { timeout: 60_000 }, async (t) => {
    const { runWebBuild, extractIndexAssetPaths } = await buildWebModPromise
    const root = useTempDir(t, 'helmx-build-web-')
    const webRoot = path.join(root, 'packages/web')
    const distDir = path.join(webRoot, 'dist')
    const cacheFile = path.join(root, 'node_modules/.cache/helmx-build/web-build-fingerprint.json')

    assert.deepEqual(
      extractIndexAssetPaths(
        '<link rel="icon" href="/favicon.svg?v=1"><script src="/assets/index-123.js"></script><a href="https://example.com/x"></a>',
      ),
      ['assets/index-123.js', 'favicon.svg'],
    )

    writeFixtureFile(root, 'pnpm-lock.yaml', 'lockfileVersion: 9.0\n')
    writeFixtureFile(root, 'packages/protocol/package.json', '{"name":"@helmx/protocol"}')
    writeFixtureFile(root, 'packages/protocol/src/browser.ts', 'export const p = 1;\n')
    writeFixtureFile(root, 'packages/plugin-client/package.json', '{"name":"@helmx/plugin-client"}')
    writeFixtureFile(root, 'packages/plugin-client/src/index.ts', 'export const sdk = 1;\n')
    writeFixtureFile(webRoot, 'package.json', '{"name":"@helmx/web"}')
    writeFixtureFile(webRoot, 'tsconfig.json', '{}')
    writeFixtureFile(webRoot, 'vite.config.ts', 'export default {};\n')
    writeFixtureFile(webRoot, 'index.html', '<html><head></head><body><div id="root"></div></body></html>')
    writeFixtureFile(webRoot, 'src/main.tsx', 'export const app = "v1";\n')
    writeFixtureFile(webRoot, 'public/sw.js', 'self.addEventListener("fetch", () => {});\n')
    writeFixtureFile(webRoot, 'public/favicon.svg', '<svg></svg>\n')

    let viteRuns = 0
    const fakeViteBuild = async () => {
      viteRuns += 1
      rmSync(distDir, { recursive: true, force: true })
      writeFixtureFile(
        distDir,
        'index.html',
        '<!doctype html><html><head><link rel="icon" href="/favicon.svg"><script type="module" src="/assets/index-aaa.js"></script></head><body></body></html>',
      )
      writeFixtureFile(distDir, 'assets/index-aaa.js', `console.log("run-${viteRuns}");\n`)
      writeFixtureFile(distDir, 'assets/lazy-bbb.js', 'export const lazy = 1;\n')
      writeFixtureFile(distDir, 'sw.js', readFileSync(path.join(webRoot, 'public/sw.js'), 'utf8'))
      writeFixtureFile(distDir, 'favicon.svg', readFileSync(path.join(webRoot, 'public/favicon.svg'), 'utf8'))
    }

    const run = (extra: { env?: NodeJS.ProcessEnv; argv?: string[] } = {}) =>
      runWebBuild({
        pkgRoot: webRoot,
        repoRoot: root,
        distDir,
        cacheFile,
        runVite: fakeViteBuild,
        env: extra.env ?? {},
        argv: extra.argv ?? [],
        quiet: true,
      })

    // 1. Cold run builds
    const r1 = await run()
    assert.equal(r1.status, 'built')
    assert.equal(viteRuns, 1)

    // 2. Warm run skips vite build
    const r2 = await run()
    assert.equal(r2.status, 'cached')
    assert.equal(viteRuns, 1)

    // 3. Edit web src -> invalidates
    writeFixtureFile(webRoot, 'src/main.tsx', 'export const app = "v2";\n')
    const r3 = await run()
    assert.equal(r3.status, 'built')
    assert.equal(viteRuns, 2)

    // 4. Edit public/sw.js -> invalidates
    writeFixtureFile(webRoot, 'public/sw.js', 'self.addEventListener("fetch", () => { /* v2 */ });\n')
    const r4 = await run()
    assert.equal(r4.status, 'built')
    assert.equal(viteRuns, 3)

    // 5. Edit workspace dependency protocol/src -> invalidates
    writeFixtureFile(root, 'packages/protocol/src/browser.ts', 'export const p = 2;\n')
    const r5 = await run()
    assert.equal(r5.status, 'built')
    assert.equal(viteRuns, 4)

    // 6. Delete asset referenced by dist/index.html -> invalidates
    rmSync(path.join(distDir, 'assets/index-aaa.js'))
    const r6 = await run()
    assert.equal(r6.status, 'built')
    assert.equal(viteRuns, 5)

    // 7. Delete lazy chunk not directly in index.html -> caught by recorded outputs
    rmSync(path.join(distDir, 'assets/lazy-bbb.js'))
    const r7 = await run()
    assert.equal(r7.status, 'built')
    assert.equal(viteRuns, 6)

    // 8. HELMX_CLEAN_DIST=1 and --force bypass cache
    const r8 = await run({ env: { HELMX_CLEAN_DIST: '1' } })
    assert.equal(r8.status, 'built')
    assert.equal(viteRuns, 7)

    const r9 = await run({ argv: ['--force'] })
    assert.equal(r9.status, 'built')
    assert.equal(viteRuns, 8)
  })
})
