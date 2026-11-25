/**
 * Kernel contract tests for the plugin package manager port (`packageManagerProvider`):
 * Kernel does not bundle package installation/fetching logic; `packageManagerProvider` is
 * injected explicitly via `PluginHostOptions.packageManagerProvider` / `KernelRuntimeOptions.packageManagerProvider`
 * (wired with `createPluginPackageManager` from `@helmx/plugin-build` in `@helmx/hub`).
 *
 * Coverage:
 * - `PluginHost`: install/update/remove reject explicitly with `501 unsupported_package_manager` when unwired;
 *   `loadPackageManager()` is a safe no-op when unwired;
 * - `PluginHost` wired with `createPluginPackageManager`: installs, updates, restores `managed` metadata on
 *   `loadPackageManager()`, and removes cleanly;
 * - `KernelRuntime`: unwired runtime rejects install/update/remove and HTTP `/api/plugins/install`, `:id/update`,
 *   `:id/remove` with `501 unsupported_package_manager`;
 * - `KernelRuntime` wired with `createPluginPackageManager`: end-to-end install, restart persistence of
 *   `PluginSummary.managed`, corrupt `config.json.pluginPackages` boot rejection (`config_corrupt`), and remove.
 */
import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { HelmxError } from '@helmx/protocol'
import { createPluginBuildProvider, createPluginPackageManager } from '@helmx/plugin-build'
import { createHubHandler } from '../src/http/hub.js'
import { PluginHost } from '../src/plugins/plugin-host.js'
import { KernelRuntime } from '../src/runtime/index.js'
import { createPluginHostBackendFixture } from './helpers/plugin-host-backend.js'
import { MemoryDocStore, assertRejectsCode, cleanupDir, makeTempDir } from './helpers.js'

let workDir: string

beforeEach(async () => {
  workDir = await makeTempDir('helmx-pkg-port-')
})

afterEach(async () => {
  await cleanupDir(workDir)
})

function writeLocalPlugin(parent: string, id: string, version = '1.0.0'): string {
  const dir = join(parent, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ id, version, main: 'index.mjs' }, null, 2))
  writeFileSync(
    join(dir, 'index.mjs'),
    `export default {
  id: '${id}',
  version: '${version}',
  definePlugin(ctx) {
    ctx.action({
      id: 'ping',
      description: 'probe',
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: { type: 'object', properties: { pong: { type: 'boolean' } }, required: ['pong'], additionalProperties: false },
      handler: () => ({ pong: true }),
    })
  },
}
`,
  )
  return dir
}

test('PluginHost: install/update/remove reject with 501 unsupported_package_manager when packageManagerProvider is unwired', { timeout: 60_000 }, async () => {
  const dataDir = join(workDir, 'host-unwired')
  mkdirSync(dataDir, { recursive: true })
  const host = new PluginHost({
    dataDir,
    host: { ...createPluginHostBackendFixture(), emitEvent: () => {} },
    docs: new MemoryDocStore(),
  })
  try {
    await host.loadPackageManager()
    await assertRejectsCode(() => host.installPluginPackage('/tmp/some-plugin'), 'unsupported_package_manager', 501)
    await assertRejectsCode(() => host.updatePluginPackage('some-plugin'), 'unsupported_package_manager', 501)
    await assertRejectsCode(() => host.removePluginPackage('some-plugin'), 'unsupported_package_manager', 501)
  } finally {
    await host.dispose()
  }
})

test('PluginHost: wired with createPluginPackageManager installs, updates, restores managed metadata on loadPackageManager, and removes', { timeout: 60_000 }, async () => {
  const dataDir = join(workDir, 'host-wired')
  const srcRoot = join(workDir, 'src')
  mkdirSync(dataDir, { recursive: true })
  const srcDir = writeLocalPlugin(srcRoot, 'port-demo', '1.0.0')

  const makeHost = () =>
    new PluginHost({
      dataDir,
      cwd: srcRoot,
      host: { ...createPluginHostBackendFixture(), emitEvent: () => {} },
      docs: new MemoryDocStore(),
      buildProvider: createPluginBuildProvider(),
      packageManagerProvider: createPluginPackageManager,
    })

  const first = makeHost()
  try {
    await first.loadPackageManager()
    const installed = await first.installPluginPackage(srcDir, { enable: true })
    assert.equal(installed.record.pluginId, 'port-demo')
    assert.equal(installed.summary.enabled, true)
    assert.equal(installed.summary.managed?.installedVersion, '1.0.0')
    assert.equal(first.get('port-demo')?.managed?.installId, installed.record.id)

    writeLocalPlugin(srcRoot, 'port-demo', '1.1.0')
    const updated = await first.updatePluginPackage('port-demo')
    assert.equal(updated.changed, true)
    assert.equal(updated.record.version, '1.1.0')
  } finally {
    await first.dispose()
  }

  const second = makeHost()
  try {
    await second.loadPackageManager()
    await second.rescanExternalPlugins()
    const restored = second.get('port-demo')
    assert.equal(restored?.managed?.installedVersion, '1.1.0')
    const removed = await second.removePluginPackage('port-demo')
    assert.equal(removed.pluginId, 'port-demo')
    assert.equal(second.get('port-demo'), undefined)
  } finally {
    await second.dispose()
  }
})

