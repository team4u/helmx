/**
 * Deterministic regression tests for plugin lifecycle races (independent of sleep timing):
 *
 * 1. `enable` commit point occurs after toggle persistence succeeds: while pending, the service is
 *    already started, yet actions reject, hooks never run, and UI stays hidden; once persisted,
 *    everything becomes available. If persistence fails, there are zero in-flight tasks and rollback
 *    is clean (controlled via a deferred gate in store `setEnabled`).
 * 2. Registration parses the persisted enabled state before acquiring any assets: when `getEnabled`
 *    throws (preserving the original error) or returns a non-boolean value (explicitly rejected),
 *    registry, hooks, managed assets, and plugin data directory have zero leftover state.
 * 3. `HelmxPluginConfigStore` read-modify-write runs entirely inside the `ConfigService.update`
 *    file-lock callback: it mutates only its own nested key without clobbering keys updated
 *    concurrently by other modules (verified deterministically by interposing writes at `updateBy`
 *    entry — waiting outside the lock and performing no second read inside, avoiding deadlock);
 *    writing while `pluginEnabled` or `plugins` is corrupt fails explicitly with `config_corrupt`
 *    and never rebuilds with `{}`.
 *
 * runner: tsx --test; explicit timeout: 60_000 per test to guard against deadlocks.
 */
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigService, CredentialService } from '../src/services/index.js';
import { HelmxPluginConfigStore } from '../src/runtime/plugin-config-store.js';
import { HelmxError, type PluginDefinition } from '@helmx/protocol';
import {
  PluginHost,
  type PluginConfigStore,
  type PluginHostBackend,
} from '../src/plugins/index.js';
import { createPluginHostBackendFixture } from './helpers/plugin-host-backend.js';
import { pluginDataDirName } from '../src/plugins/plugin-dir-name.js';
import { createPluginBuildProvider } from '@helmx/plugin-build';
import {
  MemoryDocStore,
  assertRejectsCode,
  cleanupDir,
  deferred,
  makeConversationSummary,
  makeTempDir,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

function makeConversation(id: number) {
  return makeConversationSummary({ id, profileId: 'default' });
}

function makeHostApi(events: string[]): PluginHostBackend {
  return {
    ...createPluginHostBackendFixture(),
    dispatchTrigger: async () => {},
    submitInput: async () => {},
    createConversation: async (init) => ({ ...makeConversation(42), title: init.title ?? 'new' }),
    listConversations: () => [makeConversation(1)],
    getConversation: (id) => makeConversation(id),
    updateConversation: async (id) => makeConversation(id),
    manageConversation: (id, pluginId) => {
      events.push(`manage:${pluginId}:${id}`);
      return () => events.push(`release:${pluginId}:${id}`);
    },
    markConversationOwnership: () => {},
    createAsk: async () => ({ id: 'ask-1', status: 'answered' as const, answers: {} }),
    cancelAsk: async () => {},
    onEvent: () => () => {},
    abortConversation: async () => {},
    getConversationOwnership(): 'helmx' | 'human' {
      return 'human'
    },
    spawnAgent: async () => ({}),
    runGate: async () => ({ ok: true, output: '' }),
    execEnv: async () => { throw new HelmxError('unsupported', 'this fixture does not execute node commands', 501) },
    emitEvent: (type) => {
      events.push(`event:${type}`);
    },
  };
}

/**
 * Gated toggle persistence store: invokes `onSetEnabled` before committing the toggle,
 * allowing tests to construct a deterministic persistence suspension window without sleeps.
 */
class GatedStore implements PluginConfigStore {
  enabled = new Map<string, boolean>();
  configs = new Map<string, Record<string, unknown>>();
  onSetEnabled: (pluginId: string, enabled: boolean) => Promise<void> | void = () => {};
  get(pluginId: string): Record<string, unknown> {
    return { ...(this.configs.get(pluginId) ?? {}) };
  }
  set(pluginId: string, value: Record<string, unknown>): void {
    this.configs.set(pluginId, { ...value });
  }
  getEnabled(pluginId: string): boolean | undefined {
    return this.enabled.get(pluginId);
  }
  async setEnabled(pluginId: string, on: boolean): Promise<void> {
    await this.onSetEnabled(pluginId, on);
    this.enabled.set(pluginId, on);
  }
}

/** Factory for a plugin declaring the full surface (UI / action / hook / service / managed asset). */
function fullPlugin(id: string, marks: string[]): PluginDefinition {
  return {
    id,
    definePlugin: (ctx) => {
      ctx.configSchema({ endpoint: { type: 'string', label: 'Endpoint' } });
      ctx.ui.sidebarItem({ id: 'nav', label: 'Navigation' });
      ctx.hook.onInput(() => {
        marks.push('hook-ran');
        return { action: 'continue' as const };
      });
      ctx.action({
        id: 'ping',
        description: 'probe',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        handler: () => ({ ok: true }),
      });
      void ctx.host.manageConversation(7);
      ctx.service({
        id: 'daemon',
        start: () => {
          marks.push('svc-start');
        },
        stop: () => {
          marks.push('svc-stop');
        },
      });
    },
  };
}

function inputPayload(id = 'e1') {
  return { conversationId: 1, input: { id, text: 'x', origin: 'human' as const, whenBusy: 'steer' as const, createdAt: 1 } };
}

let dataDir: string;
let docs: MemoryDocStore;
let events: string[];

interface MakeHostOpts {
  config?: PluginConfigStore;
  deferServices?: boolean;
  backend?: Partial<PluginHostBackend>;
}

function isConfigStore(value: PluginConfigStore | MakeHostOpts | undefined): value is PluginConfigStore {
  return Boolean(value && typeof value === 'object' && 'get' in value && typeof value.get === 'function');
}

function makeHost(configOrOpts?: PluginConfigStore | MakeHostOpts): PluginHost {
  const opts: MakeHostOpts = isConfigStore(configOrOpts) ? { config: configOrOpts } : (configOrOpts ?? {});
  return new PluginHost({
    buildProvider: createPluginBuildProvider(),
    dataDir,
    host: { ...makeHostApi(events), ...(opts.backend ?? {}) },
    docs,
    ...(opts.config !== undefined ? { config: opts.config } : {}),
    ...(opts.deferServices === true ? { deferServices: true } : {}),
  });
}

beforeEach(async () => {
  dataDir = await makeTempDir('helmx-plugin-races-test-');
  docs = new MemoryDocStore();
  events = [];
});

afterEach(async () => {
  await cleanupDir(dataDir);
});

// ---------------------------------------------------------------------------
// 1. enable commit point occurs after toggle persistence succeeds
// ---------------------------------------------------------------------------

test('enable persistence window: service already started while actions reject, hooks stay inactive, and UI stays hidden until commit', { timeout: 60_000 }, async () => {
  const store = new GatedStore();
  const host = makeHost(store);
  const marks: string[] = [];
  await host.register(fullPlugin('builtin:herdr', marks), { enabled: false });

  // Gate control: suspend inside setEnabled until test releases it (deterministic window)
  let signalEntered!: () => void;
  const entered = new Promise<void>((res) => (signalEntered = res));
  let release!: () => void;
  const gate = new Promise<void>((res) => (release = res));
  store.onSetEnabled = () => {
    signalEntered();
    return gate;
  };

  const enabling = host.enable('builtin:herdr');
  await entered;
  try {
    // Inside window: service has started, but plugin remains completely unavailable externally (uncommitted)
    assert.deepEqual(marks, ['svc-start'], 'service has started before persistence completes');
    await assertRejectsCode(() => host.invokeAction('builtin:herdr', 'ping', {}), 'plugin_disabled');
    marks.length = 0;
    const r = await host.runHook('input', inputPayload());
    assert.equal(r.action, 'continue');
    assert.deepEqual(marks, [], 'hook handlers never run inside the suspension window');
    assert.deepEqual(host.listUi(), [], 'UI is not exposed inside the suspension window');
    assert.equal(host.list().find((p) => p.id === 'builtin:herdr')!.enabled, false);
  } finally {
    release();
    await enabling;
  }

  // After commit: actions work, hooks run, UI is exposed, and state is persisted true
  assert.deepEqual(await host.invokeAction('builtin:herdr', 'ping', {}), { ok: true });
  marks.length = 0;
  const r2 = await host.runHook('input', inputPayload());
  assert.equal(r2.action, 'transform');
  assert.deepEqual(marks, ['hook-ran']);
  assert.equal(host.listUi().length, 1);
  assert.equal(host.list().find((p) => p.id === 'builtin:herdr')!.enabled, true);
  assert.equal(store.enabled.get('builtin:herdr'), true);
});

test('enable persistence failure: stays unavailable in window, rolls back cleanly with zero active tasks, preserves schema, and retries cleanly', { timeout: 60_000 }, async () => {
  const store = new GatedStore();
  const host = makeHost(store);
  const marks: string[] = [];
  await host.register(fullPlugin('builtin:herdr', marks), { enabled: false });

  let signalEntered!: () => void;
  const entered = new Promise<void>((res) => (signalEntered = res));
  let rejectPersist!: (err: Error) => void;
  const gate = new Promise<void>((_, rej) => (rejectPersist = rej));
  store.onSetEnabled = () => {
    signalEntered();
    return gate;
  };

  const enabling = host.enable('builtin:herdr');
  await entered;
  let windowHeld = true;
  try {
    await assertRejectsCode(() => host.invokeAction('builtin:herdr', 'ping', {}), 'plugin_disabled');
    assert.deepEqual(host.listUi(), []);
  } catch (err) {
    windowHeld = false;
    rejectPersist(new Error('cleanup'));
    await enabling.catch(() => {});
    throw err;
  }
  assert.ok(windowHeld);
  rejectPersist(new Error('network disconnected'));

  const err = (await assertRejectsCode(() => enabling, 'plugin_enabled_persist_failed')) as HelmxError;
  assert.match(err.message, /network disconnected/);

  // Rollback: disabled, service stopped, managed asset released, schema retained, zero active tasks
  assert.equal(host.list().find((p) => p.id === 'builtin:herdr')!.enabled, false);
  assert.ok(marks.includes('svc-stop'), 'started service stopped in reverse order');
  assert.ok(events.includes('release:builtin:herdr:7'), 'managed asset released');
  assert.equal(host.getConfigSchema('builtin:herdr').endpoint?.type, 'string');
  assert.deepEqual(host.listUi(), []);
  assert.equal(host.activeTaskCount('builtin:herdr'), 0, 'zero active tasks after rollback');
  assert.equal(store.enabled.has('builtin:herdr'), false, 'failed persistence writes no toggle value');

  // Re-enables cleanly once store recovers
  store.onSetEnabled = () => {};
  await host.enable('builtin:herdr');
  assert.equal(host.list().find((p) => p.id === 'builtin:herdr')!.enabled, true);
  assert.equal(store.enabled.get('builtin:herdr'), true);
});

// ---------------------------------------------------------------------------
// 2. register resolves persisted toggle before acquiring any assets: zero leftovers if getter fails
// ---------------------------------------------------------------------------

test('getEnabled throws: register leaves zero leftovers (registry / dataDir / hooks / managed assets) and preserves original error', { timeout: 60_000 }, async () => {
  const host = makeHost({
    get() {
      return {};
    },
    set() {},
    getEnabled() {
      throw new HelmxError('io_broken', 'store read crash', 500);
    },
    setEnabled() {},
  });
  await assertRejectsCode(() => host.register(fullPlugin('p:boom', [])), 'io_broken');

  assert.equal(host.list().length, 0, 'zero leftovers in plugin registry');
  assert.equal(existsSync(join(dataDir, 'plugins', pluginDataDirName('p:boom'))), false, 'plugin data directory not created');
  assert.deepEqual(events.filter((e) => e.startsWith('manage:')), [], 'no host assets acquired');
  const r = await host.runHook('input', inputPayload());
  assert.equal(r.action, 'continue', 'zero leftovers in hook pipeline');

  // Non-HelmxError exceptions: wrapped as plugin_registration_failed while preserving original message
  const host2 = makeHost({
    get() {
      return {};
    },
    set() {},
    getEnabled() {
      throw new Error('underlying I/O timeout');
    },
    setEnabled() {},
  });
  const wrapped = (await assertRejectsCode(() => host2.register(fullPlugin('p:boom2', [])), 'plugin_registration_failed')) as HelmxError;
  assert.match(wrapped.message, /underlying I\/O timeout/);
  assert.equal(host2.list().length, 0);

  // Host stays healthy: subsequent registrations succeed normally
  const ok = makeHost();
  await ok.register(fullPlugin('p:healthy', []), { enabled: false });
  assert.equal(ok.list().find((p) => p.id === 'p:healthy')!.enabled, false);
});

test('getEnabled returns non-boolean value: rejected explicitly (no truthy coercion) with zero leftovers', { timeout: 60_000 }, async () => {
  const host = makeHost({
    get() {
      return {};
    },
    set() {},
    getEnabled() {
      return 'false' as unknown as boolean; // String 'false' is truthy and must never coerce to enabled
    },
    setEnabled() {},
  });
  const err = (await assertRejectsCode(() => host.register(fullPlugin('p:lie', [])), 'plugin_enabled_state_invalid')) as HelmxError;
  assert.equal(err.status, 500);
  assert.equal(host.list().length, 0);
  assert.equal(existsSync(join(dataDir, 'plugins', pluginDataDirName('p:lie'))), false);
  assert.deepEqual(events.filter((e) => e.startsWith('manage:')), []);
});

// ---------------------------------------------------------------------------
// 3. ConfigService callback form + HelmxPluginConfigStore in-lock read-modify-write
// ---------------------------------------------------------------------------

/**
 * Deterministically injects one concurrent write at `updateBy` entry (self-disarming after firing).
 * Injection runs right before acquiring the lock: waits outside the lock and skips second reads inside,
 * preventing deadlock. Both old and new implementations pass through here (object/function updates both
 * delegate to `updateBy`): an out-of-lock stale snapshot would overwrite intervening writes, whereas the
 * callback sees the latest in-lock state and updates only its owned keys.
 */
class InterposingConfigService extends ConfigService {
  interpose: (() => Promise<void>) | undefined;
  override updateBy(mutate: (current: Record<string, unknown>) => Record<string, unknown>): Promise<Record<string, unknown>> {
    const fn = this.interpose;
    if (fn) {
      this.interpose = undefined;
      return fn().then(() => super.updateBy(mutate));
    }
    return super.updateBy(mutate);
  }
}

function makeRealStore(config: ConfigService, credentials: CredentialService): HelmxPluginConfigStore {
  return new HelmxPluginConfigStore({ config, credentials });
}

test('ConfigService callback form reads latest in-lock value while preserving object-patch semantics', { timeout: 60_000 }, async () => {
  const a = new ConfigService(dataDir);
  const b = new ConfigService(dataDir);
  await Promise.all([a.update({ k1: 'v1' }), b.update({ k2: 'v2' })]);
  const out = await a.update((current) => ({ ...current, k1Upper: String(current['k1']).toUpperCase() }));
  assert.equal(out['k1Upper'], 'V1', 'callback observes latest k1 inside lock (even from non-empty initial file)');
  const raw = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(raw, { k1: 'v1', k2: 'v2', k1Upper: 'V1' });
});

test('setEnabled during concurrent updates to auth/other keys never overwrites them with stale snapshots (deterministic injection)', { timeout: 60_000 }, async () => {
  const credDir = join(dataDir, 'cred');
  mkdirSync(credDir, { recursive: true });
  const cfg = new InterposingConfigService(dataDir);
  const other = new ConfigService(dataDir);
  await other.update({ auth: { passwordHash: 'h0' }, model: 'faux/1' });

  const store = makeRealStore(cfg, new CredentialService(credDir));
  await store.load();

  // Inject another module's write right at store.update entry: old snapshot logic would clobber it
  cfg.interpose = async () => {
    await other.update({ auth: { passwordHash: 'h1' }, model: 'faux/2' });
  };
  await store.setEnabled('builtin:herdr', false);

  const raw = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(raw['pluginEnabled'], { 'builtin:herdr': false });
  assert.deepEqual(raw['auth'], { passwordHash: 'h1' }, 'intervening auth write must not be overwritten by stale snapshot');
  assert.equal(raw['model'], 'faux/2', 'intervening model write must not be overwritten by stale snapshot');
  assert.equal(store.getEnabled('builtin:herdr'), false);
});

test('two stores concurrently updating different pluginEnabled keys preserve both writes (deterministic injection)', { timeout: 60_000 }, async () => {
  const credDir = join(dataDir, 'cred');
  mkdirSync(credDir, { recursive: true });
  const cfgA = new InterposingConfigService(dataDir);
  const cfgB = new ConfigService(dataDir);
  const storeA = makeRealStore(cfgA, new CredentialService(credDir));
  const storeB = makeRealStore(cfgB, new CredentialService(credDir));
  await storeA.load();
  await storeB.load();

  // Interpose storeB's write right at storeA's update entry: both updates must persist
  cfgA.interpose = async () => {
    await storeB.setEnabled('p:b', false);
  };
  await storeA.setEnabled('p:a', true);

  const raw = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(raw['pluginEnabled'], { 'p:a': true, 'p:b': false }, 'toggle keys for both plugins preserved');
  assert.equal(storeA.getEnabled('p:a'), true);
  assert.equal(storeB.getEnabled('p:b'), false);
});

test('plugin config write preserves intervening external updates and updates only this plugin nested key', { timeout: 60_000 }, async () => {
  const credDir = join(dataDir, 'cred');
  mkdirSync(credDir, { recursive: true });
  const cfg = new InterposingConfigService(dataDir);
  const other = new ConfigService(dataDir);
  await other.update({ plugins: { 'p:other': { keep: 1 } }, theme: 'dark' });

  const store = makeRealStore(cfg, new CredentialService(credDir));
  await store.load();

  cfg.interpose = async () => {
    await other.update({ theme: 'light' });
  };
  await store.set('p:mine', { retries: 2 }, { retries: { type: 'number' } });

  const raw = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(raw['theme'], 'light', 'intervening theme write must not be overwritten by stale snapshot');
  assert.deepEqual(raw['plugins'], { 'p:other': { keep: 1 }, 'p:mine': { retries: 2 } }, 'other plugin config preserved while updating target key');
  assert.deepEqual(store.get('p:mine'), { retries: 2 });
  assert.deepEqual(store.get('p:other'), { keep: 1 });
});

test('writing when pluginEnabled is corrupt throws config_corrupt explicitly, never rebuilds with {}, and keeps cache unchanged', { timeout: 60_000 }, async () => {
  const credDir = join(dataDir, 'cred');
  mkdirSync(credDir, { recursive: true });
  const configPath = join(dataDir, 'config.json');
  const store = makeRealStore(new ConfigService(dataDir), new CredentialService(credDir));
  await store.load();

  // After loading cleanly, corrupt pluginEnabled on disk with non-boolean mapping
  writeFileSync(configPath, JSON.stringify({ pluginEnabled: { ghost: 'yes' } }), 'utf8');
  await assertRejectsCode(() => store.setEnabled('p:x', true), 'config_corrupt');
  let raw = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(raw['pluginEnabled'], { ghost: 'yes' }, 'corrupt content preserved as-is without rebuilding');
  assert.equal(store.getEnabled('p:x'), undefined, 'in-memory cache unchanged after failed write');

  // Top-level non-object also fails explicitly
  writeFileSync(configPath, JSON.stringify({ pluginEnabled: 'nope' }), 'utf8');
  await assertRejectsCode(() => store.setEnabled('p:x', true), 'config_corrupt');
  raw = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  assert.equal(raw['pluginEnabled'], 'nope');
});

test('writing when plugins field is corrupt throws config_corrupt explicitly without silent rebuild', { timeout: 60_000 }, async () => {
  const credDir = join(dataDir, 'cred');
  mkdirSync(credDir, { recursive: true });
  const configPath = join(dataDir, 'config.json');
  const store = makeRealStore(new ConfigService(dataDir), new CredentialService(credDir));
  await store.load();

  writeFileSync(configPath, JSON.stringify({ plugins: 'corrupt' }), 'utf8');
  await assertRejectsCode(
    () => store.set('p:x', { retries: 1 }, { retries: { type: 'number' } }),
    'config_corrupt',
  );
  const raw = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  assert.equal(raw['plugins'], 'corrupt', 'corrupt content preserved as-is');
});

test('concurrent host.setConfig writes share instance serialization without clobbering or materializing defaults', { timeout: 60_000 }, async () => {
  const credDir = join(dataDir, 'cred-concurrent');
  mkdirSync(credDir, { recursive: true });
  const cfg = new InterposingConfigService(dataDir);
  const store = makeRealStore(cfg, new CredentialService(credDir));
  await store.load();

  const host = makeHost(store);
  await host.register({
    id: 'p:concurrent-cfg',
    definePlugin: (ctx) => {
      ctx.configSchema({
        mode: { type: 'string', default: 'auto' },
        retries: { type: 'number', default: 3 },
        endpoint: { type: 'string' },
        apiKey: { type: 'string', secret: true },
      });
    },
  }, { enabled: true });

  // Interpose a concurrent write while the first host.setConfig is in flight:
  // both patches apply incrementally and neither materializes schema defaults onto disk.
  const firstEntered = deferred<void>();
  const releaseFirst = deferred<void>();
  cfg.interpose = async () => {
    firstEntered.resolve();
    await releaseFirst.promise;
  };

  const firstWrite = host.setConfig('p:concurrent-cfg', { endpoint: 'https://plugin.local' });
  await firstEntered.promise;
  const httpWrite = host.setConfig('p:concurrent-cfg', { retries: 7, apiKey: 'secret-from-http' });
  releaseFirst.resolve();
  await Promise.all([firstWrite, httpWrite]);

  const raw = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as {
    plugins?: Record<string, Record<string, unknown>>;
  };
  assert.deepEqual(raw.plugins?.['p:concurrent-cfg'], {
    endpoint: 'https://plugin.local',
    retries: 7,
  }, 'both concurrent writes must survive and schema default "mode" must never be materialized to disk');
  assert.equal('mode' in (raw.plugins?.['p:concurrent-cfg'] ?? {}), false);
  assert.equal('apiKey' in (raw.plugins?.['p:concurrent-cfg'] ?? {}), false, 'secret field must never leak into config.json');
  assert.deepEqual(host.getConfigSources('p:concurrent-cfg'), {
    mode: 'default',
    retries: 'configured',
    endpoint: 'configured',
    apiKey: 'configured',
  });
  assert.deepEqual(host.getConfig('p:concurrent-cfg'), {
    mode: 'auto',
    retries: 7,
    endpoint: 'https://plugin.local',
    apiKey: 'secret-from-http',
  });

  // Secret-only patch via host.setConfig preserves external plain-field edits on disk without overwriting config.json.
  const externalCfg = new ConfigService(dataDir);
  await externalCfg.updateBy((cur) => ({
    ...cur,
    plugins: {
      ...(cur['plugins'] as Record<string, Record<string, unknown>>),
      'p:concurrent-cfg': { endpoint: 'https://external-edit.local', retries: 9 },
    },
  }));
  await host.setConfig('p:concurrent-cfg', { apiKey: 'rotated-secret' });
  const afterSecretRaw = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as {
    plugins?: Record<string, Record<string, unknown>>;
  };
  assert.deepEqual(afterSecretRaw.plugins?.['p:concurrent-cfg'], {
    endpoint: 'https://external-edit.local',
    retries: 9,
  }, 'secret-only patch must not overwrite concurrent plain config on disk');

  await host.dispose();
});

// ---------------------------------------------------------------------------
// 4. Disable gate TOCTOU & plugin_in_use recovery
// ---------------------------------------------------------------------------

test('disable gate TOCTOU: task entering during inUse collection window is caught 409 by second gate', { timeout: 60_000 }, async () => {
  const host = makeHost();
  try {
    let releaseInUse!: () => void;
    let inUsePending = true;
    const actionGate = deferred<void>();
    await host.register({
      id: 'p:toctou',
      definePlugin: (ctx) => {
        ctx.service({
          id: 'svc',
          start() {},
          stop() {},
          // Pause inUse once (fabricates await window in collectPluginInUse); return empty afterward so
          // final test teardown disable does not block forever.
          inUse: () => {
            if (!inUsePending) return [];
            return new Promise<void>((resolve) => {
              releaseInUse = () => { inUsePending = false; resolve(); };
            }).then(() => []);
          },
        });
        ctx.action({
          id: 'hang',
          description: 'hanging action',
          inputSchema: { type: 'object', additionalProperties: false },
          outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
          handler: () => actionGate.promise.then(() => ({ ok: true })),
        });
      },
    }, { enabled: true });

    // Start disable first (pauses inside inUse), then start an in-flight action inside that window
    const disabling = host.disable('p:toctou');
    await new Promise<void>((resolve) => setImmediate(resolve));
    const invoking = host.invokeAction('p:toctou', 'hang', {});
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(host.activeTaskCount('p:toctou') >= 1, true, 'action started in window must count as live task');

    // Release inUse returning empty: second gate must catch the action entered during window -> 409
    releaseInUse();
    await assertRejectsCode(() => disabling, 'plugin_has_live_tasks', 409);
    const summary = host.get('p:toctou');
    assert.equal(summary?.enabled, true);
    actionGate.resolve();
    await invoking;
    await host.disable('p:toctou');
    assert.equal(host.get('p:toctou')?.enabled, false);
  } finally {
    await host.dispose();
  }
});

test('disable gate plugin_in_use rejection leaves state enabled+idle so subsequent calls work', { timeout: 60_000 }, async () => {
  const host = makeHost();
  try {
    await host.register({
      id: 'p:inuse',
      definePlugin: (ctx) => {
        ctx.service({
          id: 'svc',
          start() {},
          stop() {},
          inUse: () => [{ kind: 'job', id: 'j1', label: 'busy' }],
        });
        ctx.action({
          id: 'ping',
          description: 'probe action',
          inputSchema: { type: 'object', additionalProperties: false },
          outputSchema: { type: 'object', properties: { pong: { type: 'boolean' } }, required: ['pong'], additionalProperties: false },
          handler: () => ({ pong: true }),
        });
      },
    }, { enabled: true });

    await assertRejectsCode(() => host.disable('p:inuse'), 'plugin_in_use', 409);
    assert.equal(host.get('p:inuse')?.enabled, true);
    // Gate rejection is not terminal: plugin keeps serving
    const out = await host.invokeAction('p:inuse', 'ping', {});
    assert.deepEqual(out, { pong: true });
    await host.disable('p:inuse', { force: true });
    assert.equal(host.get('p:inuse')?.enabled, false);
  } finally {
    await host.dispose();
  }
});

// ---------------------------------------------------------------------------
// 5. Startup barrier RW gate & single-flight retry
// ---------------------------------------------------------------------------

test('concurrent register(enabled) during barrier starts its service without being skipped (gate waits for barrier)', { timeout: 60_000 }, async () => {
  const host = makeHost({ deferServices: true });
  try {
    const marks: string[] = [];
    const prepareGate = deferred<void>();
    await host.register({
      id: 'p:a',
      definePlugin: (ctx) => {
        ctx.service({
          id: 'svc-a',
          prepare: () => prepareGate.promise,
          start: () => { marks.push('a-start'); },
          stop: () => { marks.push('a-stop'); },
        });
      },
    }, { enabled: true });

    const starting = host.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    // Barrier in flight (A's prepare paused): concurrently register and enable B
    const registeringB = host.register({
      id: 'p:b',
      definePlugin: (ctx) => {
        ctx.service({
          id: 'svc-b',
          start: () => { marks.push('b-start'); },
          stop: () => { marks.push('b-stop'); },
        });
      },
    }, { enabled: true });

    prepareGate.resolve();
    await starting;
    await registeringB;
    assert.deepEqual(marks, ['a-start', 'b-start']);
    assert.equal(host.get('p:b')?.enabled, true);
  } finally {
    await host.dispose();
  }
});

test('concurrent disable during barrier never resurrects service (stop runs after barrier start)', { timeout: 60_000 }, async () => {
  const host = makeHost({ deferServices: true });
  try {
    const marks: string[] = [];
    const prepareGate = deferred<void>();
    await host.register({
      id: 'p:revive',
      definePlugin: (ctx) => {
        ctx.service({
          id: 'svc',
          prepare: () => prepareGate.promise,
          start: () => { marks.push('start'); },
          stop: () => { marks.push('stop'); },
        });
      },
    }, { enabled: true });

    const starting = host.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const disabling = host.disable('p:revive');
    prepareGate.resolve();
    await starting;
    await disabling;
    assert.deepEqual(marks, ['start', 'stop']);
    assert.equal(host.get('p:revive')?.enabled, false);
  } finally {
    await host.dispose();
  }
});

test('stop() during barrier waits for barrier completion before stopping instead of returning early', { timeout: 60_000 }, async () => {
  const host = makeHost({ deferServices: true });
  try {
    const marks: string[] = [];
    const prepareGate = deferred<void>();
    await host.register({
      id: 'p:stopwait',
      definePlugin: (ctx) => {
        ctx.service({
          id: 'svc',
          prepare: () => prepareGate.promise,
          start: () => { marks.push('start'); },
          stop: () => { marks.push('stop'); },
        });
      },
    }, { enabled: true });

    const starting = host.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const stopping = host.stop();
    prepareGate.resolve();
    await starting;
    await stopping;
    assert.deepEqual(marks, ['start', 'stop']);
  } finally {
    await host.dispose();
  }
});

test('start() single-flight failure clears cached rejection so retries succeed', { timeout: 60_000 }, async () => {
  const host = makeHost({ deferServices: true });
  try {
    const marks: string[] = [];
    let failNextStart = true;
    await host.register({
      id: 'p:barrier-retry',
      definePlugin: (ctx) => {
        ctx.service({
          id: 'svc',
          start: () => {
            if (failNextStart) {
              failNextStart = false;
              throw new Error('first startup failed');
            }
            marks.push('start');
          },
          stop: () => { marks.push('stop'); },
        });
      },
    }, { enabled: true });

    await assert.rejects(host.start(), /first startup failed/);
    await host.start();
    assert.deepEqual(marks, ['start']);
    await host.stop();
    assert.deepEqual(marks, ['start', 'stop']);
  } finally {
    await host.dispose();
  }
});

// ---------------------------------------------------------------------------
// 6. Hook activation gate: failed-while-enabled, deactivating window, live-task invariants & recovery
// ---------------------------------------------------------------------------

function spawnPayload(prompt = 'run task') {
  return { parentConversationId: 1, prompt };
}

test('hook gate: failed-while-enabled plugin skips regular and agent_spawn around hooks without affecting active peers, and resumes after recovery', { timeout: 60_000 }, async () => {
  const host = makeHost();
  try {
    const marks: string[] = [];
    await host.register({ id: 'p:base', definePlugin: () => {} }, { enabled: true });
    await host.register({
      id: 'p:dep',
      dependencies: ['p:base'],
      definePlugin: (ctx) => {
        ctx.hook.onInput((payload) => {
          marks.push(`dep:input:${payload.input.id}`);
          return { action: 'transform', value: { ...payload, input: { ...payload.input, text: `${payload.input.text}+dep` } } };
        });
        ctx.hook.onAgentSpawn(async (req, next) => {
          marks.push(`dep:spawn-before:${req.prompt}`);
          await next({ ...req, prompt: `${req.prompt}+dep` });
          marks.push('dep:spawn-after');
        });
      },
    }, { enabled: true });
    await host.register({
      id: 'p:other',
      definePlugin: (ctx) => {
        ctx.hook.onInput((payload) => {
          marks.push(`other:input:${payload.input.id}`);
          return { action: 'transform', value: { ...payload, input: { ...payload.input, text: `${payload.input.text}+other` } } };
        });
        ctx.hook.onAgentSpawn(async (req, next) => {
          marks.push(`other:spawn-before:${req.prompt}`);
          await next({ ...req, prompt: `${req.prompt}+other` });
          marks.push('other:spawn-after');
        });
      },
    }, { enabled: true });

    // Pre-check: active dependent participates in regular and around hooks.
    const activeInput = await host.runHook('input', inputPayload('t1'));
    assert.equal(activeInput.action, 'transform');
    assert.equal((activeInput as { action: 'transform'; value: { input: { text: string } } }).value.input.text, 'x+dep+other');
    const activeSpawn = await host.runHookAround('agent_spawn', spawnPayload('s1'), async (req) => ({ finalPrompt: req.prompt }));
    assert.deepEqual(activeSpawn, { finalPrompt: 's1+dep+other' });

    // Force-disable base -> p:dep becomes enabled=true, status=failed (`lastError !== undefined`).
    await host.disable('p:base', { force: true });
    const failedSummary = host.get('p:dep')!;
    assert.equal(failedSummary.enabled, true);
    assert.equal(failedSummary.status, 'failed');
    assert.equal(failedSummary.error?.code, 'plugin_dependency_not_enabled');

    // Failed dependent must be skipped across regular hooks (shared and solo) and around hooks.
    marks.length = 0;
    const failedInput = await host.runHook('input', inputPayload('t2'));
    assert.equal(failedInput.action, 'transform');
    assert.equal((failedInput as { action: 'transform'; value: { input: { text: string } } }).value.input.text, 'x+other');
    assert.deepEqual(marks, ['other:input:t2']);

    marks.length = 0;
    const failedSpawn = await host.runHookAround('agent_spawn', spawnPayload('s2'), async (req) => ({ finalPrompt: req.prompt }));
    assert.deepEqual(failedSpawn, { finalPrompt: 's2+other' });
    assert.deepEqual(marks, ['other:spawn-before:s2', 'other:spawn-after']);
    assert.equal(host.activeTaskCount('p:dep'), 0, 'skipped failed plugin never records live hook tasks');

    // Recovery: disable dep -> enable base -> enable dep restores regular and around hook execution.
    await host.disable('p:dep');
    await host.enable('p:base');
    await host.enable('p:dep');
    assert.equal(host.get('p:dep')?.status, 'active');

    marks.length = 0;
    const recoveredInput = await host.runHook('input', inputPayload('t3'));
    assert.equal(recoveredInput.action, 'transform');
    assert.equal((recoveredInput as { action: 'transform'; value: { input: { text: string } } }).value.input.text, 'x+other+dep');
    const recoveredSpawn = await host.runHookAround('agent_spawn', spawnPayload('s3'), async (req) => ({ finalPrompt: req.prompt }));
    assert.deepEqual(recoveredSpawn, { finalPrompt: 's3+other+dep' });
    assert.ok(marks.includes('dep:input:t3'));
    assert.ok(marks.includes('dep:spawn-before:s3+other'));
    assert.ok(marks.includes('dep:spawn-after'));
  } finally {
    await host.dispose();
  }
});

test('hook gate: in-flight hooks keep owned live-task protection when dependent fails, block new hook dispatches, and deactivating window excludes hooks', { timeout: 60_000 }, async () => {
  const host = makeHost();
  try {
    const inputEntered = deferred<void>();
    const inputRelease = deferred<void>();
    const spawnEntered = deferred<void>();
    const spawnRelease = deferred<void>();
    const stopEntered = deferred<void>();
    const stopRelease = deferred<void>();

    let holdHooks = true;
    let holdStop = false;
    const ran: string[] = [];

    await host.register({ id: 'p:base', definePlugin: () => {} }, { enabled: true });
    await host.register({
      id: 'p:dep',
      dependencies: ['p:base'],
      definePlugin: (ctx) => {
        ctx.hook.onInput(async (payload) => {
          ran.push(`input:${payload.input.id}`);
          if (holdHooks) {
            inputEntered.resolve();
            await inputRelease.promise;
          }
          return { action: 'continue' as const };
        });
        ctx.hook.onAgentSpawn(async (req, next) => {
          ran.push(`spawn:${req.prompt}`);
          if (holdHooks) {
            spawnEntered.resolve();
            await spawnRelease.promise;
          }
          await next(req);
        });
        ctx.service({
          id: 'svc',
          start: () => {},
          stop: async () => {
            if (holdStop) {
              stopEntered.resolve();
              await stopRelease.promise;
            }
          },
        });
      },
    }, { enabled: true });

    // Start two in-flight hooks (regular + around) while active.
    const inflightInput = host.runHook('input', inputPayload('inflight-1'));
    const inflightSpawn = host.runHookAround('agent_spawn', spawnPayload('inflight-s1'), async (req) => ({ prompt: req.prompt }));
    await Promise.all([inputEntered.promise, spawnEntered.promise]);
    assert.equal(host.activeTaskCount('p:dep'), 2);

    // Force-disable base while dep hooks are in-flight: dep becomes failed, yet owned live-task guard still holds.
    await host.disable('p:base', { force: true });
    assert.equal(host.get('p:dep')?.status, 'failed');
    assert.equal(host.activeTaskCount('p:dep'), 2, 'in-flight hook tasks remain tracked after dependency failure');
    await assertRejectsCode(() => host.disable('p:dep', { force: true }), 'plugin_has_live_tasks', 409);

    // New hook dispatches while failed must skip p:dep and never add live tasks.
    const blockedInput = await host.runHook('input', inputPayload('after-fail'));
    assert.deepEqual(blockedInput, { action: 'continue' });
    const blockedSpawn = await host.runHookAround('agent_spawn', spawnPayload('after-fail-s'), async (req) => ({ fallback: req.prompt }));
    assert.deepEqual(blockedSpawn, { fallback: 'after-fail-s' });
    assert.deepEqual(ran, ['input:inflight-1', 'spawn:inflight-s1']);
    assert.equal(host.activeTaskCount('p:dep'), 2);

    // Completing in-flight hooks releases tracked tasks cleanly via finally.
    inputRelease.resolve();
    spawnRelease.resolve();
    await inflightInput;
    assert.deepEqual(await inflightSpawn, { prompt: 'inflight-s1' });
    assert.equal(host.activeTaskCount('p:dep'), 0);

    // Recover dep, then verify phase === 'deactivating' window also excludes regular and around hooks.
    holdHooks = false;
    await host.disable('p:dep');
    await host.enable('p:base');
    await host.enable('p:dep');

    ran.length = 0;
    holdStop = true;
    const disabling = host.disable('p:dep');
    await stopEntered.promise;
    try {
      const midInput = await host.runHook('input', inputPayload('mid-deactivate'));
      assert.deepEqual(midInput, { action: 'continue' });
      const midSpawn = await host.runHookAround('agent_spawn', spawnPayload('mid-deactivate-s'), async (req) => ({ ok: req.prompt }));
      assert.deepEqual(midSpawn, { ok: 'mid-deactivate-s' });
      assert.deepEqual(ran, [], 'hooks must not execute during phase=deactivating');
      assert.equal(host.activeTaskCount('p:dep'), 0);
    } finally {
      stopRelease.resolve();
      await disabling;
    }
  } finally {
    await host.dispose();
  }
});
