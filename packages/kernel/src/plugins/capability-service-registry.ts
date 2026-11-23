/**
 * capability-service-registry.ts: typed plugin-to-plugin (and plugin-to-kernel) capability registry
 * backing `ctx.provide(capabilityId, impl)` and `ctx.consume(capabilityId)`.
 *
 * Responsibilities:
 * - Validate `capabilityId` format at registration and consumption boundaries;
 * - Track capability implementations by unique registration token so manual release is idempotent
 *   and disable/stop/rollback automatically releases all capabilities owned by a plugin;
 * - Filter consumed views strictly to active (enabled, idle, error-free) plugins;
 * - Provide read-only change subscription (`onCapabilityChanged`) so kernel subsystems (e.g.
 *   `ModelRegistry` consuming `'helmx.model-tiers'`) react without bespoke per-plugin host ports.
 */
import { HelmxError, type ProvidedCapability } from '@helmx/protocol';

/** Valid capability identifier format: lowercase alphanumeric start, up to 64 chars (`a-z`, `0-9`, `.`, `_`, `-`). */
export const CAPABILITY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

interface CapabilityEntry {
  readonly token: symbol;
  readonly pluginId: string;
  readonly impl: unknown;
}

export function assertValidCapabilityId(capabilityId: string, pluginId?: string): void {
  if (typeof capabilityId !== 'string' || !CAPABILITY_ID_PATTERN.test(capabilityId)) {
    throw new HelmxError(
      'invalid_capability_id',
      `Invalid capability ID ${JSON.stringify(capabilityId)} (must match ${CAPABILITY_ID_PATTERN.source})`,
      400,
      { capabilityId: String(capabilityId), ...(pluginId !== undefined ? { pluginId } : {}) },
    );
  }
}

export class CapabilityServiceRegistry {
  private readonly entriesByCapability = new Map<string, CapabilityEntry[]>();
  private readonly listenersByCapability = new Map<string, Set<() => void>>();

  /**
   * Registers a capability implementation owned by `pluginId`.
   * Returns an idempotent remover that returns `true` iff this entry was actually removed.
   */
  provide<T>(pluginId: string, capabilityId: string, impl: T): () => boolean {
    assertValidCapabilityId(capabilityId, pluginId);
    if (impl === undefined || impl === null) {
      throw new HelmxError(
        'invalid_capability_impl',
        `Plugin ${pluginId} capability '${capabilityId}' implementation must be a non-null value`,
        400,
        { pluginId, capabilityId },
      );
    }
    const token = Symbol(`cap:${pluginId}:${capabilityId}`);
    let list = this.entriesByCapability.get(capabilityId);
    if (!list) {
      list = [];
      this.entriesByCapability.set(capabilityId, list);
    }
    list.push({ token, pluginId, impl });

    let released = false;
    return () => {
      if (released) return false;
      released = true;
      const bucket = this.entriesByCapability.get(capabilityId);
      if (!bucket) return false;
      const idx = bucket.findIndex((entry) => entry.token === token);
      if (idx === -1) return false;
      bucket.splice(idx, 1);
      if (bucket.length === 0) {
        this.entriesByCapability.delete(capabilityId);
      }
      return true;
    };
  }

  /**
   * Returns a read-only snapshot of active implementations registered under `capabilityId`.
   */
  consume<T>(capabilityId: string, activePluginIds: ReadonlySet<string>): ReadonlyArray<ProvidedCapability<T>> {
    assertValidCapabilityId(capabilityId);
    const bucket = this.entriesByCapability.get(capabilityId);
    if (!bucket || bucket.length === 0) return Object.freeze([]);
    const out: ProvidedCapability<T>[] = [];
    for (const entry of bucket) {
      if (!activePluginIds.has(entry.pluginId)) continue;
      out.push(Object.freeze({ pluginId: entry.pluginId, impl: entry.impl as T }));
    }
    return Object.freeze(out);
  }

  /** Lists distinct capability IDs currently registered by `pluginId`. */
  getProvidedCapabilityIds(pluginId: string): string[] {
    const out: string[] = [];
    for (const [capabilityId, bucket] of this.entriesByCapability) {
      if (bucket.some((entry) => entry.pluginId === pluginId)) {
        out.push(capabilityId);
      }
    }
    return out;
  }

  /** Removes all capability registrations owned by `pluginId`; returns affected capability IDs. */
  removePlugin(pluginId: string): string[] {
    const affected: string[] = [];
    for (const [capabilityId, bucket] of [...this.entriesByCapability.entries()]) {
      const remaining = bucket.filter((entry) => entry.pluginId !== pluginId);
      if (remaining.length === bucket.length) continue;
      affected.push(capabilityId);
      if (remaining.length === 0) {
        this.entriesByCapability.delete(capabilityId);
      } else {
        this.entriesByCapability.set(capabilityId, remaining);
      }
    }
    return affected;
  }

  /** Subscribes to active-provider changes for `capabilityId`; returns an idempotent unsubscribe handle. */
  onCapabilityChanged(capabilityId: string, listener: () => void): () => void {
    assertValidCapabilityId(capabilityId);
    if (typeof listener !== 'function') {
      throw new HelmxError(
        'invalid_capability_listener',
        `Capability '${capabilityId}' change listener must be a function`,
        400,
        { capabilityId },
      );
    }
    let set = this.listenersByCapability.get(capabilityId);
    if (!set) {
      set = new Set();
      this.listenersByCapability.set(capabilityId, set);
    }
    set.add(listener);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      set?.delete(listener);
      if (set && set.size === 0) {
        this.listenersByCapability.delete(capabilityId);
      }
    };
  }

  /** Notifies registered listeners for each affected capability ID (isolates listener exceptions). */
  notifyChanged(capabilityIds: Iterable<string>): void {
    const seen = new Set<string>();
    for (const capabilityId of capabilityIds) {
      if (seen.has(capabilityId)) continue;
      seen.add(capabilityId);
      const listeners = this.listenersByCapability.get(capabilityId);
      if (!listeners || listeners.size === 0) continue;
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch {
          // Never allow one observer failure to break plugin lifecycle transitions.
        }
      }
    }
  }
}
