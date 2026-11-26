/**
 * Descending conversation detail pagination primitives and pure turn-boundary state machine.
 *
 * Responsibilities:
 * - Single-entry descending visibility classification (`pi.system` / closed `helmx.rewind` intervals,
 *   collecting rewind intervals inline on page 1);
 * - `TurnBoundaryTracker`: pure 3-state (`trailing` / `body` / `head`) descending turn-boundary state machine
 *   enforcing coalesced turn heads, soft entry budget, and trailing divider semantics;
 * - `pageVisibleEntries` and `pageVisibleTurns`: two distinct paging strategies sharing visibility
 *   classification while preserving their separate batching and cursor contracts.
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Harness } from '@earendil-works/pi-durable'
import { coveredByRewind, rewindIntervalOf, type RewindInterval } from './conversation-rewind.js'

/** Soft entry budget for turn-aligned paging: stops at next turn boundary once exceeded after >=1 complete turn. */
export const TURN_SOFT_ENTRY_BUDGET = 200
/** Hard entry cap for turn-aligned paging: bounds pathological mega-turns with 1-displayable-entry lookahead. */
export const TURN_HARD_ENTRY_CAP = 500
/** Batch size per SDK scan iteration during turn-aligned paging. */
export const TURN_SCAN_BATCH_SIZE = 100
/** Batch size per SDK scan iteration once hard-cap lookahead has started. */
export const TURN_LOOKAHEAD_BATCH_SIZE = 20

export type DetailConversationHandle = NonNullable<Awaited<ReturnType<Harness['conversation']>>>

export interface RawDetailEntry {
  readonly id: number
  readonly kind: string
  readonly model?: readonly unknown[]
  readonly data?: unknown
}

export interface PageEntriesResult {
  readonly collected: RawDetailEntry[]
  readonly nextCursor: unknown
}

export type DescendingEntryVisibility = 'hidden' | 'rewind_marker' | 'displayable'
export type TurnScanPhase = 'trailing' | 'body' | 'head'
export type TurnEntryDecision = 'collect' | 'stop_before'

/**
 * Classify one descending entry for detail pagination and optionally collect `helmx.rewind`
 * intervals inline on page 1. Rewind markers are always checked before `coveredByRewind` so
 * markers themselves are never hidden.
 */
export function classifyDescendingEntry(
  raw: RawDetailEntry,
  rewindCuts: RewindInterval[],
  collectRewindsInline: boolean,
): DescendingEntryVisibility {
  if (raw.kind === 'helmx.rewind') {
    if (collectRewindsInline) {
      const interval = rewindIntervalOf(raw)
      if (interval !== undefined) rewindCuts.push(interval)
    }
    return 'rewind_marker'
  }
  if (raw.kind === 'pi.system') return 'hidden'
  if (coveredByRewind(Number(raw.id), rewindCuts)) return 'hidden'
  return 'displayable'
}

/**
 * Pure 3-state (`trailing` -> `body` <-> `head`) descending turn-boundary tracker:
 * - `trailing`: before any turn body has been seen (trailing `pi.reset` / `pi.compaction` dividers
 *   belong to the trailing boundary and do not count as a turn or leave `trailing`);
 * - `body`: inside a turn's response/tool entries;
 * - `head`: inside one or more coalesced openers/dividers at the top (oldest side) of a turn;
 *   crossing into the next older turn's body triggers `stop_before` once `targetTurns` or
 *   `softEntryBudget` (with `>= 1` completed turn) is satisfied.
 */
export class TurnBoundaryTracker {
  private phase: TurnScanPhase = 'trailing'
  private completedTurns = 0

  constructor(
    private readonly targetTurns: number,
    private readonly softEntryBudget: number = TURN_SOFT_ENTRY_BUDGET,
  ) {}

  get currentPhase(): TurnScanPhase {
    return this.phase
  }

  get turnsCompleted(): number {
    return this.completedTurns
  }

  consume(kind: string, collectedCount: number): TurnEntryDecision {
    if (kind === 'helmx.input' || kind === 'pi.user') {
      if (this.phase !== 'head') {
        this.completedTurns += 1
        this.phase = 'head'
      }
      return 'collect'
    }
    if (kind === 'pi.reset' || kind === 'pi.compaction') {
      if (this.phase === 'body') {
        this.completedTurns += 1
        this.phase = 'head'
      }
      return 'collect'
    }
    if (
      this.phase === 'head' &&
      (this.completedTurns >= this.targetTurns ||
        (collectedCount >= this.softEntryBudget && this.completedTurns >= 1))
    ) {
      return 'stop_before'
    }
    this.phase = 'body'
    return 'collect'
  }
}

