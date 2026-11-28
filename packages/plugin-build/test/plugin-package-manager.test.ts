/**
 * Dedicated unit tests for external plugin package management in `@helmx/plugin-build`:
 * - parsePluginSource: normalization and rejection across npm / git (shorthand / SCP / https / @ref / #subdir) / local (absolute / relative)
 *   sources (`file://`, `http://`, `git+`, unknown schemes, `builtin:`, whitespace, bare names);
 * - path security: install target escape, local self-install inside managed tree;
 * - staging cleanup on failure: `.staging` leaves zero residue and no half-written artifacts when the runner fails;
 * - local install: copy semantics (no symlinks), and `remove` leaves the user source directory untouched;
 * - full install / update / remove / rollback transactions against `PackageManagerHost` and `PluginPackageManagerStore`;
 * - `createPackageRunner`: Windows-safe npm resolution, tail cap, and process-tree timeout termination;
 * - `createPluginPackageManager` factory and `tailLines`.
 *
 * Every test specifies `{ timeout: 60_000 }` against deadlocks.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  HelmxError,
  type PackageManagerHost,
  type PluginDoctorReport,
  type PluginPackageRecord,
  type PluginPackagesConfigPort,
} from '@helmx/protocol'
import {
  createPackageRunner,
  createPluginPackageManager,
  parsePluginSource,
  PluginPackageManager,
  PluginPackageManagerStore,
  tailLines,
  type PackageRunner,
} from '../src/index.js'

async function assertRejectsCode(
  fn: () => Promise<unknown>,
  code: string,
  status?: number,
): Promise<unknown> {
  let caught: unknown
  await assert.rejects(fn, (err: unknown) => {
    assert.ok(err instanceof HelmxError, `expected HelmxError, got ${String(err)}`)
    assert.equal(err.code, code)
    if (status !== undefined) assert.equal(err.status, status)
    caught = err
    return true
  })
  return caught
}

function createJsonConfigPort(dataDir: string): PluginPackagesConfigPort {
  const filePath = join(dataDir, 'config.json')
  let chain: Promise<unknown> = Promise.resolve()
  const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn)
    chain = next.catch(() => undefined)
    return next
  }
  const readCfg = async (): Promise<Record<string, unknown>> => {
    try {
      const raw = readFileSync(filePath, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error(`invalid config.json structure (expected object): ${filePath}`)
      }
      return parsed as Record<string, unknown>
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw err
    }
  }
  return {
    get: () => serialized(readCfg),
    updateBy: (mutate) =>
      serialized(async () => {
        const current = await readCfg()
        const next = mutate(current)
        mkdirSync(dataDir, { recursive: true })
        writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
        return next
      }),
  }
}

// ---------------------------------------------------------------------------
// Source parser & tailLines
// ---------------------------------------------------------------------------

test('parsePluginSource: npm normalization and rejection', { timeout: 60_000 }, () => {
  const npm = parsePluginSource('npm:helmx-plugin-foo@^1.2.0', '/wd')
  assert.equal(npm.kind, 'npm')
  assert.ok(npm.kind === 'npm')
  assert.equal(npm.spec, 'helmx-plugin-foo@^1.2.0')
  assert.equal(npm.raw, 'npm:helmx-plugin-foo@^1.2.0')
  const bare = parsePluginSource('npm:@scope/pkg', '/wd')
  assert.ok(bare.kind === 'npm' && bare.spec === '@scope/pkg')

  for (const bad of [
    'npm:',
    'npm: ',
    'npm:-evil',
    'npm:--registry=https://evil.example',
    'npm:file:./pkg',
    'npm:pkg@file:/etc/passwd',
    'npm:https://evil.example/pkg.tgz',
    'npm:../escape',
    'npm:./local',
    'npm:/abs/path',
    'npm:a/b/c',
    'npm:@scope/a/b',
    'npm:foo\tbar',
    'npm:builtin:evil',
    'npm:core:evil',
    'builtin:mentions',
    'builtin%3Amentions',
    'core:conversations',
    'core%3Aconversations',
    'core%3aconversations',
    '',
    '  ',
    'file:///tmp/x',
    'http://github.com/u/r',
    'git+https://x.example/r',
    'ftp://x/r',
    'my-unknown-proto:foo',
    'bare-name',
  ]) {
    assert.throws(() => parsePluginSource(bad, '/wd'), (err: unknown) => err instanceof HelmxError && err.status === 400, `should reject: ${bad}`)
  }
})

test('parsePluginSource: git shorthand / SCP / https with @ref / #subdirectory', { timeout: 60_000 }, () => {
  const short = parsePluginSource('git:github.com/user/repo@v1', '/wd')
  assert.ok(short.kind === 'git')
  if (short.kind !== 'git') return
  assert.equal(short.repo, 'github.com/user/repo')
  assert.equal(short.ref, 'v1')

  const scp = parsePluginSource('git:git@github.com:user/repo.git', '/wd')
  assert.ok(scp.kind === 'git')
  assert.equal((scp as { repo: string }).repo, 'git@github.com:user/repo.git')

  const https = parsePluginSource('https://github.com/user/repo.git', '/wd')
  assert.ok(https.kind === 'git')
  assert.equal((https as { repo: string }).repo, 'https://github.com/user/repo.git')

  const httpsRef = parsePluginSource('https://github.com/user/repo.git#v2.0.0', '/wd')
  assert.ok(httpsRef.kind === 'git')
  if (httpsRef.kind !== 'git') return
  assert.equal(httpsRef.ref, 'v2.0.0')
  assert.equal(httpsRef.subdirectory, undefined)

  const httpsSub = parsePluginSource('https://github.com/user/monorepo#packages/foo', '/wd')
  assert.ok(httpsSub.kind === 'git')
  if (httpsSub.kind !== 'git') return
  assert.equal(httpsSub.subdirectory, 'packages/foo')
  assert.equal(httpsSub.ref, undefined)

  const both = parsePluginSource('https://github.com/user/monorepo#v1#packages/foo', '/wd')
  assert.ok(both.kind === 'git')
  if (both.kind !== 'git') return
  assert.equal(both.ref, 'v1')
  assert.equal(both.subdirectory, 'packages/foo')

  const gitSub = parsePluginSource('git:github.com/user/repo@main#sub/dir', '/wd')
  assert.ok(gitSub.kind === 'git')
  if (gitSub.kind !== 'git') return
  assert.equal(gitSub.repo, 'github.com/user/repo')
  assert.equal(gitSub.ref, 'main')
  assert.equal(gitSub.subdirectory, 'sub/dir')

  const httpsRefSub = parsePluginSource('https://github.com/user/repo@v1#packages/foo', '/wd')
  assert.ok(httpsRefSub.kind === 'git')
  if (httpsRefSub.kind === 'git') {
    assert.equal(httpsRefSub.ref, 'v1')
    assert.equal(httpsRefSub.subdirectory, 'packages/foo')
  }

  for (const bad of [
    'git:',
    'git:repo@',
    'git:repo#',
    'git:repo#sub#more',
    'git:repo#../escape',
    'https://',
    'https://github.com/user/repo#sub#more#extra',
    'https://github.com/user/repo@v1#v2',
    'https://github.com/user/repo/../../evil',
    'git:repo@ref#sub#x',
  ]) {
    assert.throws(() => parsePluginSource(bad, '/wd'), (err: unknown) => err instanceof HelmxError, `should reject: ${bad}`)
  }
})

test('parsePluginSource: strict git repo validation (rejects path traversal and local relative paths)', { timeout: 60_000 }, () => {
  for (const ok of ['git:https://github.com/user/repo.git', 'git:github.com/user/repo', 'git:git@github.com:user/repo.git']) {
    const parsed = parsePluginSource(ok, '/wd')
    assert.ok(parsed.kind === 'git', `should accept: ${ok}`)
  }
  for (const bad of ['git:../evil', 'git:..\\..\\evil', 'git:repo/../../evil', 'git:/abs/path', 'git:C:\\repo', 'git:\\\\srv\\share', 'git:http://plain.example/r', 'git:file:///tmp/r', 'git:ssh://git@host:22/path', 'git:repo with space', 'git:local-dir', 'git:./relative']) {
    assert.throws(
      () => parsePluginSource(bad, '/wd'),
      (err: unknown) => err instanceof HelmxError && err.status === 400,
      `should reject: ${bad}`,
    )
  }
})

test('parsePluginSource: resolves absolute and relative local paths', { timeout: 60_000 }, () => {
  const abs = parsePluginSource('/abs/plugins/foo', '/wd')
  assert.ok(abs.kind === 'local')
  if (abs.kind !== 'local') return
  assert.equal(abs.path, '/abs/plugins/foo')

  const rel = parsePluginSource('./packages/foo', '/wd')
  assert.ok(rel.kind === 'local')
  if (rel.kind !== 'local') return
  assert.equal(rel.path, '/wd/packages/foo')

  const up = parsePluginSource('../foo', '/wd/sub')
  assert.ok(up.kind === 'local')
  if (up.kind !== 'local') return
  assert.equal(up.path, '/wd/foo')

  for (const win of ['C:\\Users\\me\\my-plugin', 'C:/Users/me/my-plugin', '\\\\server\\share\\my-plugin']) {
    const parsed = parsePluginSource(win, '/wd')
    assert.ok(parsed.kind === 'local', `Windows-style path must parse as local: ${win}`)
    if (parsed.kind !== 'local') return
    assert.equal(parsed.raw, win)
    assert.ok(typeof parsed.path === 'string' && parsed.path.length > 0)
  }

  for (const bad of ['C:', 'unknownproto:x']) {
    assert.throws(
      () => parsePluginSource(bad, '/wd'),
      (err: unknown) => err instanceof HelmxError && err.status === 400,
      `should reject: ${bad}`,
    )
  }
})

test('tailLines: preserves trailing lines and trims surrounding whitespace', { timeout: 60_000 }, () => {
  assert.equal(tailLines('a\nb\nc\nd', 2), 'c\nd')
  assert.equal(tailLines('  only-one  \n', 40), 'only-one')
})

test('install from a Windows-style local path missing on this host fails honestly with 404 (resolved on the Hub)', { timeout: 60_000 }, async () => {
  const env = makeEnv()
  try {
    await assert.rejects(
      env.manager.install('C:\\Users\\me\\definitely-missing-plugin', {}),
      (err: unknown) =>
        err instanceof HelmxError
        && err.status === 404
        && err.code === 'plugin_package_install_failed'
        && err.message.includes('Hub host'),
      'drive-letter source should fail at stat with an honest Hub-host diagnostic, not a protocol rejection',
    )
    const staging = join(env.dataDir, 'installed-plugins', '.staging')
    assert.ok(!existsSync(staging) || readdirSync(staging).length === 0, 'staging must be cleaned up')
    assert.equal(env.registered.size, 0, 'nothing should be registered')
    if (existsSync(join(env.dataDir, 'config.json'))) {
      const config = JSON.parse(readFileSync(join(env.dataDir, 'config.json'), 'utf8')) as { pluginPackages?: Record<string, unknown> }
      assert.equal(Object.keys(config.pluginPackages ?? {}).length, 0, 'no install record should persist')
    }
  } finally {
    env.close()
  }
})

// ---------------------------------------------------------------------------
// Test harness: fake runner + structural PackageManagerHost stub
// ---------------------------------------------------------------------------

/** Minimal valid external plugin source (conventional entry layout). */
const PLUGIN_SRC = (id: string, version = '0.1.0') => `export default {
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
`

