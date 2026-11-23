/**
 * runs/cancellation.ts — Subtree boundary cancellation tracker.
 *
 * Critical bugfix over legacy cancellation-tracker.ts:
 * - Strictly separates `boundarySeeds` (conversations entering `cancellingCounts`) from `aborted` runs:
 *   `abort(runId)` ONLY marks `activeRun.childConversations` (and dynamically added child conversations
 *   of matched runs), NEVER marking `activeRun.conversationId` (the parent conversation)!
 *   Sibling background tasks under the parent conversation therefore keep delivering reports and
 *   new sibling spawns are never falsely rejected during `abort(runId)`.
 * - `cancelRunsUnderConversation(convId)` explicitly passes `[convId]` as `boundarySeeds` so the
 *   aborted parent conversation and its entire descendant tree are cleanly sealed.
 */
import { HelmxError } from '@helmx/protocol'
import type { ActiveRun } from './types.js'

export interface CancellationTrackerOptions {
  active: Map<string, ActiveRun>
  parentConversationOf(id: number): number | undefined
}

export type BoundaryMatch = (
  run: ActiveRun,
  isWithin: (candidate: number, seed: number) => boolean,
  seeds: ReadonlySet<number>,
) => boolean

export class CancellationTracker {
  private readonly cancellingCounts = new Map<number, number>()
  private readonly boundaryCancels = new Map<string, Promise<void>>()
  private readonly active: Map<string, ActiveRun>
  private readonly parentConversationOf: (id: number) => number | undefined

  constructor(options: CancellationTrackerOptions) {
    this.active = options.active
    this.parentConversationOf = options.parentConversationOf
  }

  isCancelling(conversationId: number): boolean {
    return this.cancellingCounts.has(conversationId)
  }

  assertNotCancelling(conversationId: number): void {
    if (this.cancellingCounts.has(conversationId)) {
      throw new HelmxError(
        'aborted',
        `会话 ${conversationId} 所在任务树正在取消，拒绝启动新运行`,
        409,
        { conversationId },
      )
    }
  }

  async cancelBoundary(
    key: string,
    initialBoundarySeeds: readonly number[],
    match: BoundaryMatch,
  ): Promise<void> {
    const inflight = this.boundaryCancels.get(key)
    if (inflight !== undefined) return inflight
    const task = this.runBoundaryCancel(key, initialBoundarySeeds, match)
    this.boundaryCancels.set(key, task)
    try {
      await task
    } finally {
      if (this.boundaryCancels.get(key) === task) this.boundaryCancels.delete(key)
    }
  }

  private async runBoundaryCancel(
    key: string,
    initialBoundarySeeds: readonly number[],
    match: BoundaryMatch,
  ): Promise<void> {
    const held: number[] = []
    const seeds = new Set<number>()
    const markSeed = (id: number): void => {
      if (seeds.has(id)) return
      seeds.add(id)
      this.cancellingCounts.set(id, (this.cancellingCounts.get(id) ?? 0) + 1)
      held.push(id)
    }

    for (const seed of initialBoundarySeeds) markSeed(seed)

    const parentCache = new Map<number, number | undefined>()
    const parentOf = (id: number): number | undefined => {
      if (!parentCache.has(id)) {
        let parent: number | undefined
        try {
          parent = this.parentConversationOf(id)
        } catch {
          parent = undefined
        }
        parentCache.set(id, parent)
      }
      return parentCache.get(id)
    }

    const isWithin = (candidate: number, seed: number): boolean => {
      if (candidate === seed) return true
      const visited = new Set<number>()
      let current: number | undefined = candidate
      while (current !== undefined && !visited.has(current)) {
        visited.add(current)
        if (current === seed) return true
        current = parentOf(current)
      }
      return false
    }

    const aborted = new Set<ActiveRun>()
    try {
      for (let round = 0; round < 64; round++) {
        // Dynamically absorb any late child conversations registered onto already-matched runs.
        let expanded = false
        for (const run of aborted) {
          for (const childId of run.childConversations) {
            if (!seeds.has(childId)) {
              markSeed(childId)
              expanded = true
            }
          }
        }
        const next = [...this.active.values()].filter((r) => !aborted.has(r) && match(r, isWithin, seeds))
        if (next.length === 0 && !expanded) break
        for (const run of next) {
          // Mark ONLY the run's child conversations (and run.conversationId ONLY if it is already inside seeds).
          for (const childId of run.childConversations) markSeed(childId)
          for (const seed of seeds) {
            if (isWithin(run.conversationId, seed)) {
              markSeed(run.conversationId)
              break
            }
          }
          aborted.add(run)
          run.userAborted = true
          run.abort.abort()
        }
      }

      if (aborted.size > 0 && [...this.active.values()].some((r) => !aborted.has(r) && match(r, isWithin, seeds))) {
        process.stderr.write(`workflow: boundary cancel ${key} reached 64-round cap\n`)
      }

      await Promise.all([...aborted].map((r) => r.done))

      // Final sweep for any stragglers that landed while awaiting settlement.
      for (const run of aborted) {
        for (const childId of run.childConversations) markSeed(childId)
      }
      const stragglers = [...this.active.values()].filter((r) => !aborted.has(r) && match(r, isWithin, seeds))
      for (const run of stragglers) {
        for (const childId of run.childConversations) markSeed(childId)
        run.userAborted = true
        run.abort.abort()
        await run.done
      }
    } finally {
      for (const id of held) {
        const count = this.cancellingCounts.get(id) ?? 1
        if (count <= 1) this.cancellingCounts.delete(id)
        else this.cancellingCounts.set(id, count - 1)
      }
    }
  }
}