/**
 * Descending SDK pagination + rewind/pi.system filtering (`?limit=1..500`):
 * fetches exact remaining gaps and returns the opaque SDK `page.next` cursor directly.
 */
export async function pageVisibleEntries(
  conversation: DetailConversationHandle,
  limit: number,
  initialCursor: unknown,
  rewindCuts: RewindInterval[],
  collectRewindsInline = false,
): Promise<PageEntriesResult> {
  const collected: RawDetailEntry[] = []
  let sdkCursor = initialCursor
  let nextCursor: unknown = undefined
  for (;;) {
    const remaining = limit - collected.length
    const page = await conversation.entries(
      { order: 'descending' },
      remaining,
      sdkCursor as never,
      BACKGROUND_CONTEXT,
    )
    for (const raw of page.items as never as RawDetailEntry[]) {
      if (classifyDescendingEntry(raw, rewindCuts, collectRewindsInline) === 'hidden') continue
      collected.push(raw)
    }
    if (page.next === undefined) {
      nextCursor = undefined
      break
    }
    if (collected.length >= limit) {
      nextCursor = page.next
      break
    }
    sdkCursor = page.next
  }
  return { collected, nextCursor }
}

/**
 * Turn-aligned descending pagination (`?turns=1..50`) with exact boundary cursors and
 * folded hard-cap lookahead:
 * - Scans descending in `TURN_SCAN_BATCH_SIZE` batches; collects `helmx.rewind` inline on page 1
 *   without advancing `TurnBoundaryTracker`;
 * - Stops cleanly before the older turn's body once `targetTurns` or `TURN_SOFT_ENTRY_BUDGET`
 *   (after >= 1 complete turn) is reached, emitting `{ after: resumeAfterId, order: 'descending' }`;
 * - Once `TURN_HARD_ENTRY_CAP` is reached, switches the same scan loop into `lookingAhead` mode
 *   (next batches sized at `TURN_LOOKAHEAD_BATCH_SIZE`) until 1 older displayable entry confirms
 *   `nextCursor` or history ends, without advancing `resumeAfterId` past any `helmx.rewind` marker.
 */
export async function pageVisibleTurns(
  conversation: DetailConversationHandle,
  targetTurns: number,
  initialCursor: unknown,
  rewindCuts: RewindInterval[],
  collectRewindsInline = false,
): Promise<PageEntriesResult> {
  const collected: RawDetailEntry[] = []
  const tracker = new TurnBoundaryTracker(targetTurns, TURN_SOFT_ENTRY_BUDGET)
  let sdkCursor = initialCursor
  let resumeAfterId: number | undefined = undefined
  let lookingAhead = false
  let seenRewindInLookahead = false

  for (;;) {
    const batchSize = lookingAhead ? TURN_LOOKAHEAD_BATCH_SIZE : TURN_SCAN_BATCH_SIZE
    const page = await conversation.entries(
      { order: 'descending' },
      batchSize,
      sdkCursor as never,
      BACKGROUND_CONTEXT,
    )
    for (const raw of page.items as never as RawDetailEntry[]) {
      const numericId = Number(raw.id)
      const visibility = classifyDescendingEntry(raw, rewindCuts, collectRewindsInline)
      if (lookingAhead) {
        if (visibility === 'rewind_marker') {
          // Keep resumeAfterId before the rewind marker so the next page still includes it.
          seenRewindInLookahead = true
          continue
        }
        if (visibility === 'hidden') {
          if (!seenRewindInLookahead) resumeAfterId = numericId
          continue
        }
        return {
          collected,
          nextCursor: { after: resumeAfterId!, order: 'descending' },
        }
      }

      if (visibility === 'hidden') {
        if (collected.length > 0) resumeAfterId = numericId
        continue
      }
      if (
        visibility === 'displayable' &&
        tracker.consume(raw.kind, collected.length) === 'stop_before'
      ) {
        return {
          collected,
          nextCursor: { after: resumeAfterId!, order: 'descending' },
        }
      }
      collected.push(raw)
      resumeAfterId = numericId
      if (collected.length >= TURN_HARD_ENTRY_CAP) {
        lookingAhead = true
      }
    }
    if (page.next === undefined) {
      break
    }
    sdkCursor = page.next
  }
  return { collected, nextCursor: undefined }
}
