/**
 * builtin:swarm derived projections (single source of truth: groupsById):
 * - public doc `index` (active workers + bounded group summaries);
 * - session doc `board-view` (keyed by coordinatorConversationId, digest-deduped);
 * - public doc `board-badges` (per-conversation badge lookup).
 */
import {
  MAX_INDEX_CLOSED_GROUPS,
  toGroupSummary,
  type BoardBadgeEntry,
  type BoardBadgesDoc,
  type BoardPost,
  type CollabGroupRecord,
  type MemberLiveSnapshot,
  type SwarmCoordinator,
  type SwarmWorkerPointer,
} from './contracts.js'
import { synthesizeBoardView } from './board-router.js'

export interface ProjectionPorts {
  readonly getCoordinator: () => SwarmCoordinator
  readonly isStopping: () => boolean
  readonly getAllGroups: () => CollabGroupRecord[]
  readonly getPosts: (groupId: string) => readonly BoardPost[] | undefined
  readonly resolveMemberLive: (conversationId: number) => MemberLiveSnapshot
}

export interface BoardProjections {
  syncIndex(): void
  syncProjections(): void
  syncCoordinatorProjection(coordinatorConversationId: number): void
  reset(): void
  forgetCoordinator(conversationId: number): void
}

function pickPreferredGroup(
  existing: CollabGroupRecord | undefined,
  candidate: CollabGroupRecord,
): CollabGroupRecord {
  if (existing === undefined) return candidate
  if (existing.status !== candidate.status) return candidate.status === 'active' ? candidate : existing
  if (candidate.updatedAt !== existing.updatedAt) return candidate.updatedAt > existing.updatedAt ? candidate : existing
  return candidate.createdAt > existing.createdAt ? candidate : existing
}

export function createBoardProjections(ports: ProjectionPorts): BoardProjections {
  const writtenViewDigests = new Map<number, string>()
  const projectedCoordinators = new Set<number>()
  const cachedBadgesByCoord = new Map<number, Record<string, BoardBadgeEntry>>()
  let writtenIndexJson = ''
  let writtenBadgesJson = ''

  const flushBadgesDoc = (coord: SwarmCoordinator): void => {
    const byConversation: BoardBadgesDoc['byConversation'] = {}
    for (const entries of cachedBadgesByCoord.values()) Object.assign(byConversation, entries)
    const nextJson = JSON.stringify(byConversation)
    if (nextJson !== writtenBadgesJson) {
      coord.getDocs().boardBadges.set({ byConversation })
      writtenBadgesJson = nextJson
    }
  }

  const clearCoordinatorSlot = (coordId: number, coord: SwarmCoordinator, hasConv: boolean): void => {
    if (projectedCoordinators.has(coordId) && hasConv) coord.getDocs().boardView.set(coordId, null)
    projectedCoordinators.delete(coordId)
    writtenViewDigests.delete(coordId)
    cachedBadgesByCoord.delete(coordId)
  }

  const projectSingleCoordinator = (
    coordId: number,
    group: CollabGroupRecord | undefined,
    coord: SwarmCoordinator,
    previewLimit: number,
  ): void => {
    const coordConv = coord.readConversationOrUndefined(coordId)
    const posts = group !== undefined ? ports.getPosts(group.id) : undefined
    if (group === undefined || posts === undefined) {
      clearCoordinatorSlot(coordId, coord, coordConv !== undefined)
      return
    }

    const { view, digest, badge } = synthesizeBoardView({
      group,
      posts,
      previewLimit,
      resolveMemberLive: ports.resolveMemberLive,
    })

    if (coordConv !== undefined && !group.coordinatorDetached) {
      if (writtenViewDigests.get(coordId) !== digest) {
        coord.getDocs().boardView.set(coordId, view)
        writtenViewDigests.set(coordId, digest)
        projectedCoordinators.add(coordId)
      }
    } else {
      writtenViewDigests.delete(coordId)
      projectedCoordinators.delete(coordId)
    }

    if (group.status === 'active') {
      const slice: Record<string, BoardBadgeEntry> = {}
      if (coordConv !== undefined && !group.coordinatorDetached) slice[String(coordId)] = badge
      for (const m of group.members) {
        if (m.lifecycle === 'active' && coord.readConversationOrUndefined(m.conversationId) !== undefined) {
          slice[String(m.conversationId)] = badge
        }
      }
      if (Object.keys(slice).length > 0) cachedBadgesByCoord.set(coordId, slice)
      else cachedBadgesByCoord.delete(coordId)
    } else {
      cachedBadgesByCoord.delete(coordId)
    }
  }

  const syncIndex = (): void => {
    const coord = ports.getCoordinator()
    if (ports.isStopping() || coord.isShutdown()) return
    const all = ports.getAllGroups()
    const activeGroups = all
      .filter((g) => g.status === 'active')
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    const closedGroups = all
      .filter((g) => g.status === 'closed')
      .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id))
      .slice(0, MAX_INDEX_CLOSED_GROUPS)
    const workers: SwarmWorkerPointer[] = activeGroups.flatMap((g) =>
      g.members
        .filter((m) => m.lifecycle === 'active')
        .map((m) => ({
          conversationId: m.conversationId,
          coordinatorConversationId: g.coordinatorConversationId,
          profileId: m.profileId,
          groupId: g.id,
          name: m.name,
          createdAt: m.createdAt,
        })),
    )
    const nextIndex = { workers, groups: [...activeGroups, ...closedGroups].map(toGroupSummary) }
    const nextJson = JSON.stringify(nextIndex)
    if (nextJson !== writtenIndexJson) {
      coord.writeIndex(nextIndex)
      writtenIndexJson = nextJson
    }
  }

  const syncProjections = (): void => {
    const coord = ports.getCoordinator()
    if (ports.isStopping() || coord.isShutdown()) return
    const previewLimit = coord.getConfig().boardPreviewLimit
    const targetByCoord = new Map<number, CollabGroupRecord>()
    for (const g of ports.getAllGroups()) {
      targetByCoord.set(g.coordinatorConversationId, pickPreferredGroup(targetByCoord.get(g.coordinatorConversationId), g))
    }
    for (const [coordId, group] of targetByCoord) projectSingleCoordinator(coordId, group, coord, previewLimit)
    for (const coordId of new Set([...projectedCoordinators, ...cachedBadgesByCoord.keys()])) {
      if (!targetByCoord.has(coordId)) projectSingleCoordinator(coordId, undefined, coord, previewLimit)
    }
    flushBadgesDoc(coord)
  }

  const syncCoordinatorProjection = (coordinatorConversationId: number): void => {
    const coord = ports.getCoordinator()
    if (ports.isStopping() || coord.isShutdown()) return
    let target: CollabGroupRecord | undefined
    for (const g of ports.getAllGroups()) {
      if (g.coordinatorConversationId === coordinatorConversationId) target = pickPreferredGroup(target, g)
    }
    projectSingleCoordinator(coordinatorConversationId, target, coord, coord.getConfig().boardPreviewLimit)
    flushBadgesDoc(coord)
  }

  return {
    syncIndex,
    syncProjections,
    syncCoordinatorProjection,
    reset() {
      writtenViewDigests.clear()
      projectedCoordinators.clear()
      cachedBadgesByCoord.clear()
      writtenIndexJson = ''
      writtenBadgesJson = ''
    },
    forgetCoordinator(conversationId: number) {
      projectedCoordinators.delete(conversationId)
      writtenViewDigests.delete(conversationId)
    },
  }
}
