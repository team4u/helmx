/**
 * EventHub: event bus with globally persisted seq + SSE snapshot/incremental streams.
 *
 * Semantics (per design doc §1.2):
 * - seq increases monotonically and is persisted (helmx_seq), never regressing across restarts; publish strictly orders
 *   assemble+redact -> encode -> persist nextSeq -> advance in-memory watermark -> append to ring -> broadcast;
 *   if any step fails, the watermark never advances and no partial state remains (never creates a bare seq gap without a ring entry);
 * - Each instance generates a random bootId (event epoch): both `?afterSeq` and `?bootId` credentials must validate before
 *   allowing short-disconnect resumption (initial `resumed` frame + ring replay + live delta, strictly zero duplicates/drops);
 *   cross-epoch, out-of-range (future) seq, or ring gaps always fall back to full snapshot sync rather than skipping gaps
 *   under false success; malformed query parameters (non-non-negative safe integer / length out of range / single credential) fail with 400;
 * - Resume ring: stores immutable SSE bytes encoded once at publish time (shared by live subscribers and replay so subscribers cannot
 *   tamper with replay data and without duplicating the SQLite event table); bounded by both frame count and bytes
 *   (default 1024 frames / 4 MiB, evicting oldest from head); a single frame exceeding the byte budget clears the ring so no client can
 *   resume across it; replay flushes incrementally via ReadableStream.pull at consumer pace instead of stuffing the queue inside start
 *   (fast consumers are never killed by the pending-byte limit; new frames arriving during flush count separately toward slow-consumer budget);
 * - Keeps publish and subscribe names (apps call kernel.events.publish(type, payload));
 * - response(request): standard SSE—subscribe+buffer first, then take synchronous snapshot (or ring+headSeq), emit initial
 *   `event: snapshot` (HelmxSnapshot with bootId) or `event: resumed` (HelmxResumedFrame), then frame-by-frame `event: <type>` + `data: {seq,event}`;
 *   both Request.signal abort and ReadableStream.cancel unsubscribe and close the stream; stays open as a pure live stream when idle;
 * - sseStream(consume): programmatic consumer API (same snapshot-first semantics), returning an unsubscribe handle;
 *   if consumer returns false or throws, that subscription is isolated and cleaned up without affecting others;
 * - Payload boundary validation/assembly lives in event-validation.ts (pure functions); SSE encoding and byte backpressure
 *   primitives live in sse-stream.ts (shared with SessionDocEventHub);
 * - Unknown types pass through verbatim as CustomHelmxEvent {type, payload} without masquerading as notifications;
 * - Bounded backpressure: exceeding pending frame/byte caps flags a slow client and closes the stream explicitly (client reconnects
 *   with snapshot to resync), never dropping frames silently; snapshot providers are synchronous, needing no async snapshot system.
 *
 * Implementation split: this module owns `EventHub`; `./session-doc-event-hub.ts` owns the per-tuple
 * `SessionDocEventHub`; shared defaults live in `./constants.ts`. `../events.ts` re-exports both.
 */
import { randomUUID } from 'node:crypto'
import { diffConversationLive } from '@helmx/protocol'
import type {
  ConversationLive,
  ConversationSummary,
  HelmxEvent,
  HelmxEventFrame,
  HelmxResumedFrame,
  HelmxSnapshot,
  HelmxTransientLiveDeltaFrame,
  HelmxTransientLiveFrame,
  MaybePromise,
} from '@helmx/protocol'
import { redactJsonValue } from '../../redact.js'
import { assembleHelmxEvent, pruneUndefined, validateAndRedactConversationLive } from '../event-validation.js'
import { encodeSseChunk, SseStreamController } from '../sse-stream.js'
import { DEFAULT_KEEPALIVE_MS, DEFAULT_MAX_PENDING_BYTES, MAX_PENDING_EVENTS } from './constants.js'

/**
 * Snapshot provider: omits bootId (injected by the EventHub instance as single source of truth);
 * seq is the provider-side known watermark, resolved via max against the hub's current seq.
 */
export type SnapshotProvider = () => Omit<HelmxSnapshot, 'bootId'>

interface EventSubscription {
  unsubscribe(): void
}

