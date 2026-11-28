/**
 * `reloadExternalPlugin` atomic-swap contract against a stub host (kernel-level, no PluginHost):
 * - happy path unregisters the old instance before registering the fresh normalized definition with the
 *   preserved enabled state and returning the advanced generation;
 * - a failing swap rolls back to the pre-reload definition (`rolledBack: true`); a failing rollback is reported
 *   honestly (`rolledBack: false` + `rollbackError`) without masking the root cause;
 * - a plugin id changed between preflight and swap aborts (409) before the live instance is unregistered;
 * - a plugin missing from the host list after the swap is an explicit 500 (inconsistent internal state);
 * - builtin / unknown / missing-source targets reject with their explicit 403 / 404 / 404 codes without
 *   unregistering or registering anything.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HelmxError, type PluginDefinition } from '@helmx/protocol'
import { reloadExternalPlugin, type ReloadablePluginHost } from '../src/plugins/external-loader.js'
import { assertRejectsCode, cleanupDir, makePluginSummary, makeTempDir } from './helpers.js'

const PLUGIN_ID = 'ext-reload-swap'
const PLUGIN_SOURCE = `export default { id: '${PLUGIN_ID}', name: 'Ext Reload Swap', definePlugin() {} }\n`

interface HostCall {
  op: 'list' | 'unregister' | 'register'
  pluginId?: string
  definition?: PluginDefinition
  options?: { enabled?: boolean }
}

/** Stub reload host: records every call; `registerOutcomes` is consumed in order to reject registrations. */
function makeReloadHost(options: {
  enabled: boolean
  registerOutcomes?: Array<Error | undefined>
  /** After this many `list()` calls the plugin disappears from the host list (inconsistent-state simulation). */
  hideAfterLists?: number
}): { host: ReloadablePluginHost; calls: HostCall[] } {
  const calls: HostCall[] = []
  const summary = makePluginSummary({ id: PLUGIN_ID, enabled: options.enabled })
  const outcomes = [...(options.registerOutcomes ?? [])]
  let lists = 0
  const host: ReloadablePluginHost = {
    async list() {
      calls.push({ op: 'list' })
      lists += 1
      return options.hideAfterLists !== undefined && lists > options.hideAfterLists ? [] : [summary]
    },
    async unregister(pluginId) {
      calls.push({ op: 'unregister', pluginId })
    },
    async register(definition, registerOptions) {
      calls.push({ op: 'register', pluginId: definition.id, definition, options: registerOptions })
      const outcome = outcomes.shift()
      if (outcome !== undefined) throw outcome
    },
  }
  return { host, calls }
}

/** Minimal external plugin source directory (`<dataDir>/installed-plugins/ext-reload-swap`, plain ESM entry). */
function writePluginSource(dataDir: string): string {
  const dir = join(dataDir, 'installed-plugins', PLUGIN_ID)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ id: PLUGIN_ID, main: 'index.mjs' }))
  writeFileSync(join(dir, 'index.mjs'), PLUGIN_SOURCE)
  return dir
}

const mutationsOf = (calls: HostCall[]): string[] => calls.filter((c) => c.op !== 'list').map((c) => c.op)
const registersOf = (calls: HostCall[]): HostCall[] => calls.filter((c) => c.op === 'register')

/** Asserts exactly `count` register calls happened and returns them in order. */
function registeredExactly(calls: HostCall[], count: number): HostCall[] {
  const registers = registersOf(calls)
  assert.equal(registers.length, count)
  return registers
}

test('reloadExternalPlugin swaps unregister -> fresh normalized register with the preserved enabled state and advanced generation', { timeout: 60_000 }, async (t) => {
  const dataDir = await makeTempDir('helmx-ext-reload-')
  t.after(() => cleanupDir(dataDir), { timeout: 60_000 })
  const sourceDir = writePluginSource(dataDir)
  const { host, calls } = makeReloadHost({ enabled: true })

  const result = await reloadExternalPlugin(dataDir, PLUGIN_ID, host)

  assert.equal(result.pluginId, PLUGIN_ID)
  assert.equal(result.wasEnabled, true)
  assert.ok(result.generation >= 1, 'reload import must use a fresh cache-busting generation')
  assert.deepEqual(mutationsOf(calls), ['unregister', 'register'])
  const [register] = registeredExactly(calls, 1)
  assert.ok(register !== undefined)
  assert.equal(register.definition?.id, PLUGIN_ID)
  assert.deepEqual(register.options, { enabled: true })
  assert.equal(register.definition?.clientRoot, sourceDir, 'registered definition must be normalized (clientRoot defaults to the source dir)')
})

test('reloadExternalPlugin rolls back to the pre-reload definition when the swap fails (rolledBack=true, root cause kept)', { timeout: 60_000 }, async (t) => {
  const dataDir = await makeTempDir('helmx-ext-reload-')
  t.after(() => cleanupDir(dataDir), { timeout: 60_000 })
  const sourceDir = writePluginSource(dataDir)
  const { host, calls } = makeReloadHost({
    enabled: false,
    registerOutcomes: [new Error('slash conflict')],
  })

  const err = (await assertRejectsCode(
    () => reloadExternalPlugin(dataDir, PLUGIN_ID, host),
    'plugin_reload_failed',
    500,
  )) as HelmxError
  const details = err.details as {
    pluginId: string
    sourceDir: string
    generation: number
    rolledBack: boolean
    rollbackError?: unknown
    cause?: { message: string }
  }

  assert.equal(details.rolledBack, true)
  assert.equal(details.rollbackError, undefined)
  assert.equal(details.pluginId, PLUGIN_ID)
  assert.equal(details.sourceDir, sourceDir)
  assert.equal(details.cause?.message, 'slash conflict')
  assert.match(
    err.message,
    /^re-registration failed during reload \(rolled back to pre-reload instance; previous definition remains active\): slash conflict$/,
  )
  assert.deepEqual(mutationsOf(calls), ['unregister', 'register', 'register'])
  const [swap, rollback] = registeredExactly(calls, 2)
  assert.ok(swap !== undefined && rollback !== undefined)
  assert.deepEqual(swap.options, { enabled: false })
  assert.deepEqual(rollback.options, { enabled: false }, 'rollback must preserve the pre-reload enabled state')
  assert.equal(rollback.definition?.id, PLUGIN_ID)
  assert.equal(rollback.definition?.clientRoot, sourceDir, 'rollback registers the normalized pre-reload definition')
})

