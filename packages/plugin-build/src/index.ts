/**
 * @helmx/plugin-build — default implementation of the plugin build port (`PluginBuildProvider`).
 *
 * Injected explicitly into the kernel `PluginHost` (`PluginHostOptions.buildProvider`) by the product
 * composition root (`@helmx/hub`). Depends only on `@helmx/protocol`, `@helmx/env-io` (shared atomic
 * writes), and `esbuild`, with zero reverse dependency on `kernel`, `hub`, or `web`.
 *
 * Capabilities:
 * - `compileClientModule`: compiles `client.tsx` into browser ESM (shared dependency shims, CSS
 *   bundling, controlled npm dependencies, code splitting, content-hash disk/memory cache, pre-gzip);
 * - `buildPluginClientBundleDir`: compiles client entry modules into a static `dist-client/` directory
 *   with `manifest.json`, `.mjs`/`.js` bundles, and `.gz` artifacts;
 * - `transformBackendTs`: synchronously transpiles external plugin backend TypeScript to ESM.
 */
import { HelmxError, type PluginBuildProvider } from '@helmx/protocol';
import { transformBackendTs } from './backend-ts-transform.js';
import {
  compilePluginClientModule,
  resolveProviderCacheDir,
} from './client-compiler.js';

export { transformBackendTs } from './backend-ts-transform.js';
export {
  compilePluginClientModule,
  clearClientCompilerMemoryCache,
  readCachedChunk,
  resolveDefaultBuiltinClientCacheDir,
  safeDirName,
  safeFileName,
  CLIENT_SHARED_EXTERNALS,
  CLIENT_SHARED_GLOBALS,
  type ClientCompileResult,
  type ClientNpmRoot,
} from './client-compiler.js';
export { buildPluginClientBundleDir } from './prebuilt-client.js';
// Test-only utility: installs the Node chunk bridge on `globalThis` when executing split bundles in Node.
export { installNodeChunkBridge } from './node-chunk-bridge.js';

export interface CreatePluginBuildProviderOptions {
  /**
   * Shared disk cache root for built-in plugins (`builtin:*`) in source-compile mode:
   * - `undefined` (default): automatically uses `<workspaceRoot>/node_modules/.cache/helmx-plugin-clients`
   *   when running inside a monorepo checkout and `clientRoot` resides under `packages/plugins/src`;
   * - `string`: explicitly routes `builtin:*` client compilation caches into this directory;
   * - `false`: disables shared built-in caching (always stores artifacts under `request.cacheDir`).
   */
  builtinCacheDir?: string | false;
}

/** Creates the default plugin build port (client compiler + backend TS transpiler). */
export function createPluginBuildProvider(options?: CreatePluginBuildProviderOptions): PluginBuildProvider {
  const builtinCacheDir = options?.builtinCacheDir;
  if (typeof builtinCacheDir === 'string' && builtinCacheDir.trim().length === 0) {
    throw new HelmxError(
      'invalid_plugin_definition',
      'createPluginBuildProvider builtinCacheDir must be a non-empty path or false',
      400,
    );
  }
  return {
    compileClientModule: (request) => {
      const effectiveCacheDir = resolveProviderCacheDir(
        request.pluginId,
        request.clientRoot,
        request.cacheDir,
        builtinCacheDir,
      );
      return compilePluginClientModule(request.pluginId, request.clientRoot, request.moduleRef, effectiveCacheDir, {
        ...(request.npmRoots.length > 0 ? { npmRoots: request.npmRoots } : {}),
      });
    },
    transformBackendTs,
  };
}