/** Package manager store backed by real config.json with toggleable save failure injection. */
class FaultInjectingStore extends PluginPackageManagerStore {
  failNextSave = false
  override async save(
    record: Omit<PluginPackageRecord, 'id'> & { id?: string },
  ): Promise<PluginPackageRecord> {
    if (this.failNextSave) throw new Error('simulated disk write failure')
    return super.save(record)
  }
}

interface TestEnv {
  dataDir: string
  cwd: string
  store: FaultInjectingStore
  host: PackageManagerHost
  manager: PluginPackageManager
  hostCalls: string[]
  registered: Map<string, { enabled: boolean }>
  updateBlockedIds: Set<string>
  registerFailIds: Set<string>
  enableFailIds: Set<string>
  purgeFailIds: Set<string>
  close(): void
}

function readTestManifest(dir: string): { id?: string; main?: string; clientDependencies?: string[] } | undefined {
  const manifestPath = join(dir, 'plugin.json')
  if (existsSync(manifestPath)) {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      id?: string
      main?: string
      clientDependencies?: string[]
    }
    return parsed
  }
  const pkgPath = join(dir, 'package.json')
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      helmx?: { id?: string; main?: string; clientDependencies?: string[] }
    }
    if (pkg.helmx !== undefined) return pkg.helmx
  }
  return undefined
}

async function doctorTestDir(dir: string): Promise<PluginDoctorReport> {
  const manifest = readTestManifest(dir)
  if (manifest === undefined || typeof manifest.main !== 'string' || manifest.main.length === 0) {
    return {
      dir,
      ok: false,
      checks: [
        {
          id: 'manifest',
          label: 'manifest and entry resolution',
          error: { code: 'plugin_manifest_missing', message: `External plugin ${dir} is missing manifest` },
        },
      ],
    }
  }
  const entryPath = join(dir, manifest.main)
  if (!existsSync(entryPath)) {
    return {
      dir,
      ok: false,
      checks: [
        {
          id: 'manifest',
          label: 'manifest and entry resolution',
          error: { code: 'plugin_entry_missing', message: `Missing entry file ${entryPath}` },
        },
      ],
    }
  }
  let def: { id?: string; definePlugin?: (ctx: unknown) => void } | undefined
  try {
    const mod = (await import(`${pathToFileURL(entryPath).href}?helmxdoc=${Date.now()}-${Math.random()}`)) as {
      default?: { id?: string; definePlugin?: (ctx: unknown) => void }
    }
    def = mod.default
  } catch (err) {
    return {
      dir,
      ...(manifest.id !== undefined ? { pluginId: manifest.id } : {}),
      ok: false,
      checks: [
        {
          id: 'backend',
          label: 'backend module isolated import',
          error: { code: 'plugin_load_failed', message: err instanceof Error ? err.message : String(err) },
        },
      ],
    }
  }
  const pluginId = def?.id ?? manifest.id
  try {
    def?.definePlugin?.({
      action() {},
      tool() {},
      service() {},
      route() {},
      configSchema() {},
      doc: () => ({ get: () => ({}), set() {}, update() {}, flush: async () => {} }),
      sessionDoc: () => ({ get: () => ({}), set() {}, update() {}, delete() {}, listConversationIds: () => [], flush: async () => {} }),
      kv: () => ({ get: () => undefined, set() {}, delete: () => false, list: () => ({ items: [] }), clear() {}, flush: async () => {} }),
      provide() {},
      consume: () => [],
      hook: { onInput() {}, onBeforeTurn() {}, onAgentSpawn() {}, onTurnSettled() {} },
      ui: {
        sidebarItem() {},
        screen() {},
        timelineRenderer() {},
        markdownCodeBlock() {},
        toolView() {},
        composerCompleter() {},
        workbenchPanel() {},
        command() {},
        settingsPanel() {},
        slot() {},
      },
    })
  } catch (err) {
    return {
      dir,
      ...(pluginId !== undefined ? { pluginId } : {}),
      ok: false,
      checks: [
        {
          id: 'register',
          label: 'real registration dry-run',
          error: { code: 'plugin_registration_failed', message: err instanceof Error ? err.message : String(err) },
        },
      ],
    }
  }
  return {
    dir,
    ...(pluginId !== undefined ? { pluginId } : {}),
    ok: true,
    checks: [
      { id: 'manifest', label: 'manifest and entry resolution' },
      { id: 'backend', label: 'backend module isolated import' },
      { id: 'register', label: 'real registration dry-run' },
      { id: 'client', label: 'frontend module compilation and export validation' },
    ],
  }
}

