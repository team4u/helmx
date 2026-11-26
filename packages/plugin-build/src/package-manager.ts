/**
 * External plugin package management: install / update / remove transactions.
 *
 * Follows pi's source model (npm / git / local), with helmx semantics:
 * staging copy + full doctor preflight + atomic move into managed directory +
 * persisted record + registration into PluginHost. No marketplace DB, versioned pool,
 * or migration scripts.
 */
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  HelmxError,
  isCoreNamespace,
  isReservedPluginNamespace,
  type PackageManagerHost,
  type PluginBuildProvider,
  type PluginDoctorReport,
  type PluginInstallResult,
  type PluginPackageManagerPort,
  type PluginPackageManagerProviderContext,
  type PluginPackageRecord,
  type PluginPackageSource,
  type PluginRemoveResult,
  type PluginSummary,
  type PluginUpdateResult,
} from '@helmx/protocol';
import { parsePluginSource } from './package-source.js';
import { PluginPackageManagerStore } from './package-store.js';
import {
  commandError,
  defaultPackageRunner,
  type PackageRunner,
  type RunResult,
} from './package-runner.js';
import {
  assertInsideDataDir,
  canonicalLocalPath,
  computeDirectoryDigest,
  fetchIntoStaging,
  installRuntimeDeps,
  isDirectoryPath,
  pathExists,
  readDeclaredPluginId,
  safeDirName,
  samePackageSource,
  type PackageStage,
} from './package-fs.js';

export {
  createPackageRunner,
  defaultPackageRunner,
  tailLines,
  type PackageRunner,
  type PackageRunnerOptions,
  type RunResult,
} from './package-runner.js';

export interface PluginPackageManagerOptions {
  dataDir: string;
  /** Hub working directory (base directory for resolving relative local paths). */
  cwd: string;
  store: PluginPackageManagerStore;
  host: PackageManagerHost;
  runner?: PackageRunner;
  /** Per-command timeout in ms (defaults to 120s). */
  commandTimeoutMs?: number;
  /**
   * Plugin build port (shared instance with PluginHostOptions.buildProvider):
   * used during doctor preflight for client module compilation and backend TS transpilation.
   */
  buildProvider?: PluginBuildProvider;
}

export interface CreatePluginPackageManagerOptions extends PluginPackageManagerProviderContext {
  runner?: PackageRunner;
  commandTimeoutMs?: number;
}

/** Creates a `PluginPackageManager` backed by a `PluginPackageManagerStore` over `options.config`. */
export function createPluginPackageManager(
  options: CreatePluginPackageManagerOptions,
): PluginPackageManager {
  return new PluginPackageManager({
    dataDir: options.dataDir,
    cwd: options.cwd,
    store: new PluginPackageManagerStore(options.config),
    host: options.host,
    ...(options.runner !== undefined ? { runner: options.runner } : {}),
    ...(options.commandTimeoutMs !== undefined ? { commandTimeoutMs: options.commandTimeoutMs } : {}),
    ...(options.buildProvider !== undefined ? { buildProvider: options.buildProvider } : {}),
  });
}

