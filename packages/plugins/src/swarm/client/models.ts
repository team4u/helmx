/**
 * Shared public-doc constants & types for builtin:swarm client components (Fast Refresh compliant).
 */
import type { ConversationSummary } from '@helmx/protocol/browser'
import type { CollabGroupSummary, SwarmWorkerPointer } from '../contracts-types.js'

export const SWARM_WORKBENCH_PANEL_ID = 'groups' as const

export type SwarmIndexWorkerItem = SwarmWorkerPointer

export interface SwarmIndexDoc {
  workers?: SwarmIndexWorkerItem[]
  groups?: CollabGroupSummary[]
}

export function buildConversationMap(conversations: ReadonlyArray<ConversationSummary>): Map<number, ConversationSummary> {
  return new Map(conversations.map((c) => [c.id, c]))
}
