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
  AGENTS_MD_FILENAME,
  MAX_AGENTS_MD_BYTES,
  MAX_AGENTS_MD_CHARS,
  computeAgentsMdSection,
  type AgentsMdHostPort,
  type AgentsMdInjection,
} from './runtime/agents-md.js';
export {
  DEFAULT_NODE_MACHINE_SKILL_ROOTS,
  MAX_NODE_SKILLS,
  MAX_NODE_SKILL_FILE_BYTES,
  MAX_NODE_SKILL_REFERENCES,
  MAX_NODE_SKILL_REFERENCE_DEPTH,
  NODE_SKILLS_CACHE_TTL_MS,
  NODE_SKILLS_RELATIVE_DIR,
  NODE_SKILL_SCAN_CONCURRENCY,
  invalidateNodeSkillsCache,
  nodeSkillsUnavailableSection,
  readNodeSkillFile,
  scanNodeSkills,
  type NodeSkillScan,
  type NodeSkillScanOptions,
  type NodeSkillsHostPort,
} from './runtime/node-skills.js';
export {
  ScopedSkillService,
  listScopedSkills,
  type HubSkillsPort,
  type ScopedSkillServiceDeps,
} from './runtime/scoped-skills.js';
export {
  POST_HOOK_SKILL_SECTION_IDS,
  PRE_HOOK_PROFILE_SECTION_IDS,
  TurnContextAssembler,
  projectManagedSections,
  type PreparedTurnContext,
  type PromptSection,
  type TurnContextAssemblerDeps,
} from './runtime/turn-context.js';
export { LOAD_SKILL_TOOL_NAME, createLoadSkillTool } from './runtime/tools/skill-tools.js';
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