function makeEnv(runner?: PackageRunner): TestEnv {
  const dataDir = mkdtempSync(join(tmpdir(), 'helmx-pkg-mgr-'))
  const cwd = mkdtempSync(join(tmpdir(), 'helmx-pkg-cwd-'))
  const store = new FaultInjectingStore(createJsonConfigPort(dataDir))
  const hostCalls: string[] = []
  const registered = new Map<string, { enabled: boolean }>()
  const summaries = new Map<string, { id: string; version?: string; enabled: boolean }>()
  const updateBlockedIds = new Set<string>()
  const registerFailIds = new Set<string>()
  const enableFailIds = new Set<string>()
  const purgeFailIds = new Set<string>()
  const host: PackageManagerHost = {
    async registerManagedPlugin(dir: string) {
      hostCalls.push(`register:${dir}`)
      const id = readPluginIdFromDir(dir)
      if (registerFailIds.has(id)) {
        throw new HelmxError('plugin_register_failed_simulated', `simulated register failed: ${id}`, 500, { pluginId: id })
      }
      registered.set(id, { enabled: false })
      summaries.set(id, { id, version: readPluginVersionFromDir(dir), enabled: false })
      return { summary: toSummary(summaries, id), pluginId: id }
    },
    async enableManagedPlugin(pluginId: string) {
      hostCalls.push(`enable:${pluginId}`)
      const entry = registered.get(pluginId)
      if (!entry) throw new HelmxError('unknown_plugin', `plugin not registered: ${pluginId}`, 404, { pluginId })
      if (enableFailIds.has(pluginId)) {
        throw new HelmxError('plugin_enable_failed_simulated', `simulated enable failed: ${pluginId}`, 500, { pluginId })
      }
      entry.enabled = true
      summaries.set(pluginId, { ...(summaries.get(pluginId) ?? { id: pluginId }), enabled: true })
      return toSummary(summaries, pluginId)
    },
    async updateManagedPlugin(pluginId: string) {
      hostCalls.push(`update:${pluginId}`)
      const entry = registered.get(pluginId)
      if (!entry) throw new HelmxError('unknown_plugin', `plugin not registered: ${pluginId}`, 404, { pluginId })
      summaries.set(pluginId, { id: pluginId, version: readPluginVersionFromDir(join(dataDir, 'installed-plugins', pluginId)), enabled: entry.enabled })
      return { summary: toSummary(summaries, pluginId) }
    },
    notifyManagedPluginChanged(pluginId: string) {
      hostCalls.push(`notify:${pluginId}`)
    },
    assertManagedPluginUpdateSafe(pluginId: string) {
      hostCalls.push(`assert-safe:${pluginId}`)
      const entry = registered.get(pluginId)
      if (!entry) throw new HelmxError('unknown_plugin', `plugin not registered: ${pluginId}`, 404, { pluginId })
      if (updateBlockedIds.has(pluginId)) {
        throw new HelmxError('plugin_has_live_tasks', `plugin ${pluginId} has active tasks; update swap rejected`, 409, { pluginId })
      }
    },
    async removeManagedPlugin(pluginId: string) {
      hostCalls.push(`remove:${pluginId}`)
      const entry = registered.get(pluginId)
      if (!entry) return { wasEnabled: false }
      registered.delete(pluginId)
      summaries.delete(pluginId)
      return { wasEnabled: entry.enabled }
    },
    async purgePluginPersistentData(pluginId: string) {
      hostCalls.push(`purge:${pluginId}`)
      if (purgeFailIds.has(pluginId)) {
        throw new HelmxError('store_flush_failed_simulated', `simulated purge failed: ${pluginId}`, 500, { pluginId })
      }
    },
    listSummaries: () => [...summaries.values()].map((s) => toSummary(summaries, s.id)),
    doctorDir: (dir) => doctorTestDir(dir),
    verifyPrebuiltDir: () => undefined,
    readClientDependencies: (dir) => readTestManifest(dir)?.clientDependencies ?? [],
    externalPluginsDir: (dir) => join(dir, 'installed-plugins'),
  }
  const manager = new PluginPackageManager({
    dataDir,
    cwd,
    store,
    host,
    ...(runner !== undefined ? { runner } : {}),
  })
  return {
    dataDir,
    cwd,
    store,
    host,
    manager,
    hostCalls,
    registered,
    updateBlockedIds,
    registerFailIds,
    enableFailIds,
    purgeFailIds,
    close() {
      rmSync(dataDir, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    },
  }
}

function readPluginIdFromDir(dir: string): string {
  const manifest = join(dir, 'plugin.json')
  if (existsSync(manifest)) {
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { id?: string }
    if (parsed.id !== undefined) return parsed.id
  }
  throw new Error('test plugin directory missing plugin.json id')
}

function readPluginVersionFromDir(dir: string): string {
  const manifest = join(dir, 'plugin.json')
  if (existsSync(manifest)) {
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string }
    if (parsed.version !== undefined) return parsed.version
  }
  return ''
}

function toSummary(summaries: Map<string, { id: string; version?: string; enabled: boolean }>, id: string) {
  const s = summaries.get(id) ?? { id, enabled: false }
  return {
    id: s.id,
    name: s.id,
    locked: false,
    enabled: s.enabled,
    hooks: [] as never[],
    actions: s.enabled ? ['ping'] : [],
    tools: [] as string[],
    ...(s.version !== undefined ? { version: s.version } : {}),
  }
}

/** Writes a minimal local plugin source directory (`plugin.json` + `index.mjs`). */
function writeLocalPlugin(parent: string, id: string, version = '0.1.0'): string {
  const dir = join(parent, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ id, version, main: 'index.mjs' }, null, 2))
  writeFileSync(join(dir, 'index.mjs'), PLUGIN_SRC(id, version))
  return dir
}

