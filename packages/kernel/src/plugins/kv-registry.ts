/**
 * kv-registry.ts: lightweight per-plugin keyed KV storage backing `ctx.kv<T>(namespace)`.
 *
 * Responsibilities:
 * - Enforce namespace, key, and list-option validation at the boundary;
 * - Auto-redact every stored value through SecretStash before JSON serialization;
 * - Enforce per-entry serialized UTF-8 byte limit (256 KiB -> explicit `413 plugin_kv_too_large`);
 * - Delegate durable reads/writes/prefix-listing/purge to `PluginKvStore` (`helmx_plugin_kv` on `state.sqlite`)
 *   without whole-namespace serialization.
 */
import {
  HelmxError,
  isPlainObject,
  type PluginKvHandle,
  type PluginKvListOptions,
  type PluginKvListResult,
} from '@helmx/protocol';
import { redactJsonValue } from '../redact.js';

/** Maximum serialized UTF-8 JSON size per KV entry: 256 KiB. */
export const PLUGIN_KV_MAX_VALUE_BYTES = 256 * 1024;
/** Default page size when `list()` omits `limit`. */
export const PLUGIN_KV_DEFAULT_LIST_LIMIT = 1000;
/** Hard upper bound on `list({ limit })`. */
export const PLUGIN_KV_MAX_LIST_LIMIT = 1000;

const KV_NAMESPACE_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const KV_MAX_KEY_LENGTH = 256;
// eslint-disable-next-line no-control-regex
const KV_CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;
const ALLOWED_LIST_OPTION_KEYS: ReadonlySet<string> = new Set(['prefix', 'limit', 'cursor']);

export interface PluginKvRawEntry {
  key: string;
  valueJson: string;
  updatedAt: number;
}

export interface PluginKvStore {
  get(pluginId: string, namespace: string, key: string): { valueJson: string; updatedAt: number } | undefined;
  put(pluginId: string, namespace: string, key: string, valueJson: string): number;
  delete(pluginId: string, namespace: string, key: string): boolean;
  list(
    pluginId: string,
    namespace: string,
    opts?: { prefix?: string; limit?: number; cursor?: string },
  ): { items: PluginKvRawEntry[]; nextCursor?: string };
  clearNamespace(pluginId: string, namespace: string): void;
  deletePlugin(pluginId: string): void;
  flush(): Promise<void>;
}

export interface PluginKvRegistryOptions {
  /** Maximum UTF-8 JSON bytes per entry (defaults to `PLUGIN_KV_MAX_VALUE_BYTES`, 256 KiB). */
  maxValueBytes?: number;
}

function assertValidKvNamespace(pluginId: string, namespace: string): void {
  if (typeof namespace !== 'string' || !KV_NAMESPACE_PATTERN.test(namespace)) {
    throw new HelmxError(
      'invalid_kv_namespace',
      `Plugin ${pluginId} KV namespace ${JSON.stringify(namespace)} must match ${KV_NAMESPACE_PATTERN.source}`,
      400,
      { pluginId, namespace: String(namespace) },
    );
  }
}

function assertValidKvKey(pluginId: string, namespace: string, key: string): void {
  if (
    typeof key !== 'string' ||
    key.length === 0 ||
    key.length > KV_MAX_KEY_LENGTH ||
    KV_CONTROL_CHAR_PATTERN.test(key)
  ) {
    throw new HelmxError(
      'invalid_kv_key',
      `Plugin ${pluginId} KV key in namespace '${namespace}' must be a non-empty printable string (1..${KV_MAX_KEY_LENGTH} chars, no control characters)`,
      400,
      { pluginId, namespace },
    );
  }
}

