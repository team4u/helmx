/**
 * Shared public-doc constants & types for builtin:swarm client components (Fast Refresh compliant).
 */
import type { ConversationSummary } from '@helmx/protocol'
import type { CollabGroupSummary, SwarmWorkerPointer } from '../contracts.js'

export const SWARM_WORKBENCH_PANEL_TARGET = 'plugin:builtin:swarm/groups' as const

export type SwarmIndexWorkerItem = SwarmWorkerPointer

export interface SwarmIndexDoc {
  workers?: SwarmIndexWorkerItem[]
  groups?: CollabGroupSummary[]
}

export function buildConversationMap(conversations: ReadonlyArray<ConversationSummary>): Map<number, ConversationSummary> {
  return new Map(conversations.map((c) => [c.id, c]))
}