/** Result of a single publish delivery. */
interface EventPublishResult {
  /** Validated and redacted event frame for this publish (already in SSE ring and broadcast). */
  readonly frame: HelmxEventFrame
  /** Internal host listener delivery promise/result (once; undefined if not installed). Callers can await
   * when needed (public emitEvent contract) or fire-and-forget on kernel auto-events (trackers, etc.,
   * where errors per listener are isolated internally and the returned promise never rejects). */
  readonly internal: MaybePromise<void> | undefined
}

/** SSE output frame: initial snapshot/resumed control frame or incremental {seq, event}. */
export type SseFrame = HelmxSnapshot | HelmxEventFrame

/** Resume ring entry: immutable SSE bytes encoded at publish time (prevents subscriber mutation of replay data). */
interface RingEntry {
  seq: number
  chunk: Uint8Array
}

/** Event dispatched internally to plugin host listeners (`HelmxEvent` plus transient `conversation.live`). */
export type HostDispatchedEvent =
  | HelmxEvent
  | { type: 'conversation.live'; live: ConversationLive }

/** Internal host event dispatcher installed by `KernelRuntime`. */
type HostEventDispatcher = (event: HostDispatchedEvent) => MaybePromise<void>

/** Default resume ring capacity: 1024 frames / 4 MiB bytes (evicts oldest entries from head when exceeded). */
const DEFAULT_RING_MAX_FRAMES = 1024
const DEFAULT_RING_MAX_BYTES = 4 * 1024 * 1024

function isActiveLiveView(live: ConversationLive): boolean {
  return (
    live.text !== '' ||
    (live.thinking !== undefined && live.thinking !== '') ||
    live.tools.length > 0 ||
    live.generation !== undefined ||
    (live.queuedInputs?.length ?? 0) > 0
  )
}

export class EventHub {
  private seqValue: number
  /** Event epoch identifier (generated randomly per instance): one of the two resume credentials; seq is contiguous only within the same epoch. */
  readonly bootId: string
  /** Resume ring (contiguous seq range evicted from head; cleared if a single frame exceeds budget so nobody resumes across it). */
  private readonly ring: RingEntry[] = []
  private ringBytes = 0
  private readonly ringMaxFrames: number
  private readonly ringMaxBytes: number
  private readonly subscribers = new Set<(frame: HelmxEventFrame, chunk: Uint8Array) => void>()
  /** Connected `/api/events` SSE stream transient live senders (excluded from durable `subscribers` / `seq` / `ring`). */
  private readonly transientStreamSenders = new Set<(chunk: Uint8Array) => void>()
  /** Programmatic transient `conversation.live` listeners (never consume durable `seq`). */
  private readonly transientListeners = new Set<(frame: HelmxTransientLiveFrame) => void>()
  /** Latest active live views per conversation (reconciled into `HelmxResumedFrame.conversationLives`). */
  private readonly latestLives = new Map<number, ConversationLive>()
  /** Exact redacted+stamped live snapshot last broadcast to SSE streams (baseline for `conversation.live.delta`). */
  private readonly latestLiveDeltaBase = new Map<number, ConversationLive>()
  /** Monotonic per-conversation live revision counter for delta continuity validation. */
  private readonly liveRevs = new Map<number, number>()
  /** Internal host event dispatcher (installed by runtime; invoked once per publish as the single dispatch boundary). */
  private hostDispatcher: HostEventDispatcher | undefined
  private readonly snapshot: SnapshotProvider
  private readonly persistSeq: (seq: number) => void
  private readonly streamClosers = new Set<() => void>()
  private readonly maxPendingBytes: number
  /** SSE idle heartbeat interval (disabled if <= 0); comment lines keep proxies/intermediaries alive and let clients detect stalls. */
  private readonly keepaliveMs: number
  /** redact(text) -> redacted text (secret plaintext -> marker; reused recursively by redactJsonValue). */
  redact: (text: string) => string = (t) => t

  set redactFn(fn: (text: string) => string) {
    this.redact = fn
  }