function normalizeListOptions(
  pluginId: string,
  namespace: string,
  opts: PluginKvListOptions | undefined,
): { prefix?: string; limit: number; cursor?: string } {
  if (opts === undefined) {
    return { limit: PLUGIN_KV_DEFAULT_LIST_LIMIT };
  }
  if (!isPlainObject(opts)) {
    throw new HelmxError(
      'validation_error',
      `Plugin ${pluginId} KV list options for '${namespace}' must be a plain object`,
      400,
      { pluginId, namespace },
    );
  }
  for (const key of Object.keys(opts)) {
    if (!ALLOWED_LIST_OPTION_KEYS.has(key)) {
      throw new HelmxError(
        'validation_error',
        `Plugin ${pluginId} KV list options for '${namespace}' contains unknown field '${key}'`,
        400,
        { pluginId, namespace, field: key },
      );
    }
  }
  let prefix: string | undefined;
  if (opts.prefix !== undefined) {
    if (
      typeof opts.prefix !== 'string' ||
      opts.prefix.length > KV_MAX_KEY_LENGTH ||
      KV_CONTROL_CHAR_PATTERN.test(opts.prefix)
    ) {
      throw new HelmxError(
        'validation_error',
        `Plugin ${pluginId} KV list prefix for '${namespace}' must be a printable string (<= ${KV_MAX_KEY_LENGTH} chars)`,
        400,
        { pluginId, namespace },
      );
    }
    if (opts.prefix.length > 0) prefix = opts.prefix;
  }
  let limit = PLUGIN_KV_DEFAULT_LIST_LIMIT;
  if (opts.limit !== undefined) {
    if (
      typeof opts.limit !== 'number' ||
      !Number.isInteger(opts.limit) ||
      opts.limit < 1 ||
      opts.limit > PLUGIN_KV_MAX_LIST_LIMIT
    ) {
      throw new HelmxError(
        'validation_error',
        `Plugin ${pluginId} KV list limit for '${namespace}' must be an integer between 1 and ${PLUGIN_KV_MAX_LIST_LIMIT}`,
        400,
        { pluginId, namespace, limit: opts.limit },
      );
    }
    limit = opts.limit;
  }
  let cursor: string | undefined;
  if (opts.cursor !== undefined) {
    if (
      typeof opts.cursor !== 'string' ||
      opts.cursor.length === 0 ||
      opts.cursor.length > KV_MAX_KEY_LENGTH ||
      KV_CONTROL_CHAR_PATTERN.test(opts.cursor)
    ) {
      throw new HelmxError(
        'validation_error',
        `Plugin ${pluginId} KV list cursor for '${namespace}' must be a non-empty printable string`,
        400,
        { pluginId, namespace },
      );
    }
    cursor = opts.cursor;
  }
  return {
    ...(prefix !== undefined ? { prefix } : {}),
    limit,
    ...(cursor !== undefined ? { cursor } : {}),
  };
}

export class PluginKvRegistry {
  private readonly maxValueBytes: number;

  constructor(
    private readonly store: PluginKvStore | undefined,
    private readonly redactText: (text: string) => string,
    options: PluginKvRegistryOptions = {},
  ) {
    this.maxValueBytes = options.maxValueBytes ?? PLUGIN_KV_MAX_VALUE_BYTES;
  }

  createHandle<T>(
    pluginId: string,
    namespace: string,
    assertUsable: () => void,
  ): PluginKvHandle<T> {
    assertValidKvNamespace(pluginId, namespace);
    const store = this.store;
    if (!store) {
      throw new HelmxError(
        'kv_store_unavailable',
        `Plugin ${pluginId} requested KV namespace '${namespace}', but no durable KV store is configured`,
        501,
        { pluginId, namespace },
      );
    }

    const serializeValue = (key: string, value: T): string => {
      const redacted = redactJsonValue(value, this.redactText);
      const json = JSON.stringify(redacted);
      if (json === undefined) {
        throw new HelmxError(
          'invalid_json_value',
          `Plugin ${pluginId} KV value for '${namespace}/${key}' cannot be serialized to JSON`,
          400,
          { pluginId, namespace, key },
        );
      }
      const bytes = Buffer.byteLength(json, 'utf8');
      if (bytes > this.maxValueBytes) {
        throw new HelmxError(
          'plugin_kv_too_large',
          `Plugin ${pluginId} KV entry '${namespace}/${key}' JSON payload is ${bytes} bytes, exceeding limit of ${this.maxValueBytes} bytes (write rejected; previous value unchanged)`,
          413,
          { pluginId, namespace, key, bytes, maxBytes: this.maxValueBytes },
        );
      }
      return json;
    };

    return {
      get: (key: string): T | undefined => {
        assertUsable();
        assertValidKvKey(pluginId, namespace, key);
        const entry = store.get(pluginId, namespace, key);
        return entry === undefined ? undefined : (JSON.parse(entry.valueJson) as T);
      },
      set: (key: string, value: T): void => {
        assertUsable();
        assertValidKvKey(pluginId, namespace, key);
        const json = serializeValue(key, value);
        store.put(pluginId, namespace, key, json);
      },
      delete: (key: string): boolean => {
        assertUsable();
        assertValidKvKey(pluginId, namespace, key);
        return store.delete(pluginId, namespace, key);
      },
      list: (opts?: PluginKvListOptions): PluginKvListResult<T> => {
        assertUsable();
        const normalized = normalizeListOptions(pluginId, namespace, opts);
        const page = store.list(pluginId, namespace, normalized);
        return {
          items: page.items.map((row) => ({
            key: row.key,
            value: JSON.parse(row.valueJson) as T,
            updatedAt: row.updatedAt,
          })),
          ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
        };
      },
      clear: (): void => {
        assertUsable();
        store.clearNamespace(pluginId, namespace);
      },
      flush: async (): Promise<void> => {
        assertUsable();
        await store.flush();
      },
    };
  }

  /** Permanently deletes all persisted KV entries owned by an uninstalled plugin and awaits flush. */
  async purgePlugin(pluginId: string): Promise<void> {
    if (!this.store) return;
    this.store.deletePlugin(pluginId);
    await this.store.flush();
  }
}
