/**
 * Test-only internal kernel exports (`@helmx/kernel/testing`).
 *
 * Exposes internal kernel primitives required by sibling package test suites (`hub`, `plugins`,
 * `cli`, `web`) so tests never reach across package boundaries into `../../kernel/src/`.
 * Production sources (`packages/<pkg>/src/**`) must never import `@helmx/kernel/testing`.
 */
export { composeExecutionEnv } from './env/scoped-env.js';
export { parseProfileBody } from './http/validate.js';
export { debugBackendTsLoaderState } from './plugins/backend-ts-loader.js';
export { EventHub } from './runtime/events.js';
export { wrapModelsForCompaction } from './runtime/models.js';
export { HelmxPluginConfigStore } from './runtime/plugin-config-store.js';
export { runNativeSpawn, type NativeSpawnDeps } from './runtime/spawn.js';
export { openHelmxDatabase, type HelmxDatabase } from './runtime/sqlite.js';
export { HelmxStore } from './runtime/store.js';
export type { HelmxToolDeps } from './runtime/tool-deps.js';
export { actionToolResult, pluginToolResult } from './runtime/tools/tool-result-contract.js';
export {
  buildManagedEnv,
  createBashTool,
  createEditTool,
  createReadTool,
  createRegisterArtifactTool,
  createWriteTool,
  executionScopeHash,
  readArtifactBytesFromHandle,
  runShell,
  type ArtifactReadHandle,
} from './runtime/tools.js';
