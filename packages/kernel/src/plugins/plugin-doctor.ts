/**
 * Static doctor diagnostics for external plugin directories: executes real load + real registration
 * checks rather than a separate approximate validator.
 *
 * Pipeline:
 * 1. Manifest & entry resolution (`resolvePluginEntry`);
 * 2. Backend isolation import (`importPluginDefinition`);
 * 3. Temporary host dry-run registration (`definePlugin` checks with a typed `doctorBackend` whose
 *    runtime ports throw 501 explicitly, capturing manifest projection via explicit callback);
 * 4. Client module compilation & export check for all captured `ctx.ui.*` client refs.
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  HelmxError,
  clientNpmRootsOf,
  compareCodeUnit,
  type PluginBuildProvider,
  type PluginDefinition,
  type PluginDoctorCheck,
  type PluginDoctorReport,
  type PluginManifestProjection,
  type PluginSummary,
} from '@helmx/protocol';
import {
  PluginHostCore,
  type PluginRegisterOptions,
} from './plugin-host-core.js';
import type {
  PluginHostBackend,
  PluginHostOptions,
  PluginKvStore,
  PluginSessionDocStore,
} from './types.js';
import { nextPluginGeneration, registerPluginTsRoot } from './backend-ts-loader.js';
import {
  importPluginDefinition,
  normalizeDefinition,
  resolvePluginEntry,
} from './external-loader.js';
import { readPrebuiltClientBundle, verifyPrebuiltClientDir } from './ui-registry.js';
import { scanPluginClientDirUiHygiene } from './plugin-ui-hygiene.js';

export interface PluginDoctorHost {
  register(definition: PluginDefinition, options?: PluginRegisterOptions): Promise<void>;
  list(): PluginSummary[];
  dispose(): Promise<void>;
}

export type PluginDoctorHostFactory = (options: PluginHostOptions) => PluginDoctorHost;

/** Ephemeral in-memory doc store used during `doctor` registration checks (touches no durable storage). */
class DoctorDocStore {
  private values = new Map<string, unknown>();
  get<T>(key: string, initial: T): T {
    return this.values.has(key) ? (structuredClone(this.values.get(key)) as T) : initial;
  }
  set<T>(key: string, value: T): void {
    this.values.set(key, structuredClone(value));
  }
  deletePlugin(pluginId: string): void {
    const prefix = `${pluginId}:`;
    for (const key of [...this.values.keys()]) {
      if (key.startsWith(prefix) && !key.slice(prefix.length).includes(':')) this.values.delete(key);
    }
  }
  async flush(): Promise<void> {}
}

/** Ephemeral in-memory sessionDoc store used during `doctor` registration checks (touches no durable storage). */
class DoctorSessionDocStore implements PluginSessionDocStore {
  private values = new Map<string, Map<string, Map<number, string>>>();
  get(pluginId: string, name: string, conversationId: number): string | undefined {
    return this.values.get(pluginId)?.get(name)?.get(conversationId);
  }
  put(pluginId: string, name: string, conversationId: number, valueJson: string): void {
    let byName = this.values.get(pluginId);
    if (!byName) {
      byName = new Map();
      this.values.set(pluginId, byName);
    }
    let byConv = byName.get(name);
    if (!byConv) {
      byConv = new Map();
      byName.set(name, byConv);
    }
    byConv.set(conversationId, valueJson);
  }
  delete(pluginId: string, name: string, conversationId: number): void {
    const byName = this.values.get(pluginId);
    const byConv = byName?.get(name);
    if (!byName || !byConv) return;
    byConv.delete(conversationId);
    if (byConv.size === 0) byName.delete(name);
    if (byName.size === 0) this.values.delete(pluginId);
  }
  deletePlugin(pluginId: string): void {
    this.values.delete(pluginId);
  }
  listConversationIds(pluginId: string, name: string): number[] {
    const byConv = this.values.get(pluginId)?.get(name);
    return byConv ? [...byConv.keys()].sort((a, b) => a - b) : [];
  }
  async flush(): Promise<void> {}
}

