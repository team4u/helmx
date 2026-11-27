/**
 * RouteRegistry: dynamic HTTP routes contributed by plugins, mounted under the plugin namespace
 * (`/api/plugins/<id>/routes<path>`). Registration validates the spec and rejects same-plugin
 * routes whose method + path signature collide.
 */
import {
  HelmxError,
  type MaybePromise,
  type PluginRouteContext,
  type PluginRouteMethod,
  type PluginRouteSpec,
} from '@helmx/protocol';
import { decodeSegmentStrict } from '../shared.js';
import { PluginEntryRegistry } from './plugin-entry-registry.js';

export interface PluginRouteEntry extends Omit<PluginRouteSpec, 'handler'> {
  pluginId: string;
  handler(req: Request, ctx?: PluginRouteContext): MaybePromise<Response>;
}

interface StoredPluginRoute {
  entry: PluginRouteEntry;
  relativePath: string;
}

const VALID_ROUTE_METHODS: ReadonlySet<PluginRouteMethod> = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
]);
const ROUTE_PARAM_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const UNSAFE_PARAM_NAMES: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const EMPTY_ROUTE_CONTEXT: PluginRouteContext = Object.freeze({ params: Object.freeze({}) });

function pluginRoutePrefix(pluginId: string): string {
  return `/api/plugins/${encodeURIComponent(pluginId)}/routes`;
}

/** Conflict identity of a route inside a plugin: `method` comes from a fixed `\0`-free set, so the key is injective. */
function routeKey(method: PluginRouteMethod, signature: string): string {
  return `${method}\0${signature}`;
}

/**
 * Validates the path segments and returns the route signature (literal segments verbatim,
 * parameters normalized to `:`): two routes with the same signature are the same endpoint.
 */
function parseRouteSignature(pluginId: string, spec: PluginRouteSpec): string {
  const seenParams = new Set<string>();
  const signatureParts: string[] = [];
  for (const seg of spec.path.slice(1).split('/')) {
    if (seg.length === 0) {
      throw new HelmxError(
        'invalid_route_path',
        `Plugin ${pluginId} route ${spec.method} ${spec.path} cannot contain empty path segments ('//' or trailing slash)`,
        400,
      );
    }
    const decoded = decodeSegmentStrict(seg);
    if (decoded === '.' || decoded === '..' || decoded.includes('/')) {
      throw new HelmxError(
        'invalid_route_path',
        `Plugin ${pluginId} route ${spec.method} ${spec.path} cannot contain dot segments ('.' / '..') or encoded slashes`,
        400,
      );
    }
    if (decoded.startsWith(':')) {
      const paramName = decoded.slice(1);
      if (!ROUTE_PARAM_NAME_PATTERN.test(paramName) || UNSAFE_PARAM_NAMES.has(paramName)) {
        throw new HelmxError(
          'validation_error',
          `Plugin ${pluginId} route ${spec.method} ${spec.path} contains invalid path parameter segment '${decoded}'`,
          400,
          { pluginId, method: spec.method, path: spec.path, segment: decoded },
        );
      }
      if (seenParams.has(paramName)) {
        throw new HelmxError(
          'validation_error',
          `Plugin ${pluginId} route ${spec.method} ${spec.path} declares duplicate path parameter ':${paramName}'`,
          400,
          { pluginId, method: spec.method, path: spec.path, param: paramName },
        );
      }
      seenParams.add(paramName);
      signatureParts.push(':');
    } else {
      signatureParts.push(decoded);
    }
  }
  return signatureParts.join('\0');
}

/** Validates method, path shape, segments, and handler; returns the route signature. */
function validateRouteSpec(pluginId: string, spec: PluginRouteSpec): string {
  if (typeof spec.method !== 'string' || !VALID_ROUTE_METHODS.has(spec.method)) {
    throw new HelmxError(
      'validation_error',
      `Plugin ${pluginId} route method ${String(spec.method)} is unsupported (allowed: ${[...VALID_ROUTE_METHODS].join(', ')})`,
      400,
      { pluginId, method: String(spec.method) },
    );
  }
  if (typeof spec.path !== 'string' || !spec.path.startsWith('/')) {
    throw new HelmxError(
      'invalid_route_path',
      `Plugin ${pluginId} route path must be a relative path starting with '/' (mounted under the plugin namespace): ${String(spec.path)}`,
      400,
    );
  }
  if (spec.path === '/api' || spec.path.startsWith('/api/')) {
    throw new HelmxError(
      'invalid_route_path',
      `Plugin ${pluginId} route ${spec.method} ${spec.path} cannot include the '/api' prefix (declare a relative path; the host handles namespacing)`,
      400,
    );
  }
  if (spec.path === '/') {
    throw new HelmxError('invalid_route_path', `Plugin ${pluginId} route relative path must have at least one segment ('/' alone is disallowed)`, 400);
  }
  if (spec.path.includes('?') || spec.path.includes('#')) {
    throw new HelmxError(
      'invalid_route_path',
      `Plugin ${pluginId} route ${spec.method} ${spec.path} cannot contain a query string or fragment`,
      400,
    );
  }
  const signature = parseRouteSignature(pluginId, spec);
  if (typeof spec.handler !== 'function') {
    throw new HelmxError('invalid_route_handler', `Plugin ${pluginId} route ${spec.path} is missing handler`, 400);
  }
  return signature;
}

export class RouteRegistry extends PluginEntryRegistry<StoredPluginRoute> {
  register(pluginId: string, spec: PluginRouteSpec): void {
    const signature = validateRouteSpec(pluginId, spec);
    const key = routeKey(spec.method, signature);
    const conflicting = this.entry(pluginId, key);
    if (conflicting !== undefined) {
      throw new HelmxError(
        'validation_error',
        `Plugin ${pluginId} route ${spec.method} ${spec.path} conflicts with existing route ${conflicting.entry.method} ${conflicting.relativePath}`,
        400,
        {
          pluginId,
          method: spec.method,
          path: spec.path,
          conflictingPath: conflicting.relativePath,
        },
      );
    }
    const rawHandler = spec.handler;
    const wrappedHandler: PluginRouteEntry['handler'] = (req, ctx = EMPTY_ROUTE_CONTEXT) =>
      rawHandler(req, ctx);
    this.setEntry(pluginId, key, {
      relativePath: spec.path,
      entry: {
        ...spec,
        handler: wrappedHandler,
        path: `${pluginRoutePrefix(pluginId)}${spec.path}`,
        pluginId,
      },
    });
  }

  /** Mounted entries of the active plugins (registration order), as fresh copies. */
  list(activePluginIds: Iterable<string>): PluginRouteEntry[] {
    const out: PluginRouteEntry[] = [];
    for (const pluginId of activePluginIds) {
      for (const route of this.entriesOf(pluginId).values()) out.push({ ...route.entry });
    }
    return out;
  }
}
