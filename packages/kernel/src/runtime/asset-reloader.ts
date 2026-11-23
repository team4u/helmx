/**
 * Asset hot-reload coordinator: watches static asset changes and serially triggers debounced model and config reloads.
 *
 * Responsibilities:
 * 1. Watches only static asset paths (`providers.json` / `credentials.json` / `config.json` /
 *    `profiles/**` / `skills/**`), excluding `state.sqlite`, artifacts, workflows, and temp files;
 * 2. On `config.json` changes, refreshes the plugin config mirror (`pluginConfig.load`) and explicitly notifies on failure;
 * 3. On `providers.json` / `credentials.json` changes, debounces for 200ms then serially runs `reloadModels`;
 * 4. No-ops model reloads when `Models` is externally injected (`options.externalModels`), preserving caller ownership;
 * 5. Shutdown ordering guarantee: `stop()` halts new events and clears debounce timers first, then `waitForInflight()` awaits in-flight reloads.
 */

import { statSync } from 'node:fs'
import { join } from 'node:path'
import { AssetWatcher } from '../services/index.js'

interface AssetReloaderOptions {
  readonly dataDir: string
  /** True when `Models` is externally supplied (tests or external owners); `scheduleReloadModels` becomes a no-op so models are never replaced. */
  readonly externalModels?: boolean
  /** Trigger model reload (e.g., `modelsRegistry.reloadModels()`). */
  readonly reloadModels: () => Promise<void>
  /** Trigger plugin config mirror refresh (e.g., `pluginConfig.load()`). */
  readonly reloadPluginConfig: () => Promise<void>
  /** Optional callback to invalidate `ProfileService` in-memory cache when `profiles/**` changes on disk. */
  readonly invalidateProfiles?: () => void
  /** Error notification publisher (e.g., emitted as an event `'notification'`). */
  readonly notifyError: (title: string, error: unknown) => void
  /** Custom watcher factory (primarily for injecting mock watchers in tests). */
  readonly createWatcher?: (
    dir: string,
    onChange: (paths: string[]) => void,
    options: { recursive?: boolean; onError: (err: Error) => void },
  ) => { start(): void; close(): void }
}

const WATCHED_SUBDIRS = ['profiles', 'skills'] as const
type WatchedSubdir = (typeof WATCHED_SUBDIRS)[number]

function isExistingDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}

export class AssetReloader {
  private watcher: { start(): void; close(): void } | undefined
  private readonly subdirWatchers = new Map<WatchedSubdir, { start(): void; close(): void }>()
  /** Serialized `reloadModels` chain + debounce coalescing (shared by providers/credentials hot reloads). */
  private reloadChain: Promise<void> = Promise.resolve()
  /** In-flight `reloadPluginConfig` chain. */
  private reloadConfigChain: Promise<void> = Promise.resolve()
  private reloadTimer: NodeJS.Timeout | undefined
  private closed = false

  constructor(private readonly options: AssetReloaderOptions) {}

  private createWatcherInstance(
    dir: string,
    onChange: (paths: string[]) => void,
    recursive: boolean,
    onError: (err: Error) => void,
  ): { start(): void; close(): void } {
    const create =
      this.options.createWatcher ??
      ((targetDir, cb, opts) => new AssetWatcher(targetDir, cb, opts))
    return create(dir, onChange, { recursive, onError })
  }