/** Ephemeral in-memory KV store used during `doctor` registration checks (touches no durable storage). */
class DoctorKvStore implements PluginKvStore {
  private values = new Map<string, Map<string, Map<string, { valueJson: string; updatedAt: number }>>>();
  get(pluginId: string, namespace: string, key: string) {
    const entry = this.values.get(pluginId)?.get(namespace)?.get(key);
    return entry ? { ...entry } : undefined;
  }
  put(pluginId: string, namespace: string, key: string, valueJson: string): number {
    let byNs = this.values.get(pluginId);
    if (!byNs) {
      byNs = new Map();
      this.values.set(pluginId, byNs);
    }
    let byKey = byNs.get(namespace);
    if (!byKey) {
      byKey = new Map();
      byNs.set(namespace, byKey);
    }
    const updatedAt = Date.now();
    byKey.set(key, { valueJson, updatedAt });
    return updatedAt;
  }
  delete(pluginId: string, namespace: string, key: string): boolean {
    return this.values.get(pluginId)?.get(namespace)?.delete(key) ?? false;
  }
  list(pluginId: string, namespace: string, opts?: { prefix?: string; limit?: number; cursor?: string }) {
    const byKey = this.values.get(pluginId)?.get(namespace);
    if (!byKey) return { items: [] };
    const keys = [...byKey.keys()]
      .filter((k) => (opts?.prefix === undefined || k.startsWith(opts.prefix)) && (opts?.cursor === undefined || compareCodeUnit(k, opts.cursor) > 0))
      .sort(compareCodeUnit);
    const hasMore = opts?.limit !== undefined && keys.length > opts.limit;
    const pageKeys = hasMore ? keys.slice(0, opts.limit) : keys;
    const items: Array<{ key: string; valueJson: string; updatedAt: number }> = [];
    for (const key of pageKeys) {
      const entry = byKey.get(key);
      if (entry !== undefined) items.push({ key, ...entry });
    }
    const lastItem = items[items.length - 1];
    return { items, ...(hasMore && lastItem !== undefined ? { nextCursor: lastItem.key } : {}) };
  }
  clearNamespace(pluginId: string, namespace: string): void {
    this.values.get(pluginId)?.delete(namespace);
  }
  deletePlugin(pluginId: string): void {
    this.values.delete(pluginId);
  }
  async flush(): Promise<void> {}
}

/**
 * Typed Doctor host backend stub: every runtime `ctx.host.*` capability throws 501 `unsupported`
 * explicitly (no `Proxy`, no `as unknown as` casts, never mocks data). Only structural primitives needed
 * during dry-run registration (`isClosing`, identity `redact`, no-op `onEvent`/`emitEvent`, `withFileLock`,
 * and empty `listActiveSpawnExecutions`) are active.
 */
