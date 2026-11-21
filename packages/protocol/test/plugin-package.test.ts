/**
 * Shared contract lock tests for external plugin package management (pure type
 * shapes + the source grammar type surface). protocol holds only serializable
 * types; the parser is implemented in the kernel — these tests lock the type
 * contract only:
 * - the PluginPackageSource three-state discriminated union (npm/git/local) and
 *   per-variant fields;
 * - key fields of PluginPackageRecord / PluginInstallResult / PluginUpdateResult /
 *   PluginRemoveResult;
 * - PluginSummary.managed as additive optional metadata (existing contract intact);
 * - CORE_CLI_COMMAND_PATHS includes the plugins install/update/remove command paths.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CORE_CLI_COMMAND_PATHS,
  HelmxError,
  PREBUILT_CLIENT_MANIFEST_VERSION,
  assertPluginManifestProjection,
  assertPrebuiltChunkName,
  assertPrebuiltClientManifest,
  assertPrebuiltRelativeFile,
  compareCodeUnit,
  prebuiltChunkFileName,
  type PluginInstallResult,
  type PluginManifestProjection,
  type PluginPackageRecord,
  type PluginPackageSource,
  type PluginRemoveResult,
  type PluginSummary,
  type PluginUpdateResult,
} from '@helmx/protocol'

test('PluginPackageSource: npm/git/local three-variant discriminated union with type guards', { timeout: 60_000 }, () => {
  function describeSource(src: PluginPackageSource): string {
    switch (src.kind) {
      case 'npm':
        return `npm:${src.spec}`
      case 'git':
        return `git:${src.repo}#${src.ref ?? src.subdirectory ?? 'HEAD'}`
      case 'local':
        return `local:${src.path}`
    }
  }

  assert.equal(
    describeSource({ kind: 'npm', raw: 'npm:helmx-plugin-foo@^1.2.0', spec: 'helmx-plugin-foo@^1.2.0' }),
    'npm:helmx-plugin-foo@^1.2.0',
  )
  assert.equal(
    describeSource({
      kind: 'git',
      raw: 'git:https://github.com/u/helmx-plugin-foo.git@v1.2.0',
      repo: 'https://github.com/u/helmx-plugin-foo.git',
      ref: 'v1.2.0',
    }),
    'git:https://github.com/u/helmx-plugin-foo.git#v1.2.0',
  )
  assert.equal(
    describeSource({
      kind: 'git',
      raw: 'https://github.com/u/monorepo#main',
      repo: 'https://github.com/u/monorepo',
      subdirectory: 'packages/foo',
    }),
    'git:https://github.com/u/monorepo#packages/foo',
  )
  assert.equal(
    describeSource({ kind: 'local', raw: '/abs/helmx-plugin-foo', path: '/abs/helmx-plugin-foo' }),
    'local:/abs/helmx-plugin-foo',
  )
})

test('PluginPackageRecord / install / update / remove result model contract lock', { timeout: 60_000 }, () => {
  type RecordKeys = keyof PluginPackageRecord
  type InstallKeys = keyof PluginInstallResult
  type UpdateKeys = keyof PluginUpdateResult
  type RemoveKeys = keyof PluginRemoveResult

  type RequiredRecord = ['id', 'pluginId', 'source', 'installPath', 'version', 'installedAt', 'updatedAt'][number] extends RecordKeys ? true : false
  type RequiredInstall = ['record', 'summary'][number] extends InstallKeys ? true : false
  type RequiredUpdate = ['record', 'summary', 'changed', 'previousVersion'][number] extends UpdateKeys ? true : false
  type RequiredRemove = ['pluginId', 'installPath', 'wasEnabled', 'installId'][number] extends RemoveKeys ? true : false

  const typeLocks: [RequiredRecord, RequiredInstall, RequiredUpdate, RequiredRemove] = [true, true, true, true]
  assert.deepEqual(typeLocks, [true, true, true, true])
})

test('PluginSummary.managed is an additive optional field (type guards and structural defense)', { timeout: 60_000 }, () => {
  type ManagedOptional = undefined extends PluginSummary['managed'] ? true : false
  const optCheck: ManagedOptional = true
  assert.equal(optCheck, true)

  const legacy: PluginSummary = {
    id: 'builtin:profile',
    name: 'profile',
    locked: true,
    enabled: true,
    hooks: [],
    actions: [],
    tools: [],
  }
  assert.equal(legacy.managed, undefined)
})

test('CORE_CLI_COMMAND_PATHS includes plugins install/update/remove/build/manifest without duplicates', { timeout: 60_000 }, () => {
  const paths = [...CORE_CLI_COMMAND_PATHS]
  for (const cmd of ['plugins manifest', 'plugins build', 'plugins install', 'plugins update', 'plugins remove']) {
    assert.ok(paths.includes(cmd), `should include ${cmd}`)
  }
  assert.equal(new Set(paths).size, paths.length, 'command paths must not repeat')
})

test('PrebuiltClientManifest validation and chunk path helpers enforce integrity and path containment', { timeout: 60_000 }, () => {
  assert.equal(
    prebuiltChunkFileName('index.tsx-a1b2c3.deadbeef.mjs', 'mermaid.core-123.js'),
    'index.tsx-a1b2c3.deadbeef.chunk.mermaid.core-123.js',
  )
  assert.throws(() => assertPrebuiltChunkName('p', '../escape.js'), (e: unknown) => e instanceof HelmxError && e.code === 'invalid_client_module')
  assert.throws(() => assertPrebuiltRelativeFile('/dist-client', '../secret.mjs', 'entryFile'), (e: unknown) => e instanceof HelmxError && e.code === 'prebuilt_client_invalid')
  assert.throws(() => assertPrebuiltRelativeFile('/dist-client', '/abs.mjs', 'entryFile'), (e: unknown) => e instanceof HelmxError && e.code === 'prebuilt_client_invalid')
  assert.throws(() => assertPrebuiltRelativeFile('/dist-client', 'a\\b.mjs', 'entryFile'), (e: unknown) => e instanceof HelmxError && e.code === 'prebuilt_client_invalid')

  const valid = assertPrebuiltClientManifest(
    {
      version: PREBUILT_CLIENT_MANIFEST_VERSION,
      modules: {
        'index.tsx': {
          entryFile: 'index.tsx-abc.hash1234.mjs',
          contentHash: 'hash1234',
          exports: ['Panel', '__helmxClientCss'],
          chunks: ['chunk-1.js'],
        },
      },
    },
    '/tmp/dist-client',
  )
  assert.equal(valid.version, 1)
  assert.deepEqual(valid.modules['index.tsx']?.chunks, ['chunk-1.js'])

  // Bad versions / missing fields / escaping paths / duplicate chunks fail explicitly
  for (const bad of [
    null,
    [],
    { version: 2, modules: {} },
    { version: 1, modules: null },
    { version: 1, modules: { '../bad.tsx': { entryFile: 'a.mjs', contentHash: 'abc', exports: [] } } },
    { version: 1, modules: { 'index.tsx': { entryFile: '../evil.mjs', contentHash: 'abc', exports: [] } } },
    { version: 1, modules: { 'index.tsx': { entryFile: 'a.mjs', contentHash: '', exports: [] } } },
    { version: 1, modules: { 'index.tsx': { entryFile: 'a.mjs', contentHash: 'abc', exports: [1] } } },
    { version: 1, modules: { 'index.tsx': { entryFile: 'a.mjs', contentHash: 'abc', exports: [], chunks: ['a.js', 'a.js'] } } },
    { version: 1, modules: { 'index.tsx': { entryFile: 'a.mjs', contentHash: 'abc', exports: [], chunks: ['../evil.js'] } } },
  ]) {
    assert.throws(() => assertPrebuiltClientManifest(bad, '/tmp/dist-client'), (e: unknown) => e instanceof HelmxError)
  }
})

test('assertPluginManifestProjection enforces strict sorting, JSON safety, and leak-free boundaries', { timeout: 60_000 }, () => {
  assert.equal(compareCodeUnit('a', 'b'), -1)
  assert.equal(compareCodeUnit('b', 'a'), 1)
  assert.equal(compareCodeUnit('a', 'a'), 0)

  const makeValid = (): PluginManifestProjection => ({
    id: 'demo:manifest',
    name: { en: 'Demo', 'zh-CN': '演示' },
    description: 'Read-only contract sample',
    icon: 'puzzle',
    version: '1.2.3',
    locked: false,
    enabled: true,
    status: 'active',
    dependencies: ['builtin:profile', 'dep:alpha'],
    hooks: ['trigger', 'before_turn', 'turn_settled'],
    actions: [
      {
        pluginId: 'demo:manifest',
        id: 'alpha',
        description: 'Run alpha',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        exposeAsTool: true,
        toolName: 'demo_manifest_alpha_deadbeef',
        scope: { profileIds: ['assistant'] },
      },
      {
        pluginId: 'demo:manifest',
        id: 'zeta',
        description: 'Run zeta',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        idempotent: true,
        cli: { command: ['demo', 'zeta'], hidden: false },
      },
    ],
    tools: [
      {
        name: 'demo_manifest_alpha_deadbeef',
        description: 'Run alpha',
        inputSchema: { type: 'object' },
        scope: { profileIds: ['assistant'] },
        sourceKind: 'action',
        qualifiedId: 'demo:manifest.alpha',
      },
      {
        name: 'direct_tool',
        description: 'Direct tool',
        inputSchema: { type: 'object' },
        structuredOutputSchema: { type: 'object' },
        replay: 'safe',
        sourceKind: 'tool',
      },
    ],
    ui: [
      { surface: 'screen', id: 'main', spec: { id: 'main', label: 'Main' } },
      { surface: 'sidebar.item', id: 'nav', spec: { id: 'nav', label: 'Nav' } },
    ],
    routes: [
      { method: 'GET', path: '/api/plugins/demo%3Amanifest/routes/health', public: true },
      { method: 'POST', path: '/api/plugins/demo%3Amanifest/routes/items', public: false },
    ],
    docs: [
      { name: 'status', kind: 'doc', public: true, durable: true },
      { name: 'runs', kind: 'sessionDoc', public: true, durable: false },
    ],
    configFields: [
      { key: 'apiKey', type: 'string', secret: true, required: true },
      {
        key: 'retries',
        type: 'number',
        secret: false,
        required: false,
        default: 3,
        minimum: 0,
        maximum: 10,
        integer: true,
      },
    ],
    providers: [{ id: 'p-1', name: 'Provider One' }],
    services: ['svc-a', 'svc-b'],
    clientModules: [{ module: 'index.tsx', contentHash: 'hash1234' }],
  })

  const valid = assertPluginManifestProjection(makeValid())
  assert.equal(valid.id, 'demo:manifest')

  // Unsorted / duplicate / leaky / malformed manifests must throw 400 invalid_plugin_manifest
  const assertInvalid = (mutate: (m: Record<string, unknown>) => void, label: string) => {
    const candidate = makeValid() as unknown as Record<string, unknown>
    mutate(candidate)
    assert.throws(
      () => assertPluginManifestProjection(candidate),
      (err: unknown) => err instanceof HelmxError && err.code === 'invalid_plugin_manifest',
      `expected invalid_plugin_manifest for: ${label}`,
    )
  }

  assertInvalid((m) => { m['dependencies'] = ['dep:alpha', 'builtin:profile'] }, 'unsorted dependencies')
  assertInvalid((m) => { m['dependencies'] = ['a', 'a'] }, 'duplicate dependencies')
  assertInvalid((m) => { m['hooks'] = ['turn_settled', 'trigger'] }, 'unsorted hooks')
  assertInvalid((m) => { m['actions'] = [...(m['actions'] as unknown[])].reverse() }, 'unsorted actions')
  assertInvalid((m) => { (m['actions'] as Array<Record<string, unknown>>)[0]!['pluginId'] = 'other' }, 'mismatched action pluginId')
  assertInvalid((m) => { delete (m['actions'] as Array<Record<string, unknown>>)[0]!['toolName'] }, 'missing toolName when exposeAsTool=true')
  assertInvalid((m) => { (m['actions'] as Array<Record<string, unknown>>)[1]!['toolName'] = 'extra' }, 'unexpected toolName when exposeAsTool!=true')
  assertInvalid((m) => { m['tools'] = [...(m['tools'] as unknown[])].reverse() }, 'unsorted tools')
  assertInvalid((m) => { (m['tools'] as Array<Record<string, unknown>>)[1]!['qualifiedId'] = 'x.y' }, 'qualifiedId on direct tool')
  assertInvalid((m) => { (m['ui'] as Array<Record<string, unknown>>)[0]!['surface'] = 'unknown.surface' }, 'unknown UI surface')
  assertInvalid((m) => { (m['ui'] as Array<Record<string, unknown>>)[0]!['id'] = 'mismatch' }, 'mismatched ui.spec.id')
  assertInvalid((m) => { m['routes'] = [...(m['routes'] as unknown[])].reverse() }, 'unsorted routes')
  assertInvalid((m) => { (m['docs'] as Array<Record<string, unknown>>)[0]!['public'] = false }, 'private doc in manifest')
  assertInvalid((m) => { (m['configFields'] as Array<Record<string, unknown>>)[0]!['default'] = 'leaked-secret' }, 'secret field default')
  assertInvalid((m) => { (m['configFields'] as Array<Record<string, unknown>>)[1]!['default'] = 'wrong-type' }, 'mismatched default type')
  assertInvalid((m) => { m['status'] = 'failed' }, 'failed status without error')
  assertInvalid((m) => { m['error'] = { code: 'x', message: 'y', stage: 'define' } }, 'active status with error')
  assertInvalid((m) => { m['extra'] = 1 }, 'unexpected root property')
  assertInvalid((m) => { m['services'] = ['constructor'] }, 'prototype-unsafe identifier')
  assertInvalid((m) => {
    const cyc: Record<string, unknown> = {}
    cyc['self'] = cyc
    ;(m['actions'] as Array<Record<string, unknown>>)[0]!['inputSchema'] = cyc
  }, 'circular schema')
})