/** Fake runner: produces a full cloned repository layout on `git clone` (including `.git` to test exclusion). */
function gitCloneRunner(repoLayout: (repoDir: string) => void): PackageRunner {
  return async (cmd, args) => {
    if (cmd === 'git' && args[0] === 'clone') {
      const target = args[args.length - 1]
      if (typeof target !== 'string' || target.length === 0) {
        return { code: 1, stdout: '', stderr: 'fake runner: clone target missing' }
      }
      mkdirSync(target, { recursive: true })
      repoLayout(target)
      return { code: 0, stdout: '', stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
}

const FAIL_RUNNER: PackageRunner = async (_cmd, _args) => ({
  code: 1,
  stdout: '',
  stderr: 'simulated network failure\n' + 'x'.repeat(100),
})

// ---------------------------------------------------------------------------
// Local install / remove transactions & createPluginPackageManager
// ---------------------------------------------------------------------------

test('createPluginPackageManager: builds PluginPackageManagerPort with load/getRecord/listRecords/install/remove', { timeout: 60_000 }, async () => {
  const env = makeEnv()
  try {
    const src = writeLocalPlugin(env.cwd, 'factory-demo', '1.2.3')
    const manager = createPluginPackageManager({
      dataDir: env.dataDir,
      cwd: env.cwd,
      config: createJsonConfigPort(env.dataDir),
      host: env.host,
    })
    await manager.load()
    assert.deepEqual(manager.listRecords(), [])
    const installed = await manager.install(src, { enable: true })
    assert.equal(installed.record.pluginId, 'factory-demo')
    assert.equal(manager.getRecord('factory-demo')?.version, '1.2.3')
    assert.equal(manager.listRecords().length, 1)

    const reloaded = createPluginPackageManager({
      dataDir: env.dataDir,
      cwd: env.cwd,
      config: createJsonConfigPort(env.dataDir),
      host: env.host,
    })
    await reloaded.load()
    assert.equal(reloaded.getRecord('factory-demo')?.id, installed.record.id)

    await reloaded.remove('factory-demo')
    assert.equal(reloaded.getRecord('factory-demo'), undefined)
    assert.deepEqual(reloaded.listRecords(), [])
  } finally {
    env.close()
  }
})

test('local install copies into managed directory (non-symlink), persists record, and remove keeps user source intact', { timeout: 60_000 }, async () => {
  const env = makeEnv()
  try {
    const userSrcParent = mkdtempSync(join(tmpdir(), 'helmx-pkg-usersrc-'))
    const userSrc = writeLocalPlugin(userSrcParent, 'demo-local')
    writeFileSync(join(userSrc, 'user-notes.md'), 'user-owned file')

    const result = await env.manager.install(userSrc, { enable: true })
    assert.equal(result.record.pluginId, 'demo-local')
    assert.ok(result.record.source.kind === 'local')
    assert.equal(result.summary.enabled, true)
    assert.ok(result.summary.managed, 'summary should carry managed metadata')
    assert.equal(result.summary.managed?.installId, result.record.id)

    const managed = join(env.dataDir, 'installed-plugins', 'demo-local')
    assert.ok(existsSync(managed), 'managed directory should exist')
    assert.ok(existsSync(join(managed, 'index.mjs')))
    const config = JSON.parse(readFileSync(join(env.dataDir, 'config.json'), 'utf8')) as { pluginPackages: Record<string, unknown> }
    assert.ok(config.pluginPackages['demo-local'])

    const removed = await env.manager.remove('demo-local')
    assert.equal(removed.pluginId, 'demo-local')
    assert.equal(removed.wasEnabled, true)
    const removeAt = env.hostCalls.indexOf('remove:demo-local')
    const purgeAt = env.hostCalls.indexOf('purge:demo-local')
    assert.ok(removeAt >= 0, 'should call removeManagedPlugin')
    assert.ok(purgeAt > removeAt, 'should call purgePluginPersistentData after unregistering instance')
    assert.ok(!existsSync(managed), 'managed directory should be deleted')
    assert.ok(existsSync(join(userSrc, 'index.mjs')), 'user source directory must stay intact')
    assert.ok(existsSync(join(userSrc, 'user-notes.md')), 'user-owned files must stay intact')
    const after = JSON.parse(readFileSync(join(env.dataDir, 'config.json'), 'utf8')) as { pluginPackages?: Record<string, unknown> }
    assert.equal(after.pluginPackages?.['demo-local'], undefined, 'record should be deleted')
    rmSync(userSrcParent, { recursive: true, force: true })
  } finally {
    env.close()
  }
})

test('staging failure cleanup leaves zero artifacts after failed git clone', { timeout: 60_000 }, async () => {
  const env = makeEnv(FAIL_RUNNER)
  try {
    await assert.rejects(
      env.manager.install('git:github.com/user/broken-repo'),
      (err: unknown) => err instanceof HelmxError,
    )
    const staging = join(env.dataDir, 'installed-plugins', '.staging')
    if (existsSync(staging)) {
      assert.deepEqual(readdirSync(staging), [], 'staging must leave no residue')
    }
    assert.ok(!existsSync(join(env.dataDir, 'installed-plugins', 'broken-repo')), 'must not leave partial install directory')
  } finally {
    env.close()
  }
})

test('doctor failure prevents corrupt plugin from entering managed directory and cleans staging', { timeout: 60_000 }, async () => {
  const env = makeEnv()
  try {
    const badParent = mkdtempSync(join(tmpdir(), 'helmx-pkg-bad-'))
    const badDir = join(badParent, 'bad-plugin')
    mkdirSync(badDir, { recursive: true })
    writeFileSync(join(badDir, 'plugin.json'), JSON.stringify({ id: 'bad-plugin', main: 'index.ts' }))
    writeFileSync(join(badDir, 'index.ts'), 'export default { id: "bad-plugin", definePlugin() { throw new Error("boom") } }\n')
    await assert.rejects(
      env.manager.install(badDir),
      (err: unknown) => err instanceof HelmxError && err.code === 'plugin_package_doctor_failed',
    )
    assert.ok(!existsSync(join(env.dataDir, 'installed-plugins', 'bad-plugin')), 'broken plugin must not enter managed directory')
    const staging = join(env.dataDir, 'installed-plugins', '.staging')
    if (existsSync(staging)) assert.deepEqual(readdirSync(staging), [])
    rmSync(badParent, { recursive: true, force: true })
  } finally {
    env.close()
  }
})

test('git install: ref/subdirectory layout excludes node_modules and .git', { timeout: 60_000 }, async () => {
  const env = makeEnv(
    gitCloneRunner((repo) => {
      const sub = join(repo, 'packages', 'inner-plugin')
      mkdirSync(sub, { recursive: true })
      writeFileSync(join(sub, 'plugin.json'), JSON.stringify({ id: 'git-plugin', version: '1.0.0', main: 'index.mjs' }))
      writeFileSync(join(sub, 'index.mjs'), PLUGIN_SRC('git-plugin', '1.0.0'))
      mkdirSync(join(sub, 'node_modules', 'junk'), { recursive: true })
      writeFileSync(join(sub, 'node_modules', 'junk', 'x.js'), 'junk')
      mkdirSync(join(repo, '.git'), { recursive: true })
      writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main')
    }),
  )
  try {
    const result = await env.manager.install('git:github.com/user/mono@main#packages/inner-plugin')
    assert.equal(result.record.pluginId, 'git-plugin')
    assert.ok(result.record.source.kind === 'git')
    if (result.record.source.kind !== 'git') return
    assert.equal(result.record.source.repo, 'github.com/user/mono')
    assert.equal(result.record.source.ref, 'main')
    assert.equal(result.record.source.subdirectory, 'packages/inner-plugin')
    const managed = join(env.dataDir, 'installed-plugins', 'git-plugin')
    assert.ok(existsSync(join(managed, 'index.mjs')))
    assert.ok(!existsSync(join(managed, 'node_modules')), 'node_modules should be excluded')
    assert.ok(!existsSync(join(managed, '.git')), '.git should be excluded')
  } finally {
    env.close()
  }
})

test('update returns 404 without record and resyncs updated version from local source', { timeout: 60_000 }, async () => {
  const env = makeEnv()
  try {
    await assert.rejects(
      env.manager.update('never-installed'),
      (err: unknown) => err instanceof HelmxError && err.status === 404,
    )
    const userSrc = writeLocalPlugin(env.cwd, 'up-plugin', '1.0.0')
    const installed = await env.manager.install(userSrc)
    assert.equal(installed.record.version, '1.0.0')
    writeFileSync(join(userSrc, 'plugin.json'), JSON.stringify({ id: 'up-plugin', version: '2.0.0', main: 'index.mjs' }, null, 2))
    writeFileSync(join(userSrc, 'index.mjs'), PLUGIN_SRC('up-plugin', '2.0.0'))
    const updated = await env.manager.update('up-plugin')
    assert.equal(updated.record.version, '2.0.0')
    assert.equal(updated.previousVersion, '1.0.0')
    assert.equal(updated.changed, true)
    const managedManifest = JSON.parse(readFileSync(join(env.dataDir, 'installed-plugins', 'up-plugin', 'plugin.json'), 'utf8')) as { version: string }
    assert.equal(managedManifest.version, '2.0.0', 'managed directory should resync to new version')
  } finally {
    env.close()
  }
})

test('remove rejects explicitly when purge fails while keeping directory and record retryable', { timeout: 60_000 }, async () => {
  const env = makeEnv()
  try {
    const src = writeLocalPlugin(env.cwd, 'purge-fail-plugin')
    await env.manager.install(src)
    const managed = join(env.dataDir, 'installed-plugins', 'purge-fail-plugin')
    assert.ok(existsSync(managed), 'precondition: install directory exists')

    env.purgeFailIds.add('purge-fail-plugin')
    await assert.rejects(
      env.manager.remove('purge-fail-plugin'),
      (err: unknown) => err instanceof HelmxError && err.code === 'store_flush_failed_simulated',
    )
    assert.ok(existsSync(managed), 'managed directory must be preserved when purge fails')
    assert.ok(env.store.getRecord('purge-fail-plugin'), 'install record must be preserved when purge fails')
    assert.ok(!env.registered.has('purge-fail-plugin'), 'first attempt unregistered instance')

    env.purgeFailIds.delete('purge-fail-plugin')
    const removed = await env.manager.remove('purge-fail-plugin')
    assert.equal(removed.pluginId, 'purge-fail-plugin')
    assert.equal(removed.wasEnabled, false, 'wasEnabled is false on retry because instance was already unregistered')
    assert.ok(!existsSync(managed), 'managed directory deleted after successful retry')
    assert.equal(env.store.getRecord('purge-fail-plugin'), undefined, 'install record deleted after successful retry')
  } finally {
    env.close()
  }
})

test('remove protects builtin: and core: namespaces with 403 and rejects unmanaged plugins with 404 (update returns 404 for unmanaged/reserved IDs)', { timeout: 60_000 }, async () => {
  const env = makeEnv()
  try {
    await assert.rejects(
      env.manager.remove('builtin:mentions'),
      (err: unknown) => err instanceof HelmxError && err.code === 'plugin_locked' && err.status === 403,
    )
    await assert.rejects(
      env.manager.remove('core:conversations'),
      (err: unknown) => err instanceof HelmxError && err.code === 'plugin_locked' && err.status === 403,
    )
    await assert.rejects(
      env.manager.update('builtin:mentions'),
      (err: unknown) => err instanceof HelmxError && err.code === 'unknown_plugin_package' && err.status === 404,
    )
    await assert.rejects(
      env.manager.update('core:conversations'),
      (err: unknown) => err instanceof HelmxError && err.code === 'unknown_plugin_package' && err.status === 404,
    )
    await assert.rejects(
      env.manager.remove('hand-placed'),
      (err: unknown) => err instanceof HelmxError && err.status === 404,
    )
  } finally {
    env.close()
  }
})

test('path security rejects local self-install targeting inside the managed tree', { timeout: 60_000 }, async () => {
  const env = makeEnv()
  try {
    const inside = join(env.dataDir, 'installed-plugins', 'inside-plugin')
    mkdirSync(inside, { recursive: true })
    writeFileSync(join(inside, 'plugin.json'), JSON.stringify({ id: 'inside-plugin', main: 'index.mjs' }))
    writeFileSync(join(inside, 'index.mjs'), PLUGIN_SRC('inside-plugin'))
    await assert.rejects(
      env.manager.install(inside),
      (err: unknown) => err instanceof HelmxError && err.status === 400,
    )
  } finally {
    env.close()
  }
})

test('update safety preflight rejects 409 on active tasks without modifying existing directory contents', { timeout: 60_000 }, async () => {
  const env = makeEnv()
  try {
    const userSrc = writeLocalPlugin(env.cwd, 'busy-plugin', '1.0.0')
    const installed = await env.manager.install(userSrc)
    assert.equal(installed.record.version, '1.0.0')
    const managed = join(env.dataDir, 'installed-plugins', 'busy-plugin')
    const manifestBefore = readFileSync(join(managed, 'plugin.json'), 'utf8')
    writeFileSync(join(userSrc, 'plugin.json'), JSON.stringify({ id: 'busy-plugin', version: '2.0.0', main: 'index.mjs' }, null, 2))
    env.updateBlockedIds.add('busy-plugin')
    await assert.rejects(
      env.manager.update('busy-plugin'),
      (err: unknown) => err instanceof HelmxError && err.status === 409,
    )
    assert.ok(env.hostCalls.includes('assert-safe:busy-plugin'), 'should run safety preflight')
    assert.equal(readFileSync(join(managed, 'plugin.json'), 'utf8'), manifestBefore, 'old directory contents must remain completely unchanged')
    assert.ok(!env.hostCalls.includes('update:busy-plugin'), 'must not enter reload swap')
    env.updateBlockedIds.delete('busy-plugin')
    const updated = await env.manager.update('busy-plugin')
    assert.equal(updated.record.version, '2.0.0')
  } finally {
    env.close()
  }
})

test('runtime dependencies install in staging before doctor passes for local plugins with package.json', { timeout: 60_000 }, async () => {
  const depsInstalled: string[] = []
  const runner: PackageRunner = async (cmd, args, opts) => {
    if (cmd === 'npm' && args[0] === 'install') {
      depsInstalled.push(opts.cwd)
      mkdirSync(join(opts.cwd, 'node_modules'), { recursive: true })
      return { code: 0, stdout: '', stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  const env = makeEnv(runner)
  try {
    const srcParent = mkdtempSync(join(tmpdir(), 'helmx-pkg-deps-'))
    const src = join(srcParent, 'deps-plugin')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'plugin.json'), JSON.stringify({ id: 'deps-plugin', version: '0.1.0', main: 'index.mjs' }))
    writeFileSync(join(src, 'index.mjs'), PLUGIN_SRC('deps-plugin'))
    writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'deps-plugin', version: '0.1.0', main: 'index.mjs', dependencies: { leftpad: '^1.0.0' } }))
    const result = await env.manager.install(src)
    assert.equal(result.record.pluginId, 'deps-plugin')
    assert.equal(depsInstalled.length, 1, 'install should execute npm install exactly once')
    assert.ok(depsInstalled[0]!.includes('.staging'), 'dependency install must happen inside staging')
    assert.ok(!existsSync(join(src, 'node_modules')), 'user source directory must not have dependencies installed into it')
    assert.ok(existsSync(join(env.dataDir, 'installed-plugins', 'deps-plugin', 'node_modules')), 'managed directory should contain installed dependencies')
    rmSync(srcParent, { recursive: true, force: true })
  } finally {
    env.close()
  }
})

test('install transaction rolls back and deletes newly copied target directory when registration fails', { timeout: 60_000 }, async () => {
  const env = makeEnv()
  try {
    const src = writeLocalPlugin(env.cwd, 'rollback-plugin')
    env.registerFailIds.add('rollback-plugin')
    await assert.rejects(
      env.manager.install(src),
      (err: unknown) =>
        err instanceof HelmxError &&
        err.code === 'plugin_package_install_failed' &&
        (err.details as { rolledBack?: boolean } | undefined)?.rolledBack === true,
    )
    const target = join(env.dataDir, 'installed-plugins', 'rollback-plugin')
    assert.ok(!existsSync(target), 'newly copied target must be deleted after registration fails')
    assert.ok(!env.registered.has('rollback-plugin'), 'must leave no registered instance')
    assert.equal(env.store.getRecord('rollback-plugin'), undefined, 'must leave no leftover record')
    env.registerFailIds.delete('rollback-plugin')
    const ok = await env.manager.install(src)
    assert.equal(ok.record.pluginId, 'rollback-plugin')
  } finally {
    env.close()
  }
})

test('honest update rollback: failed restore reload no longer falsely reports old version active', { timeout: 60_000 }, async () => {
  const env = makeEnv()
  let updateCalls = 0
  env.host.updateManagedPlugin = async (pluginId: string) => {
    updateCalls += 1
    throw new HelmxError('plugin_reload_failed_simulated', `simulated reload failed #${updateCalls}`, 500, { pluginId })
  }
  try {
    const userSrc = writeLocalPlugin(env.cwd, 'honest-rollback', '1.0.0')
    await env.manager.install(userSrc)
    writeFileSync(join(userSrc, 'plugin.json'), JSON.stringify({ id: 'honest-rollback', version: '2.0.0', main: 'index.mjs' }, null, 2))
    writeFileSync(join(userSrc, 'index.mjs'), PLUGIN_SRC('honest-rollback', '2.0.0'))

    const err = (await assertRejectsCode(() => env.manager.update('honest-rollback'), 'plugin_package_update_failed', 500)) as HelmxError
    const details = err.details as { rolledBack?: boolean; rollbackError?: { message: string } }
    assert.equal(details.rolledBack, false, 'failed restore reload must report rolledBack:false')
    assert.match(err.message, /previous directory restored, but reloading the previous plugin instance failed/, 'error message must clarify directory restored while instance did not')
    assert.equal(updateCalls, 2, 'rollback path must genuinely attempt restore reload')
    const manifest = JSON.parse(readFileSync(join(env.dataDir, 'installed-plugins', 'honest-rollback', 'plugin.json'), 'utf8')) as { version: string }
    assert.equal(manifest.version, '1.0.0')
  } finally {
    env.close()
  }
})

test('successful update rollback path: restore reload success still reports rolledBack:true', { timeout: 60_000 }, async () => {
  const env = makeEnv()
  const original = env.host.updateManagedPlugin
  let calls = 0
  env.host.updateManagedPlugin = async (pluginId: string, dir: string, options: { keepEnabled: boolean }) => {
    calls += 1
    if (calls === 1) throw new HelmxError('plugin_reload_failed_simulated', 'first reload failed', 500, { pluginId })
    return original(pluginId, dir, options)
  }
  try {
    const userSrc = writeLocalPlugin(env.cwd, 'ok-rollback', '1.0.0')
    await env.manager.install(userSrc)
    writeFileSync(join(userSrc, 'plugin.json'), JSON.stringify({ id: 'ok-rollback', version: '2.0.0', main: 'index.mjs' }, null, 2))
    writeFileSync(join(userSrc, 'index.mjs'), PLUGIN_SRC('ok-rollback', '2.0.0'))
    const err = (await assertRejectsCode(() => env.manager.update('ok-rollback'), 'plugin_package_update_failed', 500)) as HelmxError
    assert.equal((err.details as { rolledBack?: boolean }).rolledBack, true)
    assert.match(err.message, /rolled back to previous directory and instance/)
  } finally {
    env.close()
  }
})

test('install record save fails and rollback deregister fails: keeps directory and instance, rolledBack:false', { timeout: 60_000 }, async () => {
  const env = makeEnv()
  env.host.removeManagedPlugin = async () => {
    throw new HelmxError('plugin_has_live_tasks', 'simulated live task blocks removal', 409, { pluginId: 'keep-dir' })
  }
  try {
    const userSrc = writeLocalPlugin(env.cwd, 'keep-dir', '1.0.0')
    env.store.failNextSave = true
    const err = (await assertRejectsCode(() => env.manager.install(userSrc, { enable: true }), 'plugin_package_install_failed', 500)) as HelmxError
    const details = err.details as { rolledBack?: boolean; rollbackError?: { message: string } }
    assert.equal(details.rolledBack, false, 'failed rollback deregister must report rolledBack:false')
    assert.match(err.message, /directory and instance preserved for manual recovery/, 'error message must warn that state remains preserved for manual handling')
    const target = join(env.dataDir, 'installed-plugins', 'keep-dir')
    assert.ok(existsSync(join(target, 'index.mjs')), 'must not rm directory backing a live registered instance')
    assert.ok(!env.store.getRecord('keep-dir'), 'install record not persisted')
  } finally {
    env.close()
  }
})

test('install register fails due to concurrent same-name instance: preserves directory for that instance, rolledBack:false', { timeout: 60_000 }, async () => {
  const env = makeEnv()
  let registerAttempted = false
  env.host.registerManagedPlugin = async (dir: string) => {
    const manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')) as { id: string }
    registerAttempted = true
    throw new HelmxError('plugin_already_registered', `plugin already registered: ${manifest.id}`, 409, { pluginId: manifest.id })
  }
  const originalList = env.host.listSummaries.bind(env.host)
  env.host.listSummaries = () => {
    const base = originalList()
    return registerAttempted && !base.some((s) => s.id === 'raced-plugin')
      ? [...base, toSummary(new Map([['raced-plugin', { id: 'raced-plugin', enabled: true }]]), 'raced-plugin')]
      : base
  }
  try {
    const userSrc = writeLocalPlugin(env.cwd, 'raced-plugin', '1.0.0')
    const err = (await assertRejectsCode(() => env.manager.install(userSrc), 'plugin_package_install_failed', 500)) as HelmxError
    const details = err.details as { rolledBack?: boolean }
    assert.equal(details.rolledBack, false)
    assert.match(err.message, /same name plugin registered/)
    const target = join(env.dataDir, 'installed-plugins', 'raced-plugin')
    assert.ok(existsSync(join(target, 'index.mjs')), 'directory must remain intact for concurrently registered instance')
  } finally {
    env.close()
  }
})

test('install: same canonical local source hot-updates idempotently; different source / unmanaged / occupied return 409', { timeout: 60_000 }, async () => {
  const env = makeEnv()
  try {
    const src = writeLocalPlugin(env.cwd, 'dup-plugin', '1.0.0')
    const first = await env.manager.install(src, { enable: false })
    assert.equal(first.summary.enabled, false)
    assert.equal(first.record.version, '1.0.0')

    writeLocalPlugin(env.cwd, 'dup-plugin', '1.1.0')
    const second = await env.manager.install(src, { enable: false })
    assert.equal(second.record.id, first.record.id, 'reinstall preserves record id')
    assert.equal(second.record.installedAt, first.record.installedAt, 'reinstall preserves installedAt')
    assert.equal(second.record.version, '1.1.0')
    assert.equal(second.summary.version, '1.1.0')
    assert.equal(second.summary.enabled, false, 'explicit enable: false does not force-enable')

    writeLocalPlugin(env.cwd, 'dup-plugin', '1.2.0')
    const aliasLink = join(env.cwd, 'dup-plugin-link')
    symlinkSync(src, aliasLink)
    const third = await env.manager.install(aliasLink)
    assert.equal(third.record.id, first.record.id)
    assert.equal(third.record.version, '1.2.0')
    assert.equal(third.summary.version, '1.2.0')
    assert.equal(third.summary.enabled, true, 'same canonical local source reinstall ensures enabled when enable !== false')

    const src2 = writeLocalPlugin(join(env.cwd, 'alt'), 'dup-plugin', '2.0.0')
    await assert.rejects(
      env.manager.install(src2),
      (err: unknown) => err instanceof HelmxError && err.code === 'plugin_package_already_installed' && err.status === 409,
    )

    const manualSrc = writeLocalPlugin(env.cwd, 'manual-plugin', '1.0.0')
    await env.host.registerManagedPlugin(manualSrc, { enabled: true })
    await assert.rejects(
      env.manager.install(manualSrc),
      (err: unknown) => err instanceof HelmxError && err.code === 'plugin_package_already_installed' && err.status === 409,
    )

    const occupied = join(env.dataDir, 'installed-plugins', 'occupied-plugin')
    mkdirSync(occupied, { recursive: true })
    writeFileSync(join(occupied, 'stale.txt'), 'residue')
    const src3 = writeLocalPlugin(env.cwd, 'occupied-plugin')
    await assert.rejects(
      env.manager.install(src3),
      (err: unknown) => err instanceof HelmxError && err.code === 'plugin_package_target_occupied' && err.status === 409,
    )
    assert.equal(readFileSync(join(occupied, 'stale.txt'), 'utf8'), 'residue', 'pre-existing directory must not be deleted')
  } finally {
    env.close()
  }
})

test('install when enable fails keeps plugin disabled, reports enableError, and recovers on same-source reinstall', { timeout: 60_000 }, async () => {
  const env = makeEnv()
  try {
    const src = writeLocalPlugin(env.cwd, 'enablefail-plugin', '1.0.0')
    env.enableFailIds.add('enablefail-plugin')
    const result = await env.manager.install(src, { enable: true })
    assert.equal(result.record.pluginId, 'enablefail-plugin')
    assert.equal(result.summary.enabled, false, 'plugin must remain disabled when enable fails')
    assert.ok(result.enableError, 'enableError must pass through')
    assert.equal(result.enableError.code, 'plugin_enable_failed_simulated')

    const reloaded = new PluginPackageManagerStore(createJsonConfigPort(env.dataDir))
    await reloaded.load()
    const record = reloaded.getRecord('enablefail-plugin')
    assert.ok(record, 'enable failure does not prevent persisting record across restarts')
    assert.equal(record.source.kind, 'local')

    env.enableFailIds.delete('enablefail-plugin')
    writeLocalPlugin(env.cwd, 'enablefail-plugin', '1.1.0')
    const recovered = await env.manager.install(src)
    assert.equal(recovered.record.version, '1.1.0')
    assert.equal(recovered.summary.enabled, true)
    assert.equal(recovered.enableError, undefined)

    const otherSrc = writeLocalPlugin(join(env.cwd, 'other'), 'enablefail-plugin', '2.0.0')
    await assert.rejects(
      env.manager.install(otherSrc),
      (err: unknown) => err instanceof HelmxError && err.code === 'plugin_package_already_installed' && err.status === 409,
    )
  } finally {
    env.close()
  }
})

// ---------------------------------------------------------------------------
// Package record store: corrupt state rejected explicitly; restart recovery
// ---------------------------------------------------------------------------

test('store: corrupt pluginPackages throws config_corrupt explicitly; update save preserves existing id', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helmx-pkg-store-'))
  try {
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ pluginPackages: 'not-an-object' }))
    const store = new PluginPackageManagerStore(createJsonConfigPort(dataDir))
    await assert.rejects(store.load(), (err: unknown) => err instanceof HelmxError && err.code === 'config_corrupt')

    rmSync(join(dataDir, 'config.json'))
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ pluginPackages: { 'p-1': { id: 'plugpkg-p-1', pluginId: 'p-1', source: { kind: 'local', raw: '/x', path: '/x' }, installPath: '/data/installed-plugins/p-1', version: '1.0.0', installedAt: 1, updatedAt: 1 } } }))
    const store2 = new PluginPackageManagerStore(createJsonConfigPort(dataDir))
    await store2.load()
    assert.equal(store2.getRecord('p-1')?.id, 'plugpkg-p-1')
    const saved = await store2.save({ pluginId: 'p-1', source: { kind: 'local', raw: '/x', path: '/x' }, installPath: '/data/installed-plugins/p-1', version: '1.1.0', installedAt: 1, updatedAt: 2 })
    assert.equal(saved.id, 'plugpkg-p-1', 're-save preserves existing record id')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Controlled package runner: Windows npm resolution, output cap, process-tree timeout