function doctorBackend(): PluginHostBackend {
  const unavailable = (what: string): never => {
    throw new HelmxError(
      'unsupported',
      `Doctor static check does not provide host runtime capability '${what}' (plugins must not invoke host ports at top level of definePlugin)`,
      501,
    );
  };
  return {
    isClosing: () => false,
    redact: (text: string) => text,
    listActiveSpawnExecutions: () => [],
    onEvent: () => () => {},
    emitEvent: () => {},
    withFileLock: <T,>(_path: string, fn: () => Promise<T>): Promise<T> => fn(),
    nodeIpc: undefined,
    openTunnel: undefined,
    profiles: {
      list: () => unavailable('host.profiles.list'),
      get: () => unavailable('host.profiles.get'),
      getSystem: () => unavailable('host.profiles.getSystem'),
      save: () => unavailable('host.profiles.save'),
      directory: () => unavailable('host.profiles.directory'),
    },
    skills: {
      list: () => unavailable('host.skills.list'),
      readFile: () => unavailable('host.skills.readFile'),
      ensureSkill: () => unavailable('host.skills.ensureSkill'),
    },
    secrets: {
      get: () => unavailable('host.secrets.get'),
      set: () => unavailable('host.secrets.set'),
      delete: () => unavailable('host.secrets.delete'),
      addRedaction: () => unavailable('host.secrets.addRedaction'),
    },
    dispatchTrigger: () => unavailable('host.dispatchTrigger'),
    submitInput: () => unavailable('host.submitInput'),
    submitInputGuarded: () => unavailable('host.submitInputGuarded'),
    createConversation: () => unavailable('host.createConversation'),
    forkConversation: () => unavailable('host.forkConversation'),
    listConversations: () => unavailable('host.listConversations'),
    searchConversations: () => unavailable('host.searchConversations'),
    getConversation: () => unavailable('host.getConversation'),
    getConversationDetail: () => unavailable('host.getConversationDetail'),
    getConversationSubmission: () => unavailable('host.getConversationSubmission'),
    updateConversation: () => unavailable('host.updateConversation'),
    abortConversation: () => unavailable('host.abortConversation'),
    abortConversationGuarded: () => unavailable('host.abortConversationGuarded'),
    deleteConversationGuarded: () => unavailable('host.deleteConversationGuarded'),
    resetConversation: () => unavailable('host.resetConversation'),
    resetConversationGuarded: () => unavailable('host.resetConversationGuarded'),
    compactConversation: () => unavailable('host.compactConversation'),
    compactConversationGuarded: () => unavailable('host.compactConversationGuarded'),
    getConversationOwnership: () => unavailable('host.getConversationOwnership'),
    markConversationOwnership: () => unavailable('host.markConversationOwnership'),
    spawnAgent: () => unavailable('host.spawnAgent'),
    runGate: () => unavailable('host.runGate'),
    resolveSpawnTarget: () => unavailable('host.resolveSpawnTarget'),
    inspectNodePathUsage: () => unavailable('host.inspectNodePathUsage'),
    atomicWriteFile: () => unavailable('host.atomicWriteFile'),
    refreshModels: () => unavailable('host.refreshModels'),
    listModels: () => unavailable('host.listModels'),
    completeText: () => unavailable('host.completeText'),
    executionEnv: () => unavailable('host.executionEnv'),
    execEnv: () => unavailable('host.execEnv'),
    listArtifacts: () => unavailable('host.listArtifacts'),
    createArtifact: () => unavailable('host.createArtifact'),
    readArtifact: () => unavailable('host.readArtifact'),
    createAsk: () => unavailable('host.createAsk'),
    cancelAsk: () => unavailable('host.cancelAsk'),
    manageConversation: () => unavailable('host.manageConversation'),
  };
}

/** Normalizes a thrown error into a serializable doctor diagnostic object. */
function toErrorInfo(err: unknown): { code: string; message: string; details?: unknown } {
  if (err instanceof HelmxError) {
    return {
      code: err.code,
      message: err.message,
      ...(err.details !== undefined ? { details: err.details } : {}),
    };
  }
  return {
    code: 'doctor_check_failed',
    message: err instanceof Error ? err.message : String(err),
  };
}

/**
 * Runs static diagnostics on an external plugin directory (real load + registration + client compile).
 * Only rejects if the doctor harness itself fails (e.g., temp directory creation); plugin defects are
 * returned inside `checks`.
 */
export async function doctorPluginDir(
  dir: string,
  options: {
    buildProvider?: PluginBuildProvider;
    hostFactory?: PluginDoctorHostFactory;
  } = {},
): Promise<PluginDoctorReport> {
  let releaseTsRoot: (() => void) | undefined;
  try {
    if (statSync(dir).isDirectory()) {
      releaseTsRoot = registerPluginTsRoot(dir, {
        transform: options.buildProvider?.transformBackendTs,
      });
    }
  } catch {
    // Directory readability issues are surfaced as structured checks during entry inspection below.
  }
  try {
    return await doctorPluginDirInternal(dir, options);
  } finally {
    releaseTsRoot?.();
  }
}