  constructor(options: {
    initialSeq: number
    snapshot: SnapshotProvider
    persistSeq?: (seq: number) => void
    /** Unread byte cap during streaming (slow client threshold); defaults to 1 MiB. */
    maxPendingBytes?: number
    /** SSE idle heartbeat interval (ms); defaults to 15s, <= 0 disables (use small values to speed up tests). */
    keepaliveMs?: number
    /** Event epoch ID (random UUID by default; injectable in tests). */
    bootId?: string
    /** Resume ring frame capacity; defaults to 1024 (tunable in tests to verify eviction). */
    ringMaxFrames?: number
    /** Resume ring byte capacity; defaults to 4 MiB (tunable in tests to verify eviction). */
    ringMaxBytes?: number
  }) {
    this.seqValue = options.initialSeq
    this.bootId = options.bootId ?? randomUUID()
    this.snapshot = options.snapshot
    this.persistSeq = options.persistSeq ?? (() => {})
    this.maxPendingBytes = options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES
    this.keepaliveMs = options.keepaliveMs ?? DEFAULT_KEEPALIVE_MS
    this.ringMaxFrames = options.ringMaxFrames ?? DEFAULT_RING_MAX_FRAMES
    this.ringMaxBytes = options.ringMaxBytes ?? DEFAULT_RING_MAX_BYTES
  }

  get seq(): number {
    return this.seqValue
  }

  /** Number of currently active subscribers (for diagnostics and tests). */
  get subscriberCount(): number {
    return this.subscribers.size
  }

  /** Clear all subscriptions (called on kernel.close to eliminate subscriber leaks). */
  close(): void {
    for (const stop of [...this.streamClosers]) stop()
    this.subscribers.clear()
    this.transientStreamSenders.clear()
    this.transientListeners.clear()
    this.latestLives.clear()
    this.latestLiveDeltaBase.clear()
    this.liveRevs.clear()
    this.hostDispatcher = undefined
  }

  /**
   * Install the internal host event dispatcher (single dispatch boundary for ctx.host.onEvent listeners):
   * invoked exactly once after SSE broadcast per publish with the validated+redacted HelmxEvent envelope
   * (matching protocol onEvent contract). Must return synchronously (may return a promise) and never throw
   * (listener errors are isolated internally), avoiding false errors after broadcast has already succeeded.
   */
  setHostDispatcher(dispatch: HostEventDispatcher): void {
    this.hostDispatcher = dispatch
  }

  /**
   * Publish an event (strict ordering: assemble+redact -> encode -> persist -> advance memory -> ring -> broadcast
   * -> internal host dispatch). Failures in buildEvent/persistSeq throw without advancing the watermark, appending to
   * the ring, or broadcasting—persistence errors never leave a bare seq gap (otherwise the next successful publish would
   * create a gap in the ring and break resume). Each frame is encoded once (immutable bytes), shared by ring replay and all subscribers.
   *
   * Returns the emitted frame and internal host listener dispatch (exactly once): callers needing to await async internal listeners
   * (public emitEvent) await `internal`; kernel auto-events (trackers, etc.) ignore the return value (fire-and-forget) so synchronous
   * observation paths (e.g., SDK callbacks) are never blocked.
   */
  publish(
    type: string,
    payload: unknown,
    options?: { internalPayload?: unknown },
  ): EventPublishResult {
    const nextSeq = this.seqValue + 1
    const event = this.buildEvent(type, payload)
    const internalEvent =
      options?.internalPayload !== undefined ? this.buildEvent(type, options.internalPayload) : event
    const frame: HelmxEventFrame = { seq: nextSeq, event }
    // V8 cannot freeze non-empty TypedArray views; immutability is guaranteed structurally: the ring only retains these isolated
    // encoded bytes (never sharing mutable event object graphs with subscribers), and all internal consumers (ring replay /
    // controller.enqueue) treat them as read-only.
    const chunk = encodeSseChunk(String(event.type), frame)
    this.persistSeq(nextSeq)
    this.seqValue = nextSeq
    this.pushRing(nextSeq, chunk)
    this.reconcileLatestLivesOnDurableEvent(event)
    for (const deliver of [...this.subscribers]) {
      try {
        deliver(frame, chunk)
      } catch {
        // Isolate errors from individual subscriber callbacks (cleanup is handled per-subscriber) without impacting others.
      }
    }
    return { frame, internal: this.hostDispatcher?.(internalEvent) }
  }

