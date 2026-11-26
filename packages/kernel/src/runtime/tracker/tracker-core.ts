/**
 * TrackerCore: shared dependency bundle and per-conversation registry for the ConversationTracker
 * collaborator modules (tracker/*.ts).
 *
 * Why a core object: the tracker is split into single-purpose collaborators (inputs, live, activity,
 * summary, compaction, settlement, observe) that all operate on the same per-conversation
 * ConversationMirror aggregates. Each collaborator receives this core explicitly through its
 * constructor (no `this` binding / `.call` sharing of facade state) and writes ONLY the mirror fields
 * it owns, so ownership is auditable per module:
 *
 * | Module                | Mirror fields it is the sole writer of                                                     |
 * | :-------------------- | :----------------------------------------------------------------------------------------- |
 * | TrackerCore           | (creates the mirror; owns `mirrors` and `lastEntryIds` registries)                          |
 * | TrackerObserve        | detach, live, inbox, observeGeneration, lastEmittedEntry, lastSeenEntryId                    |
 * | TrackerInputs         | trackedInputs, submissionIndex, consumedInputs                                              |
 * | TrackerLive           | pendingLive, liveDirty, liveTimer, lastEmittedLive, lastEmittedInbox                        |
 * | TrackerActivity       | busyActive, busyCompactions, busyQueued, busySettling                                       |
 * | TrackerSummary        | lastSummaryKey, pendingAskCount, lastAssistant, lastIndexedAssistantEntryId                 |
 * | TrackerSettlement     | settledRunOrder, lastSettledRun, runTaskId, runFirstEntry, settledInflight, settledError, settledWaiters |
 *
 * Reads across modules are allowed (a module may read any mirror field); cross-module writes are not.
 * Tracker-owned state that deliberately lives outside the mirror keeps its existing homes:
 * `settledRuns` (TrackerSettlement), `notifiedCompactionFailures` (TrackerCompaction), busy totals
 * (TrackerActivity), contextUsage cache chain (TrackerSummary).
 */

import type {
  ConversationEntry,
  ConversationInput,
  ConversationLive,
  ConversationSummary,
  TurnSettledPayload,
} from '@helmx/protocol'
import type { Harness } from '@earendil-works/pi-durable'
import type { Models } from '@earendil-works/pi-ai'
import type { HelmxStore } from '../store.js'
import { emitDiagnostic, type KernelDiagnosticInput, type KernelDiagnosticSink } from '../diagnostics.js'
import { type ConversationMirror, createConversationMirror } from '../conversation-mirror.js'

export interface TurnSettledListener {
  (payload: TurnSettledPayload, consumedInputs: ConversationInput[]): Promise<void> | void
}

export interface TrackerEvents {
  onSummaryChanged(summary: ConversationSummary): void
  onInputCommitted(conversationId: number, input: ConversationInput): void
  onAssistantText(conversationId: number, entryId: number, text: string): void
  onTurnSettled: TurnSettledListener
  /** New timeline entry persisted to store (new items only, once per ID; omits historical entries from initial observe). */
  onEntryCommitted?(conversationId: number, entry: ConversationEntry): void
  /** Live conversation delta (accumulated streaming text snapshot + tool cards; throttled pushes, flushed at settlement). */
  onLiveChanged?(live: ConversationLive): void
  /** Asynchronous failures such as compaction failure reported once explicitly via EventHub notification channel. */
  onNotification?(payload: { level: 'info' | 'warning' | 'error'; title: string; body?: string; conversationId: number }): void
}

export interface TrackerCoreOptions {
  readonly harness: Harness
  readonly store: HelmxStore
  readonly events: TrackerEvents
  /** Error summary redactor (shared source with runtime SecretStash); defaults to identity (test environments only). */
  readonly redactError?: (text: string) => string
  /** Current conversation ownership reader (injected by Runtime via ownership.getOwnership); defaults to human.
   * Used solely for unread policy on turn settlement so background derived sub-conversations never mark fake human unreads. */
  readonly ownershipOf?: (id: number) => 'helmx' | 'human'
  /** Current Models catalog reader (for contextUsage window lookup); if omitted, contextWindow stays unset without fabricating. */
  readonly models?: () => Models
  /** Host closing predicate (double protection alongside tracker.close()). */
  readonly isClosed?: () => boolean
  /** Diagnostic channel sink (defaults to defaultDiagnosticSink). */
  readonly onDiagnostic?: KernelDiagnosticSink
}

export class TrackerCore {
  readonly harness: Harness
  readonly store: HelmxStore
  readonly events: TrackerEvents
  /** Error summary redactor (Runtime injects stashService.redact so provider errors cannot echo registered secrets). */
  readonly redactError: (text: string) => string
  /** Live conversation ownership reader (defaults to human); consumed solely by unread policy on turn settlement. */
  readonly ownershipOf: ((id: number) => 'helmx' | 'human') | undefined
  /** Live Models catalog reader (if omitted, window stays unset). */
  readonly modelsOf: (() => Models) | undefined
  /** conversation -> per-conversation aggregate mirror (created on observe or first write; deleted wholesale on stopObserving). */
  readonly mirrors = new Map<number, ConversationMirror>()
  /** conversation -> latest visible timeline entry ID (`0` when none; excludes `pi.system` and rewound intervals). */
  readonly lastEntryIds = new Map<number, number>()
  /** Diagnostic channel sink (injectable after construction; defaults to defaultDiagnosticSink). */
  private diagnosticSink: KernelDiagnosticSink | undefined
  /** Tracker shutdown guard (blocks late async reconciliation side effects after close() or host isClosed becomes true). */
  private closed = false
  /** Host closing state reader (defaults to false; double guard alongside tracker.closed). */
  private readonly isClosedFn: (() => boolean) | undefined

  constructor(options: TrackerCoreOptions) {
    this.harness = options.harness
    this.store = options.store
    this.events = options.events
    this.redactError = options.redactError ?? ((text) => text)
    this.ownershipOf = options.ownershipOf
    this.modelsOf = options.models
    this.isClosedFn = options.isClosed
    this.diagnosticSink = options.onDiagnostic
  }

  /** Get (creating if needed) the mirror for a conversation: single entry point for all write paths. */
  mirrorOf(id: number): ConversationMirror {
    let mirror = this.mirrors.get(id)
    if (mirror === undefined) {
      mirror = createConversationMirror()
      this.mirrors.set(id, mirror)
    }
    return mirror
  }

  /** Drop the mirror and entry watermark of a conversation (stopObserving only; never touches persisted data). */
  deleteMirror(id: number): void {
    this.mirrors.delete(id)
    this.lastEntryIds.delete(id)
  }

  /** Host closing state: tracker.close() was called or the host reports closed. */
  get isClosing(): boolean {
    return this.closed || (this.isClosedFn?.() ?? false)
  }

  /** Block all late async side effects (close()). */
  markClosed(): void {
    this.closed = true
  }

  /** Attach or replace the diagnostic sink (wired during KernelRuntime construction). */
  setDiagnosticSink(sink: KernelDiagnosticSink | undefined): void {
    this.diagnosticSink = sink
  }

  reportDiagnostic(input: KernelDiagnosticInput): void {
    emitDiagnostic(this.diagnosticSink, this.redactError, input)
  }
}