function errorDetail(err: unknown): { message: string; stack?: string } | undefined {
  return err instanceof Error ? { message: err.message, stack: err.stack } : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Plugin package manager: all install/update/remove operations are serialized through a manager-level queue,
 * while PluginHost maintains its own per-plugin lifecycle queue.
 */
export class PluginPackageManager implements PluginPackageManagerPort {
  private readonly dataDir: string;
  private readonly cwd: string;
  private readonly store: PluginPackageManagerStore;
  private readonly host: PackageManagerHost;
  private readonly runner: PackageRunner;
  private readonly timeoutMs: number;
  private readonly buildProvider?: PluginBuildProvider;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(options: PluginPackageManagerOptions) {
    this.dataDir = options.dataDir;
    this.cwd = options.cwd;
    this.store = options.store;
    this.host = options.host;
    this.runner = options.runner ?? defaultPackageRunner;
    this.timeoutMs = options.commandTimeoutMs ?? 120_000;
    this.buildProvider = options.buildProvider;
  }

  async load(): Promise<void> {
    await this.store.load();
  }

  getRecord(pluginId: string): PluginPackageRecord | undefined {
    return this.store.getRecord(pluginId);
  }

  listRecords(): PluginPackageRecord[] {
    return this.store.listRecords();
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.chain.then(fn, fn);
    this.chain = task.catch(() => undefined);
    return task;
  }

  private pluginsDir(): string {
    return this.host.externalPluginsDir(this.dataDir);
  }

  private stagingRoot(): string {
    return join(this.pluginsDir(), '.staging');
  }

  private async ensureStagingRoot(): Promise<string> {
    const root = this.stagingRoot();
    await mkdir(root, { recursive: true });
    return root;
  }

  private run = async (
    cmd: string,
    args: string[],
    opts?: { cwd?: string; stage?: PackageStage },
  ): Promise<RunResult> => {
    const stage = opts?.stage ?? 'install';
    const workDir = opts?.cwd ?? (await this.ensureStagingRoot());
    const result = await this.runner(cmd, args, { cwd: workDir, timeoutMs: this.timeoutMs });
    // npm pack non-zero exits are handled by callers for tarball-specific diagnostics.
    const isNpmPack = cmd === 'npm' && args[0] === 'pack';
    if (result.code !== 0 && !isNpmPack) {
      throw commandError(stage, cmd, args, result);
    }
    return result;
  };

  /** Prepare staged payload, install runtime deps, and run doctor once. */
  private async stageAndInspect(
    source: PluginPackageSource,
    staging: string,
    stage: PackageStage,
  ): Promise<{ payloadDir: string; pluginId: string; dirName: string; report: PluginDoctorReport }> {
    const payloadDir = await fetchIntoStaging(source, staging, this.pluginsDir(), this.run, stage);
    await installRuntimeDeps(payloadDir, this.host, this.run, stage);
    const identified = await this.identifyPlugin(payloadDir, source);
    return { payloadDir, ...identified };
  }

  private assertDoctorPassed(
    report: PluginDoctorReport,
    source: PluginPackageSource,
    payloadDir: string,
    stage: PackageStage,
  ): void {
    if (report.ok) return;
    const first = report.checks.find((c) => c.error !== undefined);
    const detail = first ? `${first.label}: ${first.error!.message}` : 'unknown check failed';
    const suffix = stage === 'install' ? 'aborting install' : 'keeping existing installation';
    throw new HelmxError(
      'plugin_package_doctor_failed',
      `plugin package ${stage} preflight failed (${detail}); ${suffix}`,
      422,
      { source, staging: payloadDir, report },
    );
  }

  private async tryEnablePlugin(
    pluginId: string,
    currentSummary: PluginSummary,
  ): Promise<{ summary: PluginSummary; enableError?: { message: string; code: string } }> {
    try {
      return { summary: await this.host.enableManagedPlugin(pluginId) };
    } catch (err) {
      const fallback = this.host.listSummaries().find((s) => s.id === pluginId);
      return {
        summary: { ...currentSummary, ...(fallback !== undefined ? { enabled: fallback.enabled } : {}) },
        enableError: {
          message: errorMessage(err),
          code: err instanceof HelmxError ? err.code : 'plugin_enable_failed',
        },
      };
    }
  }

  /**
   * Atomically swap `target` with `payloadDir`, run `commitTransaction`, and roll back both directory
   * and plugin instance if `commitTransaction` throws. Reports rollback failures honestly.
   */
  private async atomicSwapAndCommit<T>(params: {
    pluginId: string;
    target: string;
    payloadDir: string;
    staging: string;
    restoreOldInstance: boolean;
    operationLabel: string;
    commitTransaction: () => Promise<T>;
  }): Promise<T> {
    const { pluginId, target, payloadDir, staging, restoreOldInstance, operationLabel, commitTransaction } = params;
    assertInsideDataDir(this.pluginsDir(), target);
    const backup = join(staging, 'backup');
    if (await pathExists(target)) {
      await rename(target, backup);
    }
    try {
      await rename(payloadDir, target);
    } catch (swapErr) {
      let restoreError: { message: string } | undefined;
      if (await pathExists(backup)) {
        try {
          await rename(backup, target);
        } catch (err) {
          restoreError = { message: errorMessage(err) };
        }
      }
      if (restoreError !== undefined) {
        throw new HelmxError(
          'plugin_package_update_failed',
          `plugin ${pluginId} directory swap failed (${errorMessage(swapErr)}) and backup restore failed (${restoreError.message}); previous directory remains at ${backup}`,
          500,
          {
            pluginId,
            installPath: target,
            rolledBack: false,
            rollbackError: restoreError,
            cause: errorDetail(swapErr),
          },
        );
      }
      throw swapErr;
    }

    try {
      return await commitTransaction();
    } catch (commitErr) {
      let rollbackError: { message: string } | undefined;
      try {
        await rename(target, join(staging, 'failed-new'));
        if (await pathExists(backup)) await rename(backup, target);
      } catch (rollbackErr) {
        rollbackError = {
          message: `directory restore failed: ${errorMessage(rollbackErr)}; manual inspection of managed directory required`,
        };
      }
      if (rollbackError === undefined && restoreOldInstance) {
        try {
          await this.host.updateManagedPlugin(pluginId, target, { keepEnabled: true });
        } catch (restoreErr) {
          rollbackError = {
            message: `previous directory restored, but reloading the previous plugin instance failed: ${errorMessage(restoreErr)}; plugin may be unregistered and require manual recovery`,
          };
        }
      }
      throw new HelmxError(
        'plugin_package_update_failed',
        `plugin ${pluginId} ${operationLabel} failed (${rollbackError === undefined ? 'rolled back to previous directory and instance' : `incomplete rollback: ${rollbackError.message}`}): ${errorMessage(commitErr)}`,
        500,
        {
          pluginId,
          installPath: target,
          rolledBack: rollbackError === undefined,
          ...(rollbackError !== undefined ? { rollbackError } : {}),
          cause: errorDetail(commitErr),
        },
      );
    }
  }

  // --- install -------------------------------------------------------------

  /**
   * Install a plugin package: parse source -> fetch into staging -> install runtime deps ->
   * doctor preflight -> atomic move into managed directory -> persist record -> register.
   */
  async install(source: string, options: { enable?: boolean } = {}): Promise<PluginInstallResult> {
    const parsed = parsePluginSource(source, this.cwd);
    return this.enqueue(async () => {
      await this.ensureStagingRoot();
      const staging = await mkdtemp(join(this.stagingRoot(), 'pkg-'));
      try {
        const { payloadDir, pluginId, dirName, report } = await this.stageAndInspect(parsed, staging, 'install');
        this.assertDoctorPassed(report, parsed, payloadDir, 'install');

        const existingRecord = this.store.getRecord(pluginId);
        if (existingRecord !== undefined) {
          const sameLocalSource =
            parsed.kind === 'local' &&
            existingRecord.source.kind === 'local' &&
            (await canonicalLocalPath(parsed.path)) === (await canonicalLocalPath(existingRecord.source.path));
          if (sameLocalSource) {
            return await this.reinstallSameLocalSource(existingRecord, parsed, payloadDir, staging, options);
          }
          throw new HelmxError(
            'plugin_package_already_installed',
            `plugin ${pluginId} is already installed via package manager (run update or remove before reinstalling)`,
            409,
            { pluginId },
          );
        }
        if (this.host.listSummaries().some((s) => s.id === pluginId)) {
          throw new HelmxError(
            'plugin_package_already_installed',
            `plugin ${pluginId} is already registered (possibly manually placed in plugins directory); refusing duplicate install`,
            409,
            { pluginId },
          );
        }
        const target = join(this.pluginsDir(), safeDirName(dirName));
        assertInsideDataDir(this.pluginsDir(), target);
        if (await pathExists(target)) {
          throw new HelmxError(
            'plugin_package_target_occupied',
            `install target directory already exists (untracked leftover; inspect and clean up manually): ${target}`,
            409,
            { pluginId, target },
          );
        }
        await mkdir(dirname(target), { recursive: true });
        await rename(payloadDir, target);
        return await this.registerAndPersistInstall(pluginId, parsed, target, options);
      } finally {
        await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  }

  private async registerAndPersistInstall(
    pluginId: string,
    parsed: PluginPackageSource,
    target: string,
    options: { enable?: boolean },
  ): Promise<PluginInstallResult> {
    let registered: Awaited<ReturnType<PackageManagerHost['registerManagedPlugin']>>;
    try {
      registered = await this.host.registerManagedPlugin(target, { enabled: false });
    } catch (err) {
      if (this.host.listSummaries().some((s) => s.id === pluginId)) {
        throw new HelmxError(
          'plugin_package_install_failed',
          `Plugin ${pluginId} registration failed after install: same name plugin registered concurrently; keeping existing directory and instance without managed record: ${errorMessage(err)}`,
          500,
          { pluginId, target, rolledBack: false, cause: errorDetail(err) },
        );
      }
      let rmError: unknown;
      try {
        await rm(target, { recursive: true, force: true });
      } catch (e) {
        rmError = e;
      }
      if (rmError !== undefined) {
        throw new HelmxError(
          'plugin_package_install_failed',
          `Plugin ${pluginId} registration failed and rollback directory removal failed (${errorMessage(rmError)}): ${errorMessage(err)}`,
          500,
          {
            pluginId,
            target,
            rolledBack: false,
            rollbackError: { message: errorMessage(rmError) },
            cause: errorDetail(err),
          },
        );
      }
      throw new HelmxError(
        'plugin_package_install_failed',
        `Plugin ${pluginId} registration failed after install; rolled back and deleted directory: ${errorMessage(err)}`,
        500,
        { pluginId, target, rolledBack: true, cause: errorDetail(err) },
      );
    }

    let summary = registered.summary;
    let enableError: { message: string; code: string } | undefined;
    if (options.enable === true) {
      ({ summary, enableError } = await this.tryEnablePlugin(registered.pluginId, summary));
    }

    let record: PluginPackageRecord;
    try {
      record = await this.store.save({
        pluginId: registered.pluginId,
        source: parsed,
        installPath: target,
        version: summary.version ?? '',
        installedAt: Date.now(),
        updatedAt: Date.now(),
      });
    } catch (err) {
      let unregisterError: unknown;
      try {
        await this.host.removeManagedPlugin(registered.pluginId);
      } catch (removeErr) {
        unregisterError = removeErr;
      }
      if (unregisterError === undefined) {
        let rmError: unknown;
        try {
          await rm(target, { recursive: true, force: true });
        } catch (e) {
          rmError = e;
        }
        if (rmError !== undefined) {
          throw new HelmxError(
            'plugin_package_install_failed',
            `Plugin ${pluginId} failed to persist install record, unregistered instance, but failed to delete directory (${errorMessage(rmError)}): ${errorMessage(err)}`,
            500,
            {
              pluginId,
              target,
              rolledBack: false,
              rollbackError: { message: errorMessage(rmError) },
              cause: errorDetail(err),
            },
          );
        }
        throw new HelmxError(
          'plugin_package_install_failed',
          `Plugin ${pluginId} failed to persist install record; rolled back (unregistered and deleted directory): ${errorMessage(err)}`,
          500,
          { pluginId, target, rolledBack: true, cause: errorDetail(err) },
        );
      }
      throw new HelmxError(
        'plugin_package_install_failed',
        `Plugin ${pluginId} failed to persist install record, and rollback unregister failed (${errorMessage(unregisterError)}); directory and instance preserved for manual recovery`,
        500,
        {
          pluginId,
          target,
          rolledBack: false,
          cause: errorDetail(err),
          rollbackError: {
            message: errorMessage(unregisterError),
            ...(unregisterError instanceof Error && unregisterError.stack !== undefined
              ? { stack: unregisterError.stack }
              : {}),
          },
        },
      );
    }

    this.host.notifyManagedPluginChanged(registered.pluginId);
    return {
      record,
      summary: this.attachManaged(summary, record),
      ...(enableError !== undefined ? { enableError } : {}),
    };
  }

  /** Idempotent hot update/reinstall for an already-installed plugin from the same canonical local directory. */
  private async reinstallSameLocalSource(
    existingRecord: PluginPackageRecord,
    parsed: Extract<PluginPackageSource, { kind: 'local' }>,
    payloadDir: string,
    staging: string,
    options: { enable?: boolean },
  ): Promise<PluginInstallResult> {
    const pluginId = existingRecord.pluginId;
    const isRegistered = this.host.listSummaries().some((s) => s.id === pluginId);
    if (isRegistered) {
      await this.host.assertManagedPluginUpdateSafe(pluginId);
    }
    const target = existingRecord.installPath;
    return await this.atomicSwapAndCommit({
      pluginId,
      target,
      payloadDir,
      staging,
      restoreOldInstance: isRegistered,
      operationLabel: 'reinstall reload',
      commitTransaction: async () => {
        let { summary } = isRegistered
          ? await this.host.updateManagedPlugin(pluginId, target, { keepEnabled: true })
          : await this.host.registerManagedPlugin(target, { enabled: false });
        let enableError: { message: string; code: string } | undefined;
        if (options.enable !== false && !summary.enabled) {
          ({ summary, enableError } = await this.tryEnablePlugin(pluginId, summary));
        }
        const updated = await this.store.save({
          pluginId,
          source: parsed,
          installPath: target,
          version: summary.version ?? '',
          installedAt: existingRecord.installedAt,
          updatedAt: Date.now(),
        });
        this.host.notifyManagedPluginChanged(pluginId);
        return {
          record: updated,
          summary: this.attachManaged(summary, updated),
          ...(enableError !== undefined ? { enableError } : {}),
        };
      },
    });
  }

  /** Attach managed package metadata (`PluginSummary.managed`). */
  private attachManaged(summary: PluginSummary, record: PluginPackageRecord): PluginSummary {
    return {
      ...summary,
      managed: {
        source: record.source,
        installId: record.id,
        installedVersion: record.version,
        installedAt: record.updatedAt,
      },
    };
  }

  // --- update -------------------------------------------------------------

  /**
   * Atomically update an installed plugin package with digest short-circuit and rollback on failure.
   */
  async update(pluginId: string, options: { source?: string } = {}): Promise<PluginUpdateResult> {
    const overrideSource = options.source !== undefined ? parsePluginSource(options.source, this.cwd) : undefined;
    return this.enqueue(async () => {
      const record = this.store.getRecord(pluginId);
      if (record === undefined) {
        throw new HelmxError('unknown_plugin_package', `plugin ${pluginId} has no managed install record (only managed packages can be updated)`, 404, { pluginId });
      }
      const targetSource = overrideSource ?? record.source;
      await this.host.assertManagedPluginUpdateSafe(pluginId);
      await this.ensureStagingRoot();
      const staging = await mkdtemp(join(this.stagingRoot(), 'pkg-'));
      try {
        const { payloadDir, pluginId: identifiedId, report } = await this.stageAndInspect(targetSource, staging, 'update');
        if (identifiedId !== pluginId) {
          throw new HelmxError(
            'plugin_package_id_changed',
            `plugin id changed during update (expected ${pluginId}, actual ${identifiedId}); rejecting replacement`,
            409,
            { pluginId, actualId: identifiedId },
          );
        }
        this.assertDoctorPassed(report, targetSource, payloadDir, 'update');

        const target = record.installPath;
        assertInsideDataDir(this.pluginsDir(), target);
        const previousVersion = record.version;
        const currentSummary = this.host.listSummaries().find((s) => s.id === pluginId);
        const targetIsHealthy =
          currentSummary !== undefined &&
          currentSummary.error === undefined &&
          currentSummary.status !== 'failed';
        if (targetIsHealthy && (await isDirectoryPath(target))) {
          const [currentDigest, nextDigest] = await Promise.all([
            computeDirectoryDigest(target),
            computeDirectoryDigest(payloadDir),
          ]);
          if (currentDigest === nextDigest) {
            if (samePackageSource(record.source, targetSource)) {
              return {
                record,
                summary: this.attachManaged(currentSummary, record),
                changed: false,
                previousVersion,
              };
            }
            const updated = await this.store.save({
              pluginId,
              source: targetSource,
              installPath: target,
              version: currentSummary.version ?? record.version,
              installedAt: record.installedAt,
              updatedAt: Date.now(),
            });
            this.host.notifyManagedPluginChanged(pluginId);
            return {
              record: updated,
              summary: this.attachManaged(currentSummary, updated),
              changed: false,
              previousVersion,
            };
          }
        }

        return await this.atomicSwapAndCommit({
          pluginId,
          target,
          payloadDir,
          staging,
          restoreOldInstance: true,
          operationLabel: 'update reload',
          commitTransaction: async () => {
            const { summary } = await this.host.updateManagedPlugin(pluginId, target, { keepEnabled: true });
            const updated = await this.store.save({
              pluginId,
              source: targetSource,
              installPath: target,
              version: summary.version ?? '',
              installedAt: record.installedAt,
              updatedAt: Date.now(),
            });
            this.host.notifyManagedPluginChanged(pluginId);
            return {
              record: updated,
              summary: this.attachManaged(summary, updated),
              changed: true,
              previousVersion,
            };
          },
        });
      } finally {
        await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  }

  // --- remove -------------------------------------------------------------

  /**
   * Remove a managed plugin installation: unregister -> purge persistent docs -> delete managed dir -> delete record.
   */
  async remove(pluginId: string): Promise<PluginRemoveResult> {
    return this.enqueue(async () => {
      if (isReservedPluginNamespace(pluginId)) {
        const kind = isCoreNamespace(pluginId) ? 'core capability namespace' : 'built-in plugin';
        throw new HelmxError('plugin_locked', `${kind} ${pluginId} cannot be removed`, 403, { pluginId });
      }
      const record = this.store.getRecord(pluginId);
      if (record === undefined) {
        throw new HelmxError('unknown_plugin_package', `plugin ${pluginId} has no managed install record (delete manually placed plugin directories directly)`, 404, { pluginId });
      }
      const { wasEnabled } = await this.host.removeManagedPlugin(pluginId);
      await this.host.purgePluginPersistentData(pluginId);
      const target = record.installPath;
      assertInsideDataDir(this.pluginsDir(), target);
      await rm(target, { recursive: true, force: true });
      await this.store.delete(pluginId);
      return { pluginId, installPath: target, wasEnabled, installId: record.id };
    });
  }

  /** Identify plugin id and run full doctor preflight once on the staged payload. */
  private async identifyPlugin(
    payloadDir: string,
    source: PluginPackageSource,
  ): Promise<{ pluginId: string; dirName: string; report: PluginDoctorReport }> {
    const report = await this.host.doctorDir(
      payloadDir,
      this.buildProvider !== undefined ? { buildProvider: this.buildProvider } : undefined,
    );
    if (report.ok && report.pluginId !== undefined) {
      return { pluginId: report.pluginId, dirName: report.pluginId, report };
    }
    const declared = await readDeclaredPluginId(payloadDir);
    if (declared !== undefined) {
      return { pluginId: declared, dirName: declared, report };
    }
    throw new HelmxError(
      'plugin_package_doctor_failed',
      `cannot determine plugin id (doctor failed and manifest declares no id): ${source.raw}`,
      422,
      { source, report },
    );
  }
}