test('KernelRuntime: unwired packageManagerProvider rejects API and HTTP install/update/remove with 501 unsupported_package_manager', { timeout: 60_000 }, async () => {
  const dataDir = join(workDir, 'kernel-unwired')
  const models = createModels()
  models.setProvider(fauxProvider({ tokensPerSecond: 1 }).provider)
  const kernel = await KernelRuntime.open({
    dataDir,
    cwd: dataDir,
    model: 'faux/faux-1',
    models,
    autoResume: false,
  })
  try {
    await kernel.start()
    await assertRejectsCode(() => kernel.plugins.installPluginPackage('/tmp/x'), 'unsupported_package_manager', 501)
    await assertRejectsCode(() => kernel.plugins.updatePluginPackage('x'), 'unsupported_package_manager', 501)
    await assertRejectsCode(() => kernel.plugins.removePluginPackage('x'), 'unsupported_package_manager', 501)

    const handler = createHubHandler(kernel as never)
    const token = kernel.auth.createProcessToken().token
    const call = async (path: string, body?: unknown) => {
      const res = await handler(
        new Request(`http://127.0.0.1:3202${path}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        }),
      )
      return { status: res.status, body: (await res.json()) as { error?: { code?: string } } }
    }

    const installRes = await call('/api/plugins/install', { source: '/tmp/x' })
    assert.equal(installRes.status, 501)
    assert.equal(installRes.body.error?.code, 'unsupported_package_manager')

    const updateRes = await call('/api/plugins/x/update')
    assert.equal(updateRes.status, 501)
    assert.equal(updateRes.body.error?.code, 'unsupported_package_manager')

    const removeRes = await call('/api/plugins/x/remove')
    assert.equal(removeRes.status, 501)
    assert.equal(removeRes.body.error?.code, 'unsupported_package_manager')
  } finally {
    await kernel.close()
  }
})

test('KernelRuntime: wired packageManagerProvider warms store on boot (rejecting corrupt config) and supports install/remove', { timeout: 60_000 }, async () => {
  const dataDir = join(workDir, 'kernel-wired')
  const srcDir = writeLocalPlugin(join(workDir, 'src-kernel'), 'kernel-pkg', '1.0.0')
  const models = createModels()
  models.setProvider(fauxProvider({ tokensPerSecond: 1 }).provider)

  const kernel = await KernelRuntime.open({
    dataDir,
    cwd: workDir,
    model: 'faux/faux-1',
    models,
    buildProvider: createPluginBuildProvider(),
    packageManagerProvider: createPluginPackageManager,
    autoResume: false,
  })
  try {
    const installed = await kernel.plugins.installPluginPackage(srcDir, { enable: true })
    assert.equal(installed.summary.managed?.installedVersion, '1.0.0')
    const removed = await kernel.plugins.removePluginPackage('kernel-pkg')
    assert.equal(removed.pluginId, 'kernel-pkg')
  } finally {
    await kernel.close()
  }

  const corruptDir = join(workDir, 'kernel-corrupt')
  mkdirSync(corruptDir, { recursive: true })
  writeFileSync(join(corruptDir, 'config.json'), JSON.stringify({ pluginPackages: 'corrupt' }))
  await assert.rejects(
    KernelRuntime.open({
      dataDir: corruptDir,
      cwd: corruptDir,
      model: 'faux/faux-1',
      models,
      packageManagerProvider: createPluginPackageManager,
      autoResume: false,
    }),
    (err: unknown) => err instanceof HelmxError && err.code === 'config_corrupt',
  )
})