  /**
   * Validate and redact an event and deliver it exclusively to the internal host
   * dispatcher (`ctx.host.onEvent`), without advancing `seq`, persisting, appending
   * to the replay ring, or broadcasting to SSE subscribers.
   */
  dispatchInternalOnly(type: string, payload: unknown): MaybePromise<void> | undefined {
    const event = this.buildEvent(type, payload)
    return this.hostDispatcher?.(event)
  }

  /**
   * Publish a transient `conversation.live` frame without touching `seqValue`, `persistSeq`,
   * or the durable replay ring buffer. Validates and redacts the live view, updates
   * `latestLives` for `resumed` reconciliation, broadcasts `event: conversation.live`
   * directly to connected `/api/events` SSE clients, and dispatches `{ type: 'conversation.live', live }`
   * synchronously to the internal host dispatcher (`ctx.host.onEvent`).
   */
  publishTransientLive(live: ConversationLive): MaybePromise<void> | undefined {
    const validated = validateAndRedactConversationLive(live, (t) => this.redact(t))
    const nextRev = (this.liveRevs.get(validated.conversationId) ?? 0) + 1
    this.liveRevs.set(validated.conversationId, nextRev)
    const stamped: ConversationLive = { ...validated, rev: nextRev }
    let chunk: Uint8Array | undefined
    if (this.transientStreamSenders.size > 0) {
      const prevBase = this.latestLiveDeltaBase.get(stamped.conversationId)
      if (prevBase !== undefined && prevBase.rev !== undefined) {
        const deltaFrame: HelmxTransientLiveDeltaFrame = {
          delta: diffConversationLive(prevBase, stamped, prevBase.rev, nextRev),
        }
        chunk = encodeSseChunk('conversation.live.delta', deltaFrame)
      } else {
        const fullFrame: HelmxTransientLiveFrame = { live: stamped }
        chunk = encodeSseChunk('conversation.live', fullFrame)
      }
    }
    if (isActiveLiveView(stamped)) {
      this.latestLives.set(stamped.conversationId, stamped)
      this.latestLiveDeltaBase.set(stamped.conversationId, stamped)
    } else {
      this.latestLives.delete(stamped.conversationId)
      this.latestLiveDeltaBase.delete(stamped.conversationId)
    }
    if (chunk !== undefined) {
      for (const send of [...this.transientStreamSenders]) {
        try {
          send(chunk)
        } catch {
          // isolate broken stream sender (stream cleanup already ran on shutdown)
        }
      }
    }
    if (this.transientListeners.size > 0) {
      const listenerFrame: HelmxTransientLiveFrame = { live: validated }
      for (const listen of [...this.transientListeners]) {
        try {
          listen(listenerFrame)
        } catch {
          // isolate broken programmatic listener
        }
      }
    }
    return this.hostDispatcher?.({ type: 'conversation.live', live: validated })
  }

  /** Subscribe to transient `conversation.live` frames (test / in-process consumption). */
  subscribeTransientLive(listener: (frame: HelmxTransientLiveFrame) => void): () => void {
    this.transientListeners.add(listener)
    return () => {
      this.transientListeners.delete(listener)
    }
  }

  private reconcileLatestLivesOnDurableEvent(event: HelmxEvent): void {
    if (event.type === 'conversation.upsert' && 'conversation' in event) {
      const conv = event.conversation as ConversationSummary
      if (conv.status !== 'working' && conv.status !== 'blocked') {
        // Clients clear/rewrite their local live slot on terminal upsert, so drop the delta baseline
        // to force the next publishTransientLive to emit a self-contained full `conversation.live` frame.
        this.latestLiveDeltaBase.delete(conv.id)
        const existing = this.latestLives.get(conv.id)
        if (existing !== undefined) {
          if ((existing.queuedInputs?.length ?? 0) > 0) {
            this.latestLives.set(conv.id, {
              conversationId: existing.conversationId,
              text: '',
              tools: [],
              queuedInputs: existing.queuedInputs,
              updatedAt: existing.updatedAt,
            })
          } else {
            this.latestLives.delete(conv.id)
          }
        }
      }
    } else if (event.type === 'conversation.deleted' && 'conversationId' in event) {
      const id = (event as { conversationId: number }).conversationId
      this.latestLives.delete(id)
      this.latestLiveDeltaBase.delete(id)
      this.liveRevs.delete(id)
    }
  }

