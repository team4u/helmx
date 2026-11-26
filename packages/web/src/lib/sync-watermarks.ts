/**
 * Pure watermark and activity predicates for conversation artifact syncing.
 */
import type { ArtifactMetadata, ConversationSummary } from '@helmx/protocol/browser'

export interface ArtifactsSyncWatermark {
  stateChangeSeq: number
  lastEntryId: number | undefined
}

/** 是否处于执行中（working 或 blocked 审批阻塞）：活跃期不作为产物稳定水位，也不在事件流中反复全量拉取产物。 */
export function isConversationStatusActive(status: ConversationSummary['status']): boolean {
  return status === 'working' || status === 'blocked'
}

/** 判定当前缓存的产物列表是否已对齐会话最新非活跃水位（stateChangeSeq + lastEntryId）。 */
export function isArtifactsWatermarkCurrent(
  cachedArtifacts: ReadonlyArray<ArtifactMetadata> | undefined,
  summary: Pick<ConversationSummary, 'status' | 'stateChangeSeq' | 'lastEntryId'> | undefined,
  watermark: ArtifactsSyncWatermark | undefined,
): boolean {
  return (
    cachedArtifacts !== undefined &&
    summary !== undefined &&
    !isConversationStatusActive(summary.status) &&
    watermark !== undefined &&
    watermark.stateChangeSeq === summary.stateChangeSeq &&
    watermark.lastEntryId !== undefined &&
    summary.lastEntryId !== undefined &&
    watermark.lastEntryId === summary.lastEntryId
  )
}