// ---------------------------------------------------------------------------

test('createPackageRunner: routes npm through resolveNpmCommand (Windows-safe), caps output tail, and kills process tree on timeout', { timeout: 60_000 }, async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'helmx-pkg-runner-'))
  try {
    const fakeNpmCli = join(workDir, 'fake-npm-cli.cjs')
    writeFileSync(
      fakeNpmCli,
      "process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), ignoreScripts: process.env.npm_config_ignore_scripts }));\n",
      'utf8',
    )
    let resolveCalls = 0
    const runner = createPackageRunner(() => {
      resolveCalls += 1
      return { command: process.execPath, args: [fakeNpmCli] }
    })

    const npmRes = await runner('npm', ['pack', 'demo@1.0.0'], { cwd: workDir, timeoutMs: 10_000 })
    assert.equal(resolveCalls, 1, 'npm invocation must delegate to resolveNpmCommand')
    assert.equal(npmRes.code, 0)
    assert.equal(npmRes.timedOut, false)
    assert.deepEqual(JSON.parse(npmRes.stdout), { argv: ['pack', 'demo@1.0.0'], ignoreScripts: 'true' })

    const noisyRes = await runner(
      process.execPath,
      ['-e', "process.stdout.write('X'.repeat(5000) + 'END_OUT'); process.stderr.write('Y'.repeat(5000) + 'END_ERR');"],
      { cwd: workDir, timeoutMs: 10_000, maxOutputChars: 48 },
    )
    assert.equal(resolveCalls, 1, 'non-npm commands must not invoke resolveNpmCommand')
    assert.equal(noisyRes.code, 0)
    assert.equal(noisyRes.stdoutTruncated, true)
    assert.equal(noisyRes.stderrTruncated, true)
    assert.equal(noisyRes.stdout.length, 48)
    assert.equal(noisyRes.stderr.length, 48)
    assert.ok(noisyRes.stdout.endsWith('END_OUT'))
    assert.ok(noisyRes.stderr.endsWith('END_ERR'))

    if (process.platform !== 'win32') {
      const grandPidFile = join(workDir, 'grand.pid')
      const hangingCli = join(workDir, 'hang-npm-cli.cjs')
      writeFileSync(
        hangingCli,
        [
          "const fs = require('node:fs');",
          "const { spawn } = require('node:child_process');",
          "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] });",
          `fs.writeFileSync(${JSON.stringify(grandPidFile)}, String(g.pid));`,
          "process.stderr.write('HANG_START\\n');",
          'setInterval(() => {}, 1000);',
        ].join('\n'),
        'utf8',
      )
      const timeoutRunner = createPackageRunner(() => ({ command: process.execPath, args: [hangingCli] }))
      const env = makeEnv(timeoutRunner)
      try {
        const mgr = new PluginPackageManager({
          dataDir: env.dataDir,
          cwd: env.cwd,
          store: env.store,
          host: env.host,
          runner: timeoutRunner,
          commandTimeoutMs: 3_000,
        })
        await assert.rejects(
          mgr.install('npm:hanging-plugin'),
          (err: unknown) =>
            err instanceof HelmxError &&
            err.code === 'plugin_package_install_failed' &&
            err.message.includes('timed out') &&
            (err.details as { timedOut?: boolean } | undefined)?.timedOut === true,
        )
        const rawPid = existsSync(grandPidFile) ? readFileSync(grandPidFile, 'utf8').trim() : ''
        const grandPid = Number(rawPid)
        assert.ok(Number.isInteger(grandPid) && grandPid > 0, `grandchild pid should be recorded before timeout (got ${JSON.stringify(rawPid)})`)
        let alive = true
        for (let i = 0; i < 20 && alive; i += 1) {
          try {
            process.kill(grandPid, 0)
            await new Promise((r) => setTimeout(r, 50))
          } catch {
            alive = false
          }
        }
        assert.equal(alive, false, 'timed-out npm install descendant must be killed cleanly')
      } finally {
        env.close()
      }
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
})

