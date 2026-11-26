/**
 * Unified pure execution model barrel for builtin:workflow UI surfaces
 * (zero React/DOM dependencies; single source of truth for status, titles,
 * timing, execution tree, phase sections, resumability, and active tray).
 */
export {
  STATUS_PRIORITY,
  aggregateStatuses,
  effectiveRunStatus,
  executionLightStatus,
  resolveNodeTitle,
  resolveRunDisplayName,
  resolveWorkflowToolFallbackLabel,
  statusFromConversation,
  statusFromRun,
  statusFromRunNode,
  type ExecutionAggregate,
  type ExecutionNode,
  type ExecutionNodeKind,
  type ExecutionStatus,
  type ResolvedTitle,
} from './status-model.js'
export {
  resolveNodeElapsedMs,
  resolveRunElapsedMs,
  resolveSubagentElapsedMs,
  summarizeWorkflowTiming,
  type WorkflowTimingSummary,
} from './timing-model.js'
export {
  buildSubagentLatestCallIndex,
  extractToolMetaLabel,
  isBackgroundWorkflowResultHandle,
  isLatestSubagentCallForTarget,
  resolveSubagentConversationId,
  resolveSubagentExecutionMeta,
  resolveWorkflowRunForTool,
  type SubagentExecutionMeta,
  type SubagentLatestCallIndex,
  type SubagentTimelineCallLike,
} from './tool-association.js'
export {
  aggregateExecutionNodes,
  buildExecutionTree,
  buildLeafNodesForRun,
  type BuildExecutionTreeInput,
} from './execution-tree.js'
export {
  buildWorkflowPhaseSections,
  canReplayWorkflowRun,
  canResumeSubagentRun,
  canResumeWorkflowRun,
  extractWorkflowLogs,
  formatNodeStats,
  listResumableFailedRuns,
  type WorkflowLogLine,
  type WorkflowPhaseSection,
} from './phase-model.js'
export { resolveLiveSnippet, type LiveSnippet } from './live-snippet.js'
export {
  buildActiveTraySummary,
  isManagedSpawnBranch,
  isManagedWorktree,
  type ActiveTrayItem,
  type ActiveTraySummary,
} from './tray-model.js'
