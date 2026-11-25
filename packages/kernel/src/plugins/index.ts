/**
 * Public exports for the plugin host module: PluginHost, hook pipeline, schema validation, and task tracking.
 * Protocol contract types are re-exported from `@helmx/protocol` as the single source of truth.
 */
export * from './plugin-host.js';
export { reloadExternalPlugin, type ExternalPluginHost, type ReloadablePluginHost } from './external-loader.js';
export { loadExternalPlugins, rescanExternalPlugins } from './scan-visitor.js';
export { EXTERNAL_PLUGINS_DIR_NAME, PLUGIN_DATA_DIR_NAME, externalPluginsDir, pluginDataDirName } from './plugin-dir-name.js';
export { readHelmxClientDependencies, readHelmxClientDist } from './plugin-manifest.js';
export { readPrebuiltClientManifest, readPrebuiltClientBundle } from './ui-registry.js'
export { registerPluginTsRoot, nextPluginGeneration, type BackendTsTransformFn } from './backend-ts-loader.js';
export { doctorPluginDir } from './plugin-doctor.js';
export { HookPipeline, HOOK_ALLOWED_ACTIONS, assertHookPayload } from './hooks.js'
export { PluginTaskTracker } from './tracking.js';
export { validatePluginInput, validatePluginOutput, validateOrThrow, assertSchemaCompilable } from './schema.js';
