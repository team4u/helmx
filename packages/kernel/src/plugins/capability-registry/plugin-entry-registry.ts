/**
 * Mechanism shared by the action / tool / route sub-registries: a per-plugin `key -> entry` store
 * with per-plugin lifecycle (`clear` / `removePlugin`). It carries no validation or projection
 * policy; each subclass owns its entry shape, key derivation, and registration rules.
 */
export class PluginEntryRegistry<E> {
  private readonly byPlugin = new Map<string, Map<string, E>>();

  /** Entry of `pluginId` stored under `key`, or `undefined` when absent. */
  entry(pluginId: string, key: string): E | undefined {
    return this.byPlugin.get(pluginId)?.get(key);
  }

  /** Entries of one plugin keyed by their registry key (insertion order); empty when it registered nothing. */
  entriesOf(pluginId: string): ReadonlyMap<string, E> {
    return this.byPlugin.get(pluginId) ?? EMPTY_ENTRIES;
  }

  /** Plugins that currently own at least one map slot (insertion order of first registration). */
  pluginIds(): Iterable<string> {
    return this.byPlugin.keys();
  }

  protected setEntry(pluginId: string, key: string, value: E): void {
    let pluginEntries = this.byPlugin.get(pluginId);
    if (pluginEntries === undefined) {
      pluginEntries = new Map();
      this.byPlugin.set(pluginId, pluginEntries);
    }
    pluginEntries.set(key, value);
  }

  /** Drop every entry of one plugin (disable / re-registration); other plugins are untouched. */
  clear(pluginId: string): void {
    this.byPlugin.get(pluginId)?.clear();
  }

  /** Forget one plugin entirely (unregister). */
  removePlugin(pluginId: string): void {
    this.byPlugin.delete(pluginId);
  }
}

const EMPTY_ENTRIES: ReadonlyMap<never, never> = new Map<never, never>();