  /** Append to ring: if non-contiguous (defensive guard against any bare seq gap), drop stale segments and rebuild
   * from this frame; evict oldest entries from head when exceeding frame/byte limits; clear the ring if a single frame exceeds
   * the byte budget so no client can resume across it (better to fall back to snapshot than silently skip gaps). */
  private pushRing(seq: number, chunk: Uint8Array): void {
    const last = this.ring[this.ring.length - 1]
    if (last !== undefined && last.seq + 1 !== seq) {
      this.ring.length = 0
      this.ringBytes = 0
    }
    const bytes = chunk.byteLength
    if (bytes > this.ringMaxBytes) {
      this.ring.length = 0
      this.ringBytes = 0
      return
    }
    this.ring.push({ seq, chunk })
    this.ringBytes += bytes
    while (this.ring.length > this.ringMaxFrames || this.ringBytes > this.ringMaxBytes) {
      const evicted = this.ring.shift()
      if (evicted === undefined) break
      this.ringBytes -= evicted.chunk.byteLength
    }
  }

  /** Return the current snapshot (reused by HTTP GET and SSE initial frame) after pruning undefineds and applying
   * recursive redaction, injecting this instance's bootId as the single source of truth for the event epoch. */
  currentSnapshot(): HelmxSnapshot {
    const snap = this.snapshot()
    const redacted = redactJsonValue(pruneUndefined(snap, new WeakSet()), (t) => this.redact(t)) as HelmxSnapshot
    // Align snapshot conversationLives with the active SSE delta baseline (carrying exact `rev`) so newly
    // connecting clients seamlessly consume subsequent shared `conversation.live.delta` frames.
    if (this.latestLiveDeltaBase.size > 0) {
      const aligned: ConversationLive[] = []
      const seen = new Set<number>()
      for (const item of redacted.conversationLives ?? []) {
        const base = this.latestLiveDeltaBase.get(item.conversationId)
        aligned.push(base !== undefined ? base : item)
        seen.add(item.conversationId)
      }
      for (const [conversationId, base] of this.latestLiveDeltaBase) {
        if (!seen.has(conversationId)) aligned.push(base)
      }
      redacted.conversationLives = aligned
    }
    return { ...redacted, seq: Math.max(snap.seq, this.seqValue), bootId: this.bootId, serverTime: Date.now() }
  }

  /** Subscribe to incremental frames; returns an unsubscribe function (HTTP layer consumes response(); this entrypoint serves programmatic callers and tests). */
  subscribe(listener: (frame: HelmxEventFrame) => void): () => void {
    this.subscribers.add(listener)
    return () => {
      this.subscribers.delete(listener)
    }
  }

  /**
   * Programmatic SSE stream: registers a buffered subscription first, then captures a snapshot; after emitting the snapshot,
   * flushes buffered frames with seq > snapshot.seq. Unsubscribes cleanly before finishing/rethrowing if the consumer returns
   * false/throws or if snapshot fails, preventing subscriber leaks.
   */
  sseStream(consume: (frame: SseFrame) => boolean | void): EventSubscription {
    const handle = this.openStream((frame) => consume(frame) !== false)
    let snap: HelmxSnapshot
    try {
      snap = this.currentSnapshot()
    } catch (error) {
      handle.unsubscribe()
      throw error
    }
    try {
      if (consume(snap) === false) {
        handle.unsubscribe()
        return { unsubscribe: handle.unsubscribe }
      }
    } catch {
      handle.unsubscribe()
      return { unsubscribe: handle.unsubscribe }
    }
    handle.goLive(snap.seq)
    return { unsubscribe: handle.unsubscribe }
  }

