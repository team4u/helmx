/**
 * PluginHost: strongly typed plugin host for `definePlugin(ctx)`.
 *
 * Extends `PluginHostCore` (lifecycle, capabilities, hooks, config, documents, and tracking)
 * with external plugin DX (`doctor`, `reload`, `rescan`) and managed package manager delegation.
 */
import {
  HelmxError,
  type PackageManagerHost,
  type PluginDoctorReport,
  type PluginInstallResult,
  type PluginPackageManagerPort,
  type PluginReloadResult,
  type PluginRemoveResult,
  type PluginRescanResult,
  type PluginUpdateResult,
} from '@helmx/protocol';
import { ConfigService } from '../services/config.js';
import type { PluginHostOptions } from './types.js';
import { PluginHostCore, type PluginRegisterOptions } from './plugin-host-core.js';
import {
  createPackageManagerHost,
  doctorExternalPluginDir,
  reloadExternalPluginFlow,
  rescanExternalPluginDirs,
  type DxCoordinatorDeps,
} from './plugin-host-dx.js';

export type { PluginDocStore, PluginSessionDocStore, PluginDocRegistryOptions } from './doc-registry.js';
export { PLUGIN_DOC_MAX_JSON_BYTES } from './doc-registry.js';
export type { PluginKvStore, PluginKvRawEntry, PluginKvRegistryOptions } from './kv-registry.js';
export { PLUGIN_KV_MAX_VALUE_BYTES } from './kv-registry.js';
export { CAPABILITY_ID_PATTERN } from './capability-service-registry.js';
export {
  type ActionCallerIdentity,
  type ActionInvocationSurface,
  type DerivedToolSpec,
  type PluginRouteEntry,
  PROVIDER_SAFE_TOOL_NAME,
  actionToolAlias,
} from './capability-registry.js';
export type {
  PluginConfigStore,
  PluginHostBackend,
  PluginHostOptions,
  PluginPhase,
  PluginProviderPort,
  PluginState,
} from './types.js';
export type { PluginRegisterOptions };

export class PluginHost extends PluginHostCore {
  constructor(options: PluginHostOptions) {
    super(options);
    if (options.packageManagerProvider !== undefined) {
      this.packageManager = options.packageManagerProvider({
        dataDir: options.dataDir,
        cwd: options.cwd ?? options.dataDir,
        config: options.packagesConfig ?? new ConfigService(options.dataDir),
        host: this.asPackageManagerHost(),
        buildProvider: options.buildProvider,
      });
    }
  }

  async doctorExternalPlugin(target: { dir?: string; id?: string }): Promise<PluginDoctorReport> {
    this.assertNotDisposed();
    return doctorExternalPluginDir(
      {
        dataDir: this.options.dataDir,
        buildProvider: this.options.buildProvider,
        createDoctorHost: (opts) => new PluginHostCore(opts),
      },
      target,
    );
  }

  async reloadExternalPlugin(pluginId: string, options: { doctor?: boolean } = {}): Promise<PluginReloadResult> {
    this.assertNotDisposed();
    return reloadExternalPluginFlow(this.dxDeps(), pluginId, options);
  }

  async rescanExternalPlugins(): Promise<PluginRescanResult> {
    this.assertNotDisposed();
    return rescanExternalPluginDirs(this.options.dataDir, this);
  }

  async loadPackageManager(): Promise<void> {
    this.assertNotDisposed();
    if (this.packageManager !== undefined) {
      await this.packageManager.load();
    }
  }

  asPackageManagerHost(): PackageManagerHost {
    return createPackageManagerHost(this.dxDeps());
  }

  private requirePackageManager(): PluginPackageManagerPort {
    if (this.packageManager === undefined) {
      throw new HelmxError(
        'unsupported_package_manager',
        'Current kernel has not wired the plugin package manager (managed install/update/remove unavailable)',
        501,
      );
    }
    return this.packageManager;
  }

  async installPluginPackage(source: string, options: { enable?: boolean } = {}): Promise<PluginInstallResult> {
    this.assertNotDisposed();
    return this.requirePackageManager().install(source, options);
  }

  async updatePluginPackage(pluginId: string, options: { source?: string } = {}): Promise<PluginUpdateResult> {
    this.assertNotDisposed();
    return this.requirePackageManager().update(pluginId, options);
  }

  async removePluginPackage(pluginId: string): Promise<PluginRemoveResult> {
    this.assertNotDisposed();
    return this.requirePackageManager().remove(pluginId);
  }

  private dxDeps(): DxCoordinatorDeps {
    return {
      dataDir: this.options.dataDir,
      buildProvider: this.options.buildProvider,
      createDoctorHost: (opts) => new PluginHostCore(opts),
      plugins: this.plugins,
      tracker: this.tracker,
      providers: this.options.providers,
      docRegistry: this.docRegistry,
      kvRegistry: this.kvRegistry,
      host: this,
    };
  }
}