test('install, local reinstall, and update notify host after record persistence; unchanged source skips reload with changed:false', { timeout: 60_000 }, async () => {
  const env = makeEnv()
  const observedOnNotify: Array<{ id: string; version?: string; sourceRaw?: string }> = []
  const origNotify = env.host.notifyManagedPluginChanged.bind(env.host)
  env.host.notifyManagedPluginChanged = (pluginId: string) => {
    const rec = env.store.getRecord(pluginId)
    observedOnNotify.push({ id: pluginId, version: rec?.version, sourceRaw: rec?.source.raw })
    origNotify(pluginId)
  }
  try {
    const userSrc = writeLocalPlugin(env.cwd, 'notify-plugin', '1.0.0')
    const installed = await env.manager.install(userSrc, { enable: true })
    assert.equal(installed.record.version, '1.0.0')
    assert.deepEqual(observedOnNotify.at(-1), { id: 'notify-plugin', version: '1.0.0', sourceRaw: userSrc })
    assert.ok(env.hostCalls.includes('notify:notify-plugin'))

    writeLocalPlugin(env.cwd, 'notify-plugin', '1.1.0')
    await env.manager.install(userSrc)
    assert.deepEqual(observedOnNotify.at(-1), { id: 'notify-plugin', version: '1.1.0', sourceRaw: userSrc })

    const callsBeforeNoop = env.hostCalls.length
    const notifyCountBeforeNoop = observedOnNotify.length
    const recordBeforeNoop = env.store.getRecord('notify-plugin')!
    const noop = await env.manager.update('notify-plugin')
    assert.equal(noop.changed, false)
    assert.equal(noop.previousVersion, '1.1.0')
    assert.equal(noop.record.updatedAt, recordBeforeNoop.updatedAt)
    assert.ok(!env.hostCalls.slice(callsBeforeNoop).includes('update:notify-plugin'), 'unchanged update must skip reload')
    assert.equal(observedOnNotify.length, notifyCountBeforeNoop)

    writeFileSync(join(userSrc, 'index.mjs'), `${PLUGIN_SRC('notify-plugin', '1.1.0')}\n// code edited\n`)
    const codeEdited = await env.manager.update('notify-plugin')
    assert.equal(codeEdited.changed, true)
    assert.ok(env.hostCalls.slice(callsBeforeNoop).includes('update:notify-plugin'), 'edited files must trigger reload')
    assert.deepEqual(observedOnNotify.at(-1), { id: 'notify-plugin', version: '1.1.0', sourceRaw: userSrc })

    const nextSrc = writeLocalPlugin(join(env.cwd, 'next'), 'notify-plugin', '2.0.0')
    const switched = await env.manager.update('notify-plugin', { source: nextSrc })
    assert.equal(switched.changed, true)
    assert.equal(switched.previousVersion, '1.1.0')
    assert.equal(switched.record.version, '2.0.0')
    assert.equal(switched.record.source.kind, 'local')
    if (switched.record.source.kind === 'local') {
      assert.equal(switched.record.source.path, nextSrc)
    }
    assert.deepEqual(observedOnNotify.at(-1), { id: 'notify-plugin', version: '2.0.0', sourceRaw: nextSrc })

    const otherSrc = writeLocalPlugin(join(env.cwd, 'wrong'), 'other-id', '1.0.0')
    await assertRejectsCode(() => env.manager.update('notify-plugin', { source: otherSrc }), 'plugin_package_id_changed', 409)
    await assertRejectsCode(() => env.manager.update('notify-plugin', { source: 'file:///bad' }), 'validation_error', 400)
  } finally {
    env.close()
  }
})