  /**
   * HTTP SSE response: returns Response immediately; initial frame is `snapshot` (or `resumed`), followed by incremental seq frames.
   * When `?afterSeq` and `?bootId` both validate, emits `resumed` first and replays ring-cached frames by seq;
   * cross-epoch, future seq, or cache gaps fall back to snapshot; malformed credentials return 400 explicitly.
   * Replay bytes are NOT stuffed into start all at once (which would hit the 1 MiB pending cap before pull drains and falsely kill
   * fast consumers); instead they enter the flush queue drained step-by-step via pull at consumer pace, while live frames arriving
   * mid-flush count against the slow-consumer budget separately (replay entries reference shared ring bytes with 0 double-counting).
   * Closes and unsubscribes on request.signal abort or ReadableStream.cancel; stays open when idle without falling back to JSON;
   * writes `: keepalive` comment lines every keepaliveMs during idle periods (started after flush finishes; heartbeats flow through
   * unified byte backpressure and stop on abort/cancel/close).
   */
  response(request: Request): Response {
    const query = EventHub.parseResumeQuery(request)
    if (query.error !== undefined) {
      // Strict boundary check: malformed resume credentials fail with 400 rather than being silently ignored or partially applied.
      return new Response(JSON.stringify({ error: { code: 'invalid_input', message: query.error } }), {
        status: 400,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
    }

    let unsubscribe: (() => void) | undefined
    const sendTransientChunk = (chunk: Uint8Array): void => {
      if (stream.closed) return
      if (!stream.send(chunk)) stream.close()
    }
    const stream = new SseStreamController({
      request,
      maxPendingBytes: this.maxPendingBytes,
      keepaliveMs: this.keepaliveMs,
      onClose: () => {
        this.transientStreamSenders.delete(sendTransientChunk)
        unsubscribe?.()
        unsubscribe = undefined
      },
    })

    // Subscribe first, then sample synchronously (within the same microtask, buffering prevents missed frames); snapshot errors throw synchronously to HTTP.
    const handle = this.openStream(
      (_frame, chunk) => stream.send(chunk),
      () => stream.close(),
    )
    unsubscribe = handle.unsubscribe

    const resume = query.resume
    let liveSeq: number
    let handshake: Uint8Array
    let replay: Uint8Array[] = []
    if (resume !== undefined && this.canResume(resume)) {
      // Resume: sample headSeq + ring slice (subscription is already live so subsequent publishes enter flush queue or direct write without a gap).
      liveSeq = this.seqValue
      const resumedFrame: HelmxResumedFrame = {
        bootId: this.bootId,
        seq: resume.afterSeq,
        headSeq: liveSeq,
        conversationLives: [...this.latestLives.values()],
        serverTime: Date.now(),
      }
      handshake = encodeSseChunk('resumed', resumedFrame)
      replay = this.ring.filter((entry) => entry.seq > resume.afterSeq).map((entry) => entry.chunk)
    } else {
      let snap: HelmxSnapshot
      try {
        snap = this.currentSnapshot()
      } catch (error) {
        stream.close()
        throw error
      }
      liveSeq = snap.seq
      handshake = encodeSseChunk('snapshot', snap)
    }

    return stream.toResponse(() => {
      // Write handshake frame immediately (subject to byte budget); replay bytes are held out for pull-driven flushing
      // at consumer pace so consumers that haven't called pull yet don't hit the 1 MiB pending cap prematurely.
      if (!stream.write(handshake)) {
        stream.close()
        return
      }
      stream.beginReplayFlush(replay)
      // Flush buffered frames from subscription setup (seq > liveSeq): tail-queued during flush, or written directly.
      if (!handle.goLive(liveSeq)) return
      if (!stream.closed) this.transientStreamSenders.add(sendTransientChunk)
      if (!stream.flushing) stream.startKeepalive()
    })
  }

  /** Parse `?afterSeq`/`?bootId` resume parameters: omitted means normal connection; when present, both must be paired,
   * unique, and well-formed (non-negative safe integer / 1..64 non-empty string). Malformed or duplicated params fail with 400
   * rather than partially resuming (URLSearchParams.get would silently ignore duplicate params, so reject explicitly via getAll). */
  private static parseResumeQuery(request: Request): { resume?: { afterSeq: number; bootId: string }; error?: string } {
    let params: URLSearchParams
    try {
      params = new URL(request.url).searchParams
    } catch {
      return { error: 'cannot parse request URL query parameters' }
    }
    const afterSeqAll = params.getAll('afterSeq')
    const bootIdAll = params.getAll('bootId')
    if (afterSeqAll.length > 1 || bootIdAll.length > 1) {
      return { error: '?afterSeq and ?bootId must not be specified multiple times' }
    }
    if (afterSeqAll.length === 0 && bootIdAll.length === 0) return {}
    if (afterSeqAll.length === 0 || bootIdAll.length === 0) {
      return { error: '?afterSeq and ?bootId must be provided together to resume' }
    }
    const afterSeqRaw = afterSeqAll[0]!
    const bootIdRaw = bootIdAll[0]!
    if (!/^\d{1,16}$/.test(afterSeqRaw) || !Number.isSafeInteger(Number(afterSeqRaw))) {
      return { error: 'afterSeq must be a non-negative safe integer' }
    }
    if (bootIdRaw.length === 0 || bootIdRaw.length > 64) {
      return { error: 'bootId must be a non-empty string of length 1..64' }
    }
    return { resume: { afterSeq: Number(afterSeqRaw), bootId: bootIdRaw } }
  }

  /** Eligibility for resumption: same epoch, not beyond headSeq, and when (afterSeq, headSeq] is non-empty, the ring must cover
   * the interval contiguously (first frame <= afterSeq+1, last frame === headSeq, consecutive +1 steps; linear scan is cheap over
   * <=1024 frames). Otherwise fall back to snapshot—a missing tail frame would leave the client stuck behind headSeq indefinitely
   * while keepalives keep the idle watchdog happy, so never issue a false `resumed`. Equal afterSeq == headSeq resumes with zero
   * replay frames, still requiring matching bootId. */
  private canResume(resume: { afterSeq: number; bootId: string }): boolean {
    if (resume.bootId !== this.bootId) return false
    const headSeq = this.seqValue
    if (resume.afterSeq > headSeq) return false
    if (resume.afterSeq === headSeq) return true
    if (this.ring.length === 0) return false
    if (this.ring[0]!.seq > resume.afterSeq + 1) return false
    if (this.ring[this.ring.length - 1]!.seq !== headSeq) return false
    for (let i = 1; i < this.ring.length; i++) {
      if (this.ring[i]!.seq !== this.ring[i - 1]!.seq + 1) return false
    }
    return true
  }

  /**
   * Open an internal buffered subscription: buffers frames first (pairing frames with pre-encoded bytes to avoid re-encoding
   * on flush), then goLive(snapshotSeq) flushes newer buffered frames and switches to live delivery. If onFrame returns false
   * (write failure / overflow / consumer stop) or throws, unsubscribes immediately and invokes onStop.
   */
  private openStream(
    onFrame: (frame: HelmxEventFrame, chunk: Uint8Array) => boolean,
    onStop?: () => void,
  ): { unsubscribe(): void; goLive(snapshotSeq: number): boolean } {
    let buffer: Array<{ seq: number; frame: HelmxEventFrame; chunk: Uint8Array }> = []
    let live = false
    let done = false
    const stop = (): void => {
      if (done) return
      done = true
      this.subscribers.delete(push)
      this.streamClosers.delete(stop)
      onStop?.()
    }
    const deliver = (frame: HelmxEventFrame, chunk: Uint8Array): void => {
      let ok = false
      try {
        ok = onFrame(frame, chunk)
      } catch {
        ok = false
      }
      if (!ok) stop()
    }
    const push = (frame: HelmxEventFrame, chunk: Uint8Array): void => {
      if (done) return
      if (!live) {
        if (buffer.length >= MAX_PENDING_EVENTS) {
          // Overflow while buffering during subscription setup (only possible if snapshot provider bursts synchronously): close explicitly.
          stop()
          return
        }
        buffer.push({ seq: frame.seq, frame, chunk })
        return
      }
      deliver(frame, chunk)
    }
    this.subscribers.add(push)
    this.streamClosers.add(stop)
    return {
      unsubscribe: stop,
      goLive(snapshotSeq: number): boolean {
        if (done) return false
        live = true
        for (const item of buffer) {
          if (item.seq <= snapshotSeq) continue
          deliver(item.frame, item.chunk)
          if (done) return false
        }
        buffer = []
        return true
      },
    }
  }

  /** Assemble + validate + redact (delegates to pure helpers in event-validation.ts with instance redactor). */
  private buildEvent(type: string, payload: unknown): HelmxEvent {
    return assembleHelmxEvent(type, payload, (t) => this.redact(t))
  }
}