async function doctorPluginDirInternal(
  dir: string,
  options: {
    buildProvider?: PluginBuildProvider;
    hostFactory?: PluginDoctorHostFactory;
  },
): Promise<PluginDoctorReport> {
  const createHost: PluginDoctorHostFactory = options.hostFactory ?? ((opts) => new PluginHostCore(opts));
  const checks: PluginDoctorCheck[] = [];
  const push = (id: string, label: string, run: () => void | Promise<void>): Promise<boolean> =>
    (async () => {
      try {
        await run();
        checks.push({ id, label });
        return true;
      } catch (err) {
        checks.push({ id, label, error: toErrorInfo(err) });
        return false;
      }
    })();

  let entryPath: string | undefined;
  const entryOk = await push('manifest', 'manifest and entry resolution', async () => {
    entryPath = await resolvePluginEntry(dir);
  });
  const resolvedEntryPath = entryPath;
  if (!entryOk || resolvedEntryPath === undefined) return report(dir, undefined, checks, undefined);

  let definition: PluginDefinition | undefined;
  const backendOk = await push('backend', 'backend module isolated import', async () => {
    const generation = nextPluginGeneration(dir);
    definition = normalizeDefinition(await importPluginDefinition(dir, resolvedEntryPath, { generation }), dir);
  });
  const resolvedDef = definition;
  if (!backendOk || resolvedDef === undefined) return report(dir, undefined, checks, undefined);

  const clientRefs: Array<{ module: string; export: string }> = [];
  const screenIds: string[] = [];
  let summary: PluginSummary | undefined;
  let manifest: PluginManifestProjection | undefined;
  // Isolate registration and compilation checks inside a temporary scratch dir to avoid mutating host data.
  const registerOk = await withDoctorScratch(async (scratch) =>
    push('register', 'real registration dry-run', async () => {
      let host: PluginDoctorHost | undefined;
      const wrapped = withClientCapture(resolvedDef, clientRefs, screenIds);
      try {
        host = createHost({
          dataDir: scratch,
          host: doctorBackend(),
          docs: new DoctorDocStore(),
          sessionDocs: new DoctorSessionDocStore(),
          kv: new DoctorKvStore(),
          deferServices: true,
          buildProvider: options.buildProvider,
        });
        await host.register(wrapped, {
          enabled: false,
          onManifestProjected: (projected) => {
            manifest = projected;
          },
        });
        const found = host.list().find((s) => s.id === resolvedDef.id);
        if (!found) {
          throw new HelmxError(
            'invalid_plugin_definition',
            `Plugin ${resolvedDef.id} not found in host summary after registration (inconsistent doctor state)`,
            500,
            { dir, pluginId: resolvedDef.id },
          );
        }
        summary = found;
      } finally {
        await host?.dispose().catch(() => {});
      }
    }),
  );
  if (!registerOk) return report(dir, resolvedDef.id, checks, undefined);

  await withDoctorScratch(async (scratch) =>
    push('client', 'frontend module compilation and export validation', async () => {
      if (resolvedDef.prebuiltClientDir !== undefined) {
        verifyPrebuiltClientDir(resolvedDef.prebuiltClientDir, resolvedDef.id);
        const seen = new Set<string>();
        for (const ref of clientRefs) {
          const key = `${ref.module}#${ref.export}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const prebuilt = readPrebuiltClientBundle(
            resolvedDef.prebuiltClientDir,
            ref.module,
            undefined,
            resolvedDef.id,
          );
          if (!prebuilt.exports.includes(ref.export)) {
            throw new HelmxError(
              'invalid_client_export',
              `Plugin ${resolvedDef.id} client reference ${ref.module}#${ref.export} is dangling: module exports [${prebuilt.exports.join(', ') || 'none'}]`,
              422,
              { pluginId: resolvedDef.id, module: ref.module, export: ref.export, exports: prebuilt.exports },
            );
          }
        }
        assertClientDirUiHygiene(resolvedDef.id, dir, resolvedDef.clientRoot);
        return;
      }
      if (clientRefs.length > 0 && options.buildProvider === undefined) {
        throw new HelmxError(
          'unsupported_client_build',
          'Plugin declared client module references, but host has no buildProvider wired to compile client modules',
          501,
          { dir },
        );
      }
      const clientRoot = resolvedDef.clientRoot;
      if (options.buildProvider === undefined) {
        assertClientDirUiHygiene(resolvedDef.id, dir, clientRoot);
        return;
      }
      if (clientRoot === undefined) {
        if (clientRefs.length > 0) {
          throw new HelmxError(
            'invalid_plugin_definition',
            `Plugin ${resolvedDef.id} declared client references without a resolved clientRoot`,
            400,
            { pluginId: resolvedDef.id, dir },
          );
        }
        return;
      }
      const npmRoots = clientNpmRootsOf(resolvedDef.npmDependencies);
      const seen = new Set<string>();
      for (const ref of clientRefs) {
        const key = `${ref.module}#${ref.export}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const compiled = await options.buildProvider.compileClientModule({
          pluginId: resolvedDef.id,
          clientRoot,
          moduleRef: ref.module,
          cacheDir: scratch,
          npmRoots,
        });
        if (!compiled.exports.includes(ref.export)) {
          throw new HelmxError(
            'invalid_client_export',
            `Plugin ${resolvedDef.id} client reference ${ref.module}#${ref.export} is dangling: module exports [${compiled.exports.join(', ') || 'none'}]`,
            422,
            { pluginId: resolvedDef.id, module: ref.module, export: ref.export, exports: compiled.exports },
          );
        }
      }
      assertClientDirUiHygiene(resolvedDef.id, dir, clientRoot);
    }),
  );

  return report(dir, resolvedDef.id, checks, summary, screenIds, manifest);
}