  private ensureSubdirWatcher(subdir: WatchedSubdir): void {
    if (this.closed || this.subdirWatchers.has(subdir)) return
    const dir = join(this.options.dataDir, subdir)
    if (!isExistingDirectory(dir)) return
    const subWatcher = this.createWatcherInstance(
      dir,
      (changed) => {
        this.onAssetsChanged(changed.map((rel) => `${subdir}/${rel}`))
      },
      true,
      (err) => {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOENT') {
          subWatcher.close()
          if (this.subdirWatchers.get(subdir) === subWatcher) {
            this.subdirWatchers.delete(subdir)
          }
          return
        }
        this.options.notifyError('Asset hot-reload watcher failed', err)
      },
    )
    this.subdirWatchers.set(subdir, subWatcher)
    subWatcher.start()
  }

  /**
   * Start asset watching:
   * - Top-level `dataDir` is watched non-recursively (`{ recursive: false }`) for `providers.json`,
   *   `credentials.json`, and `config.json`, avoiding recursive inotify watches on `artifacts/`,
   *   SQLite WAL files, `plugins/`, and `installed-plugins/<pkg>/node_modules/`;
   * - Targeted recursive watchers (`{ recursive: true }`) attach ONLY to `profiles/` and `skills/`
   *   subdirectories (attached lazily if created after `start()`).
   */
  start(): void {
    if (this.closed || this.watcher) return
    this.watcher = this.createWatcherInstance(
      this.options.dataDir,
      (changed) => this.onAssetsChanged(changed),
      false,
      (err) => {
        // Watcher failures are explicitly notified rather than silently swallowed (hot reload degrades without affecting main flow).
        this.options.notifyError('Asset hot-reload watcher failed', err)
      },
    )
    this.watcher.start()
    for (const subdir of WATCHED_SUBDIRS) {
      this.ensureSubdirWatcher(subdir)
    }
  }

  /** Dispatch changed asset paths. */
  onAssetsChanged(changedPaths: string[]): void {
    if (this.closed) return
    let providersTouched = false
    let credentialsTouched = false
    let configTouched = false
    let profilesTouched = false
    let skillsTouched = false
    for (const rel of changedPaths) {
      const [head] = rel.split('/')
      if (head === 'providers.json') providersTouched = true
      else if (head === 'credentials.json') credentialsTouched = true
      else if (head === 'config.json') configTouched = true
      else if (head === 'profiles') profilesTouched = true
      else if (head === 'skills') skillsTouched = true
    }
    if (profilesTouched) {
      this.options.invalidateProfiles?.()
      if (this.watcher !== undefined) this.ensureSubdirWatcher('profiles')
    }
    if (skillsTouched && this.watcher !== undefined) {
      this.ensureSubdirWatcher('skills')
    }
    if (configTouched) {
      // Refresh plugin config mirror (explicitly notify on read failure rather than swallowing).
      this.reloadConfigChain = this.reloadConfigChain
        .then(() => (this.closed ? Promise.resolve() : this.options.reloadPluginConfig()))
        .catch((error) => {
          this.options.notifyError('Plugin config hot reload failed', error)
        })
    }
    if (providersTouched || credentialsTouched) {
      this.scheduleReloadModels()
    }
  }

  /** Debounce + serialize `reloadModels` (no-op when `Models` is externally injected). */
  scheduleReloadModels(): void {
    if (this.closed || this.options.externalModels) return
    if (this.reloadTimer !== undefined) clearTimeout(this.reloadTimer)
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = undefined
      if (this.closed) return
      this.reloadChain = this.reloadChain
        .then(() => (this.closed ? Promise.resolve() : this.options.reloadModels()))
        .catch((error) => {
          this.options.notifyError('Model config hot reload failed', error)
        })
    }, 200)
  }

  /**
   * Shutdown phase 1: stop watching and clear pending debounce timers so no new side effects are triggered.
   */
  stop(): void {
    this.closed = true
    if (this.reloadTimer !== undefined) {
      clearTimeout(this.reloadTimer)
      this.reloadTimer = undefined
    }
    this.watcher?.close()
    this.watcher = undefined
    for (const sub of this.subdirWatchers.values()) {
      sub.close()
    }
    this.subdirWatchers.clear()
  }

  /**
   * Shutdown phase 2: wait for in-flight `reloadModels` and `reloadPluginConfig` chains to settle.
   */
  async waitForInflight(): Promise<void> {
    await Promise.all([this.reloadChain, this.reloadConfigChain])
  }

  /** Full shutdown: `stop()` first to prevent new events, then await in-flight chains. */
  async close(): Promise<void> {
    this.stop()
    await this.waitForInflight()
  }
}
