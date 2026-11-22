/**
 * Plugin service post-startup reconciliation lifecycle contract (`reconcile` + soft `reconcileAfter`).
 *
 * Augmented onto `PluginServiceSpec` in a dedicated server-only module so `@helmx/protocol/browser`
 * never pulls in backend service types and `plugin.ts` stays untouched by lifecycle extensions.
 */
import type { MaybePromise } from './plugin-dto.js'

declare module './plugin.js' {
  interface PluginServiceSpec {
    /**
     * Post-startup recovery/reconciliation phase: runs after the global `prepare -> start`
     * barrier and kernel scheduler resume (`harness.resume()`), executed strictly in
     * topological order across active plugins (hard `dependencies` + active soft `reconcileAfter`).
     * On hot-enable after host reconciliation has completed, runs immediately after `start()`.
     */
    reconcile?(): MaybePromise<void>
    /**
     * Optional plugin IDs whose `reconcile()` must finish before this service's `reconcile()`
     * whenever those plugins are active. Soft ordering edge only: unregistered or disabled
     * targets are ignored so optional peer ordering never creates hard enable/disable coupling.
     */
    reconcileAfter?: readonly string[]
  }
}