test('reloadExternalPlugin reports a failing rollback honestly (rolledBack=false + rollbackError) without masking the root cause', { timeout: 60_000 }, async (t) => {
  const dataDir = await makeTempDir('helmx-ext-reload-')
  t.after(() => cleanupDir(dataDir), { timeout: 60_000 })
  writePluginSource(dataDir)
  const { host, calls } = makeReloadHost({
    enabled: true,
    registerOutcomes: [new Error('swap boom'), new Error('rollback boom')],
  })

  const err = (await assertRejectsCode(
    () => reloadExternalPlugin(dataDir, PLUGIN_ID, host),
    'plugin_reload_failed',
    500,
  )) as HelmxError
  const details = err.details as { rolledBack: boolean; rollbackError?: { message: string; stack?: string }; cause?: { message: string } }

  assert.equal(details.rolledBack, false)
  assert.equal(details.rollbackError?.message, 'rollback boom')
  assert.equal(details.cause?.message, 'swap boom')
  assert.match(
    err.message,
    /^re-registration failed during reload \(rollback also failed; plugin is currently unregistered — fix manually and retry\): swap boom$/,
  )
  assert.deepEqual(mutationsOf(calls), ['unregister', 'register', 'register'])
})

test('reloadExternalPlugin aborts before unregistering when the plugin id changed between preflight and swap (409)', { timeout: 60_000 }, async (t) => {
  const dataDir = await makeTempDir('helmx-ext-reload-')
  t.after(() => cleanupDir(dataDir), { timeout: 60_000 })
  const sourceDir = writePluginSource(dataDir)
  const { host, calls } = makeReloadHost({ enabled: true })

  const err = (await assertRejectsCode(
    () =>
      reloadExternalPlugin(dataDir, PLUGIN_ID, host, {
        // The source is edited after the probe import (preflight) so the cache-busting swap import sees the new id.
        doctor: async (dir) => {
          writeFileSync(
            join(dir, 'index.mjs'),
            `export default { id: 'ext-reload-renamed', name: 'Ext Reload Swap', definePlugin() {} }\n`,
          )
        },
      }),
    'plugin_reload_failed',
    409,
  )) as HelmxError

  assert.deepEqual(err.details, { pluginId: PLUGIN_ID, actualId: 'ext-reload-renamed', sourceDir })
  assert.match(err.message, /^plugin id changed during reload \(preflight ext-reload-swap -> actual ext-reload-renamed\); aborting swap$/)
  assert.deepEqual(mutationsOf(calls), [], 'an aborted swap must leave the live instance untouched')
})

test('reloadExternalPlugin rejects explicitly when the plugin is missing from the host list after the swap (500)', { timeout: 60_000 }, async (t) => {
  const dataDir = await makeTempDir('helmx-ext-reload-')
  t.after(() => cleanupDir(dataDir), { timeout: 60_000 })
  writePluginSource(dataDir)
  const { host, calls } = makeReloadHost({ enabled: true, hideAfterLists: 1 })

  await assertRejectsCode(
    () => reloadExternalPlugin(dataDir, PLUGIN_ID, host),
    'plugin_reload_failed',
    500,
  )
  assert.deepEqual(mutationsOf(calls), ['unregister', 'register'])
})

test('reloadExternalPlugin rejects builtin (403 plugin_locked), unregistered (404 unknown_plugin) and source-less (404 plugin_source_missing) targets without touching the host', { timeout: 60_000 }, async (t) => {
  const dataDir = await makeTempDir('helmx-ext-reload-')
  t.after(() => cleanupDir(dataDir), { timeout: 60_000 })

  const builtin = makeReloadHost({ enabled: true })
  await assertRejectsCode(() => reloadExternalPlugin(dataDir, 'builtin:mentions', builtin.host), 'plugin_locked', 403)
  assert.deepEqual(builtin.calls, [], 'builtin plugins must be rejected before any host call')

  const unregistered = makeReloadHost({ enabled: true, hideAfterLists: 0 })
  await assertRejectsCode(() => reloadExternalPlugin(dataDir, PLUGIN_ID, unregistered.host), 'unknown_plugin', 404)
  assert.deepEqual(mutationsOf(unregistered.calls), [])

  const registered = makeReloadHost({ enabled: true })
  const missing = (await assertRejectsCode(
    () => reloadExternalPlugin(dataDir, PLUGIN_ID, registered.host),
    'plugin_source_missing',
    404,
  )) as HelmxError
  assert.deepEqual(missing.details, { pluginId: PLUGIN_ID, pluginsDir: join(dataDir, 'installed-plugins') })
  assert.deepEqual(mutationsOf(registered.calls), [])
})
