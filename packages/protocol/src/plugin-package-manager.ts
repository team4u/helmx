/**
 * Managed plugin package port contracts (separates mechanism in `@helmx/kernel`
 * from package fetching/staging/store execution in `@helmx/plugin-build`).
 *
 * Zero `node:*`, zero `@earendil-works/pi-*`, zero `typebox` dependencies.
 */
import type { PluginBuildProvider } from './plugin-build.js'
import type {
  PluginDoctorReport,
  PluginInstallResult,
  PluginPackageRecord,
  PluginRemoveResult,
  PluginSummary,
  PluginUpdateResult,
} from './plugin-dto.js'

/** Minimal config read/write port required by `PluginPackageManagerStore` (structurally satisfied by `ConfigService`). */
export interface PluginPackagesConfigPort {
  get(): Promise<Record<string, unknown>>
  updateBy(mutate: (current: Record<string, unknown>) => Record<string, unknown>): Promise<Record<string, unknown>>
}

/** Host integration port required by `PluginPackageManager` (implemented by `PluginHost.asPackageManagerHost()`). */
export interface PackageManagerHost {
  registerManagedPlugin(dir: string, options: { enabled: boolean }): Promise<{ summary: PluginSummary; pluginId: string }>
  /** Enable after install (enable: true path; failure surfaces on diagnostic field without rolling back install). */
  enableManagedPlugin(pluginId: string): Promise<PluginSummary>
  /** Safety preflight before update swap: reject 409 on live tasks / busy providers without touching old instance or dir. */
  assertManagedPluginUpdateSafe(pluginId: string): Promise<void> | void
  updateManagedPlugin(pluginId: string, dir: string, options: { keepEnabled: boolean }): Promise<{ summary: PluginSummary }>
  /** Broadcast updated `plugin.changed` after package record persistence so SSE listeners receive `managed` metadata. */
  notifyManagedPluginChanged(pluginId: string): void
  removeManagedPlugin(pluginId: string): Promise<{ wasEnabled: boolean }>
  /**
   * Purge persisted plugin data (global docs + session docs) on remove and await durable DELETE flush;
   * rejects explicitly on failure so the directory and record remain intact for retry.
   */
  purgePluginPersistentData(pluginId: string): Promise<void>
  listSummaries(): PluginSummary[]
  /** Static self-check of a staged or local plugin directory. */
  doctorDir(dir: string, options?: { buildProvider?: PluginBuildProvider }): Promise<PluginDoctorReport>
  /** Verify a declared or conventional prebuilt frontend directory (`clientDist` / `dist-client/`). */
  verifyPrebuiltDir(dir: string): string | undefined
  /** Read frontend managed npm dependencies declared in `plugin.json` / `package.json#helmx`. */
  readClientDependencies(dir: string): string[]
  /** Resolve the external plugin code root directory (`<dataDir>/installed-plugins`). */
  externalPluginsDir(dataDir: string): string
}

/** Managed plugin package lifecycle port (implemented by `@helmx/plugin-build` `PluginPackageManager`). */
export interface PluginPackageManagerPort {
  load(): Promise<void>
  install(source: string, options?: { enable?: boolean }): Promise<PluginInstallResult>
  update(pluginId: string, options?: { source?: string }): Promise<PluginUpdateResult>
  remove(pluginId: string): Promise<PluginRemoveResult>
  getRecord(pluginId: string): PluginPackageRecord | undefined
  listRecords(): PluginPackageRecord[]
}

/** Context passed by `KernelRuntime` / `PluginHost` to instantiate a `PluginPackageManagerPort`. */
export interface PluginPackageManagerProviderContext {
  dataDir: string
  cwd: string
  config: PluginPackagesConfigPort
  host: PackageManagerHost
  buildProvider?: PluginBuildProvider
}

/**
 * Factory/provider port injecting managed plugin package support into `KernelRuntime` / `PluginHost`.
 * When omitted, managed install/update/remove reject explicitly with `501 unsupported_package_manager`.
 */
export type PluginPackageManagerProvider = (
  context: PluginPackageManagerProviderContext,
) => PluginPackageManagerPort
