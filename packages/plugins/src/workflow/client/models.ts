/**
 * Pure logic layer facade for the builtin:workflow plugin client (zero
 * React/DOM dependencies).
 *
 * Split by domain into model-format / model-subagent-link /
 * model-subagent-stream / model-subagent-card / model-run / model-worktree /
 * model-library / model-execution-status / model-execution-view /
 * model-execution-tree; this facade explicitly re-exports the original
 * public API (internal exports such as inputString / inspectString are not
 * exposed here); components and hooks import the concrete model-*.ts files
 * directly — never import back from this facade (avoids cycles).
 */

// Shared formatting helpers (model-format.ts)
export {
  toolResultPreviewTruncated,
  isScrolledToBottom,
  firstLineOf,
  cleanInlineMarkdown,
  extractCleanPreviewLine,
  summarizeReadableJson,
  formatShortModelName,
  stringifyPretty,
} from './model-format.ts'

// Subagent runtime association (model-subagent-link.ts)
export {
  buildSubagentLatestCallIndex,
  readToolPresentationMeta,
  parseSubagentExecutionInfo,
  resolveSubagentConversationId,
  resolveSubagentExecutionMeta,
  isLatestSubagentCallForTarget,
  parentToolSummaryOf,
} from './model-subagent-link.ts'
export type {
  SubagentExecutionInfo,
  SubagentExecutionMeta,
  SubagentLatestCallIndex,
  SubagentParentToolSummary,
  SubagentTimelineCallLike,
} from './model-subagent-link.ts'

// Tool line semantic summaries and the subagent live stream (model-subagent-stream.ts)
export {
  toolSummaryText,
  formatSemanticToolAction,
  buildSubagentStreamLines,
  buildSubagentStatSegments,
} from './model-subagent-stream.ts'
export type { SubagentStreamLine } from './model-subagent-stream.ts'

// Card status badges and header summaries (model-subagent-card.ts)
export {
  subagentBadge,
  compactCardTitle,
  latestTurnStartedAt,
  resolveExternalSubagentTaskTitle,
  resolveSubagentTaskTitle,
  resolveSubagentElapsedMs,
  extractSubagentResultPreview,
  resolveSubagentHeaderSnippet,
  runFailureFallbackLabel,
} from './model-subagent-card.ts'
export type { SubagentCardStatus, SubagentBadge, SubagentHeaderSnippet, SubagentRunView } from './model-subagent-card.ts'

// Workflow run card pure logic (model-run.ts)
export {
  resolveWorkflowRunDisplayName,
  resolveWorkflowRunForTool,
  isBackgroundWorkflowResultHandle,
  resolveWorkflowToolFallbackLabel,
  hasNodeExtraDetail,
  formatNodeOutputPreview,
  resolveNodeSummaryText,
  buildWorkflowPhaseSections,
  extractWorkflowLogs,
  canResumeWorkflowRun,
  canResumeSubagentRun,
  listResumableFailedRuns,
  parseResumeFailedResult,
  canReplayWorkflowRun,
  formatWorkflowNodeStats,
  resolveRunElapsedMs,
  resolveNodeElapsedMs,
  resolvePhaseElapsedMs,
  summarizeWorkflowTiming,
} from './model-run.ts'
export type {
  NodeSummaryText,
  WorkflowPhaseSection,
  WorkflowLogLine,
  WorkflowTimingSummary,
  ResumeFailedSummaryView,
} from './model-run.ts'

// Workflow library strict parsing and args parsing (model-library.ts)
export {
  parseSavedWorkflowList,
  parseWorkflowDetail,
  buildWorkflowEditRequest,
  parseWorkflowArgsInput,
} from './model-library.ts'
export type { SavedWorkflowView, SavedWorkflowDetailView } from './model-library.ts'

// Unified execution tree (model-execution-status / model-execution-view / model-execution-tree.ts)
export {
  aggregateExecutionStatuses,
  executionConversationStatus,
  executionLightStatus,
  executionRunStatus,
  executionRunNodeStatus,
  effectiveRunNodeStatus,
  executionToolStatus,
} from './model-execution-status.ts'
export {
  executionNodeTitle,
  resolveExecutionNodeElapsedMs,
  collectExecutionFrontline,
  collectExecutionApprovals,
} from './model-execution-view.ts'
export { buildExecutionTree, aggregateExecutionNodes } from './model-execution-tree.ts'
export type { ExecutionAggregate, ExecutionNodeStatus } from './model-execution-status.ts'
export type { ExecutionFrontlineItem, ExecutionApprovalItem } from './model-execution-view.ts'
export type { ExecutionNodeKind, ExecutionNode, BuildExecutionTreeInput } from './model-execution-tree.ts'

// Background report parsing / bottom activity tray
export {
  parseBackgroundReportEntry,
  backgroundReportPreview,
  isBackgroundReportDefaultOpen,
} from './model-background-report.ts'
export type {
  BackgroundReportKind,
  BackgroundReportStatus,
  BackgroundReportOtherTask,
  BackgroundReportView,
  BackgroundReportInvalidView,
  BackgroundReportParse,
} from './model-background-report.ts'
export { buildActiveTraySummary } from './model-active-tray.ts'
export type { ActiveTrayItem, ActiveTraySummary } from './model-active-tray.ts'
