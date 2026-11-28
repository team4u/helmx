/**
 * `@helmx/kernel` runtime entry point: `KernelRuntime` and internal mechanism modules.
 */

export { KernelRuntime, type KernelRuntimeOptions } from './runtime.js'
export {
  startActivityHeartbeat,
  hubActivityFilePath,
  type ActivityHeartbeat,
  type ActivityHeartbeatOptions,
} from './activity-heartbeat.js'
export { readWorkspaceFile, type ConversationFileContent } from './workspace-files.js'
export {
  isStrictSemVer,
  normalizeExplicitVersion,
  compareStrictSemVer,
  hubVersion,
} from './semver.js'
export { EventHub, SessionDocEventHub, type SnapshotProvider } from './events.js'
export { AskService } from './asks.js'
export { RuntimeAgentSpawn } from './runtime-agent-spawn.js'
export { RuntimeOwnershipManager } from './runtime-ownership.js'
export { RuntimeTriggerDispatcher } from './runtime-triggers.js'
export { NodeForwardService, type NodeForwardEvent, type NodeForwardInput, type NodeForwardSession } from '../env/forward.js'
export { ConversationTracker, deriveTitle, type TrackerEvents } from './conversations.js'
export { toConversationEntry, deriveConversationLive, type EntryRecordLike } from './entries.js'
export { openHelmxDatabase, type HelmxDatabase } from './sqlite.js'
export {
  createDiagnosticEmitter,
  defaultDiagnosticSink,
  emitDiagnostic,
  formatDiagnosticError,
  type KernelDiagnosticEmitter,
  type KernelDiagnosticEvent,
  type KernelDiagnosticInput,
  type KernelDiagnosticSink,
} from './diagnostics.js'
export { HelmxStore, convStatusOf, summaryOf, type ConvMeta, type ConversationSummaryInput } from './store.js'
export { runShell, runGate, createBashTool, createReadTool, createWriteTool, createEditTool, createReadArtifactTool, createRegisterArtifactTool, type ShellRunResult } from './tools.js'
export { runNativeSpawn, type NativeSpawnDeps } from './spawn.js'
export { validateJsonSchema } from './structured-output.js'
export { buildModels, parseModelRef, requireModelRef, listModelCatalog, listModelProviders, type ModelCatalogEntry } from './models.js'
export { createFileModelsStore } from './models-store.js'
export type { HelmxToolDeps } from './tool-deps.js'
export { NodeManager } from './node-manager.js'
export {
  shQuote,
  buildPosixHostShim,
  buildWindowsPosixShim,
  buildWindowsCmdWrapper,
  type CliShimPlan,
} from './cli-shim.js'
export { ModelRegistry } from './model-registry.js'
export { HookBridge, prepareToolResultWith } from './hook-bridge.js'
export { ConversationService, type SubmitInputOptions } from './conversation-service.js'
export { ConversationRewind } from './conversation-rewind.js'
export { ConversationAttachments } from './conversation-attachments.js'
export { ConversationContextOps } from './conversation-context-ops.js'
export { ConversationDetailService } from './conversation-detail.js'
export { ConversationProfileService } from './conversation-profile.js'
export { ConversationInputPipeline, submitDurableInput, type DurableInputTracker } from './conversation-input.js'
export { createRunActionTool, type KernelToolHost } from './kernel-tools.js'
export {
  runOmniboxSearch,
  OMNIBOX_DEFAULT_LIMIT,
  OMNIBOX_MAX_ITEMS_PER_PLUGIN,
  OMNIBOX_DEFAULT_PROVIDER_TIMEOUT_MS,
  type OmniboxSearchDeps,
  type OmniboxSearchOptions,
} from './omnibox-search.js'