/** Runs static UI/CSS hygiene checks on `clientRoot` and throws `plugin_client_ui_hygiene_failed` on violations. */
function assertClientDirUiHygiene(pluginId: string, pluginDir: string, clientRoot: string | undefined): void {
  if (clientRoot === undefined) return;
  const violations = scanPluginClientDirUiHygiene(pluginDir, clientRoot);
  if (violations.length === 0) return;
  const formatted = violations.map((v) => `${v.file}:${v.line}:${v.rule} (${v.message})`);
  throw new HelmxError(
    'plugin_client_ui_hygiene_failed',
    `Plugin ${pluginId} client UI hygiene failed (${violations.length} violation(s)): ${formatted.join('; ')}`,
    422,
    {
      pluginId,
      violations: violations.map((v) => ({
        file: v.file,
        line: v.line,
        rule: v.rule,
        message: v.message,
        location: `${v.file}:${v.line}:${v.rule}`,
      })),
    },
  );
}

function report(
  dir: string,
  pluginId: string | undefined,
  checks: PluginDoctorCheck[],
  summary: PluginSummary | undefined,
  screenIds?: string[],
  manifest?: PluginManifestProjection,
): PluginDoctorReport {
  return {
    dir,
    ...(pluginId !== undefined ? { pluginId } : {}),
    ok: checks.every((c) => c.error === undefined),
    checks,
    ...(summary !== undefined ? { summary } : {}),
    ...(screenIds !== undefined ? { screens: [...screenIds] } : {}),
    ...(manifest !== undefined ? { manifest } : {}),
  };
}

/** Captures `client` references and `ui.screen` IDs via a non-mutating proxy around `ctx.ui`. */
function withClientCapture(
  definition: PluginDefinition,
  sink: Array<{ module: string; export: string }>,
  screenIds: string[],
): PluginDefinition {
  const original = definition.definePlugin;
  return {
    ...definition,
    async definePlugin(ctx) {
      const uiProxy = new Proxy(ctx.ui, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (typeof value !== 'function') return value;
          return (...args: unknown[]) => {
            const spec = args[0] as { client?: { module?: unknown; export?: unknown } } | undefined;
            const client = spec?.client;
            if (
              client !== undefined &&
              typeof client === 'object' &&
              typeof (client as { module?: unknown }).module === 'string' &&
              typeof (client as { export?: unknown }).export === 'string'
            ) {
              sink.push({
                module: (client as { module: string }).module,
                export: (client as { export: string }).export,
              });
            }
            if (prop === 'screen' && spec !== undefined && typeof (spec as { id?: unknown }).id === 'string') {
              screenIds.push((spec as { id: string }).id);
            }
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      }) as typeof ctx.ui;
      return original({ ...ctx, ui: uiProxy });
    },
  };
}

/** Runs `fn` inside a temporary scratch directory and deletes it on exit. */
async function withDoctorScratch<T>(fn: (scratch: string) => Promise<T>): Promise<T> {
  const scratch = mkdtempSync(join(tmpdir(), 'helmx-doctor-'));
  try {
    return await fn(scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