test('install rejects local source missing explicit manifest (plugin.json or package.json#helmx) and isolates code under installed-plugins', { timeout: 60_000 }, async () => {
  const env = makeEnv()
  try {
    const manifestless = join(env.cwd, 'no-manifest')
    mkdirSync(manifestless, { recursive: true })
    writeFileSync(join(manifestless, 'index.mjs'), PLUGIN_SRC('no-manifest'))
    await assert.rejects(
      env.manager.install(manifestless),
      (err: unknown) => err instanceof HelmxError && err.code === 'plugin_package_doctor_failed',
    )
    assert.ok(!existsSync(join(env.dataDir, 'installed-plugins', 'no-manifest')))
    assert.ok(!existsSync(join(env.dataDir, 'plugins', 'no-manifest')))
  } finally {
    env.close()
  }
})

test('npm install passes "--" before spec, strips tarball symlinks/dotfiles/node_modules, and runs doctorDir once per install/update', { timeout: 60_000 }, async () => {
  const { cpSync } = await import('node:fs')
  const scratch = mkdtempSync(join(tmpdir(), 'helmx-npm-tar-'))
  const packCalls: string[][] = []
  const rawDir = join(scratch, 'tar-src')
  const pkgDir = join(rawDir, 'package')
  mkdirSync(join(pkgDir, '.git'), { recursive: true })
  mkdirSync(join(pkgDir, 'node_modules', 'junk'), { recursive: true })
  writeFileSync(join(pkgDir, 'plugin.json'), JSON.stringify({ id: 'tar-plugin', version: '1.0.0', main: 'index.mjs' }))
  writeFileSync(join(pkgDir, 'index.mjs'), PLUGIN_SRC('tar-plugin', '1.0.0'))
  writeFileSync(join(pkgDir, '.git', 'config'), 'secret')
  writeFileSync(join(pkgDir, 'node_modules', 'junk', 'x.js'), 'junk')
  symlinkSync('/etc/passwd', join(pkgDir, 'evil-link'))

  const runner: PackageRunner = async (cmd, args, opts) => {
    if (cmd === 'npm' && args[0] === 'pack') {
      packCalls.push(args)
      const destIdx = args.indexOf('--pack-destination')
      const destDir = destIdx >= 0 ? args[destIdx + 1]! : opts.cwd
      writeFileSync(join(destDir, 'tar-plugin-1.0.0.tgz'), 'fake-tgz')
      return { code: 0, stdout: 'tar-plugin-1.0.0.tgz\n', stderr: '' }
    }
    if (cmd === 'tar') {
      const cIdx = args.indexOf('-C')
      const targetExtract = args[cIdx + 1]!
      cpSync(rawDir, targetExtract, { recursive: true, verbatimSymlinks: true })
      return { code: 0, stdout: '', stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  const env = makeEnv(runner)
  let doctorCalls = 0
  const origDoctor = env.host.doctorDir.bind(env.host)
  env.host.doctorDir = async (dir, opts) => {
    doctorCalls += 1
    return origDoctor(dir, opts)
  }
  try {
    const installed = await env.manager.install('npm:tar-plugin@^1.0.0')
    assert.equal(installed.record.pluginId, 'tar-plugin')
    assert.equal(doctorCalls, 1, 'install must run doctorDir only once')
    const packArgs = packCalls[0]!
    const sepIdx = packArgs.indexOf('--')
    assert.ok(sepIdx >= 0 && packArgs[sepIdx + 1] === 'tar-plugin@^1.0.0', 'npm pack must pass -- before spec')
    const managed = join(env.dataDir, 'installed-plugins', 'tar-plugin')
    assert.equal(existsSync(join(managed, 'evil-link')), false, 'symlink in npm tarball must be stripped')
    assert.equal(existsSync(join(managed, '.git')), false, '.git in npm tarball must be stripped')
    assert.equal(existsSync(join(managed, 'node_modules')), false, 'node_modules in npm tarball must be stripped')

    doctorCalls = 0
    const src = writeLocalPlugin(env.cwd, 'tar-plugin', '1.1.0')
    await env.manager.update('tar-plugin', { source: src })
    assert.equal(doctorCalls, 1, 'update must run doctorDir only once')
  } finally {
    env.close()
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('local reinstall rolls back when store.save fails; installRuntimeDeps rejects corrupt package.json; update errors label update stage', { timeout: 60_000 }, async () => {
  const env = makeEnv()
  try {
    const src = writeLocalPlugin(env.cwd, 'reinstall-rb', '1.0.0')
    await env.manager.install(src, { enable: true })
    writeLocalPlugin(env.cwd, 'reinstall-rb', '2.0.0')
    env.store.failNextSave = true
    const err = (await assertRejectsCode(() => env.manager.install(src), 'plugin_package_update_failed', 500)) as HelmxError
    assert.equal((err.details as { rolledBack?: boolean }).rolledBack, true, 'store.save failure during local reinstall must roll back')
    const manifestAfter = JSON.parse(readFileSync(join(env.dataDir, 'installed-plugins', 'reinstall-rb', 'plugin.json'), 'utf8')) as { version: string }
    assert.equal(manifestAfter.version, '1.0.0')

    // Corrupt package.json in staging fails with typed HelmxError instead of raw SyntaxError.
    const badPkgSrc = writeLocalPlugin(env.cwd, 'bad-pkg-json', '1.0.0')
    writeFileSync(join(badPkgSrc, 'package.json'), '{not-json')
    await assertRejectsCode(() => env.manager.install(badPkgSrc), 'plugin_package_install_failed', 422)
  } finally {
    env.close()
  }

  // Update stage runner failure must report plugin_package_update_failed (not install).
  const envFailUpdate = makeEnv(gitCloneRunner((repo) => {
    writeFileSync(join(repo, 'plugin.json'), JSON.stringify({ id: 'git-stage-test', version: '1.0.0', main: 'index.mjs' }))
    writeFileSync(join(repo, 'index.mjs'), PLUGIN_SRC('git-stage-test', '1.0.0'))
  }))
  try {
    await envFailUpdate.manager.install('git:github.com/u/r')
    const failingMgr = new PluginPackageManager({
      dataDir: envFailUpdate.dataDir,
      cwd: envFailUpdate.cwd,
      store: envFailUpdate.store,
      host: envFailUpdate.host,
      runner: FAIL_RUNNER,
    })
    await assertRejectsCode(() => failingMgr.update('git-stage-test'), 'plugin_package_update_failed', 500)
  } finally {
    envFailUpdate.close()
  }
})

test('store: assertSourceShape rejects non-string fields, delete throws config_corrupt on corrupt record, load clears mirror when undefined', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helmx-pkg-store-hard-'))
  try {
    const cfgPort = createJsonConfigPort(dataDir)
    // 1. Non-string source fields must throw config_corrupt instead of coercing via String().
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
      pluginPackages: {
        'p-bad-raw': {
          id: 'plugpkg-p-bad-raw',
          pluginId: 'p-bad-raw',
          source: { kind: 'npm', raw: 12345, spec: 'foo' },
          installPath: '/data/installed-plugins/p-bad-raw',
          version: '1.0.0',
          installedAt: 1,
          updatedAt: 1,
        },
      },
    }))
    const store1 = new PluginPackageManagerStore(cfgPort)
    await assertRejectsCode(() => store1.load(), 'config_corrupt', 500)

    // 2. delete() on corrupt non-object record throws 500 config_corrupt instead of 404.
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
      pluginPackages: {
        'p-corrupt': 'not-an-object',
      },
    }))
    const store2 = new PluginPackageManagerStore(cfgPort)
    await assertRejectsCode(() => store2.delete('p-corrupt'), 'config_corrupt', 500)

    // 3. load() clears mirror when pluginPackages becomes undefined.
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
      pluginPackages: {
        'p-ok': {
          id: 'plugpkg-p-ok',
          pluginId: 'p-ok',
          source: { kind: 'local', raw: '/x', path: '/x' },
          installPath: '/data/installed-plugins/p-ok',
          version: '1.0.0',
          installedAt: 1,
          updatedAt: 1,
        },
      },
    }))
    await store2.load()
    assert.equal(store2.listRecords().length, 1)
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({}))
    await store2.load()
    assert.equal(store2.listRecords().length, 0, 'load() must clear mirror when pluginPackages is undefined')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})
