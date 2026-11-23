/**
 * Static doctor diagnostics for external plugin directories: executes real load + real registration
 * checks rather than a separate approximate validator.
 *
 * Pipeline:
 * 1. Manifest & entry resolution (`resolvePluginEntry`);
 * 2. Backend isolation import (`importPluginDefinition`);
 * 3. Temporary `PluginHost` registration (`definePlugin` checks with a `doctorBackend` whose
 *    runtime ports throw 501 explicitly);
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
  PluginHost,
  type PluginHostBackend,
  type PluginKvStore,
  type PluginSessionDocStore,
} from './plugin-host.js';
import { dryRunManifestSinks } from './plugin-host-lifecycle.js';
import { nextPluginGeneration, registerPluginTsRoot } from './backend-ts-loader.js';
import {
  importPluginDefinition,
  normalizeDefinition,
  resolvePluginEntry,
} from './external-loader.js';
import { readPrebuiltClientBundle, verifyPrebuiltClientDir } from './ui-registry.js';

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
    const items = pageKeys.map((key) => ({ key, ...byKey.get(key)! }));
    return { items, ...(hasMore && items.length > 0 ? { nextCursor: items[items.length - 1]!.key } : {}) };
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
 * Doctor backend: every runtime `ctx.host.*` capability throws 501 explicitly (never mocks data).
 * Only read-only structural primitives required to construct/register (`isClosing`, identity `redact`,
 * no-op `onEvent` for top-level listener registration, and no-op `emitEvent` for registration summary
 * notifications) are provided.
 */
function doctorBackend(): PluginHostBackend {
  const unavailable = (what: string): never => {
    throw new HelmxError(
      'unsupported',
      `Doctor static check does not provide host runtime capability '${what}' (plugins must not invoke host ports at top level of definePlugin)`,
      501,
    );
  };
  const port = (name: string) =>
    new Proxy({} as Record<string, never>, {
      get: (_t, prop) => () => unavailable(`host.${name}.${String(prop)}`),
    });
  const overrides: Record<PropertyKey, unknown> = {
    isClosing: () => false,
    redact: (text: string) => text,
    profiles: port('profiles'),
    skills: port('skills'),
    secrets: port('secrets'),
    nodeIpc: undefined,
    openTunnel: undefined,
    listActiveSpawnExecutions: () => [],
    // Event subscription/emission during definePlugin & registration summary (plugin.changed): safe no-op with no SSE consumers.
    onEvent: () => () => {},
    emitEvent: () => {},
    withFileLock: <T,>(_path: string, fn: () => Promise<T>): Promise<T> => fn(),
  };
  return new Proxy(overrides, {
    get(target, prop) {
      if (Reflect.has(target, prop)) return Reflect.get(target, prop);
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      return () => unavailable(`host.${prop}`);
    },
  }) as unknown as PluginHostBackend;
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
  options: { buildProvider?: PluginBuildProvider } = {},
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
  options: { buildProvider?: PluginBuildProvider },
): Promise<PluginDoctorReport> {
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

  let definition: PluginDefinition | undefined;
  if (!entryOk) return report(dir, undefined, checks, undefined);

  const backendOk = await push('backend', 'backend module isolated import', async () => {
    const generation = nextPluginGeneration(dir);
    definition = normalizeDefinition(await importPluginDefinition(dir, entryPath!, { generation }), dir);
  });
  if (!backendOk || definition === undefined) return report(dir, undefined, checks, undefined);

  const clientRefs: Array<{ module: string; export: string }> = [];
  const screenIds: string[] = [];
  let summary: PluginSummary | undefined;
  let manifest: PluginManifestProjection | undefined;
  // Isolate registration and compilation checks inside a temporary scratch dir to avoid mutating host data.
  const registerOk = await withDoctorScratch(async (scratch) =>
    push('register', 'real registration dry-run', async () => {
      let host: PluginHost | undefined;
      const wrapped = withClientCapture(definition!, clientRefs, screenIds);
      dryRunManifestSinks.set(wrapped, (projected) => {
        manifest = projected;
      });
      try {
        host = new PluginHost({
          dataDir: scratch,
          host: doctorBackend(),
          docs: new DoctorDocStore(),
          sessionDocs: new DoctorSessionDocStore(),
          kv: new DoctorKvStore(),
          deferServices: true,
          buildProvider: options.buildProvider,
        });
        await host.register(wrapped, { enabled: false });
        const found = host.list().find((s) => s.id === definition!.id);
        if (!found) {
          throw new HelmxError(
            'invalid_plugin_definition',
            `Plugin ${definition!.id} not found in host summary after registration (inconsistent doctor state)`,
            500,
            { dir, pluginId: definition!.id },
          );
        }
        summary = found;
      } finally {
        dryRunManifestSinks.delete(wrapped);
        await host?.dispose().catch(() => {});
      }
    }),
  );
  if (!registerOk) return report(dir, definition.id, checks, undefined);

  const clientOk = await withDoctorScratch(async (scratch) =>
    push('client', 'frontend module compilation and export validation', async () => {
      if (definition!.prebuiltClientDir !== undefined) {
        verifyPrebuiltClientDir(definition!.prebuiltClientDir, definition!.id);
        const seen = new Set<string>();
        for (const ref of clientRefs) {
          const key = `${ref.module}#${ref.export}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const prebuilt = readPrebuiltClientBundle(
            definition!.prebuiltClientDir,
            ref.module,
            undefined,
            definition!.id,
          );
          if (!prebuilt.exports.includes(ref.export)) {
            throw new HelmxError(
              'invalid_client_export',
              `Plugin ${definition!.id} client reference ${ref.module}#${ref.export} is dangling: module exports [${prebuilt.exports.join(', ') || 'none'}]`,
              422,
              { pluginId: definition!.id, module: ref.module, export: ref.export, exports: prebuilt.exports },
            );
          }
        }
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
      if (options.buildProvider === undefined) return;
      const npmRoots = clientNpmRootsOf(definition!.npmDependencies);
      const seen = new Set<string>();
      for (const ref of clientRefs) {
        const key = `${ref.module}#${ref.export}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const compiled = await options.buildProvider.compileClientModule({
          pluginId: definition!.id,
          clientRoot: definition!.clientRoot!,
          moduleRef: ref.module,
          cacheDir: scratch,
          npmRoots,
        });
        // Reject missing named exports so dangling UI declarations fail during doctor rather than silently rendering blank.
        if (!compiled.exports.includes(ref.export)) {
          throw new HelmxError(
            'invalid_client_export',
            `Plugin ${definition!.id} client reference ${ref.module}#${ref.export} is dangling: module exports [${compiled.exports.join(', ') || 'none'}]`,
            422,
            { pluginId: definition!.id, module: ref.module, export: ref.export, exports: compiled.exports },
          );
        }
      }
    }),
  );
  void clientOk;

  return report(dir, definition.id, checks, summary, screenIds, manifest);
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
