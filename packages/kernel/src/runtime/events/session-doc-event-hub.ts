/** `SessionDocEventHub`: per-`(pluginId, name, conversationId)` conversation document streams (see class doc below). */
import { encodeSessionDocSubParam, HelmxError } from '@helmx/protocol'
import type {
  HelmxEventFrame,
  PublicPluginSessionDoc,
  SessionDocMultiplexAction,
  SessionDocMultiplexFrame,
  SessionDocSubscription,
} from '@helmx/protocol'
import { redactJsonValue } from '../../redact.js'
import { assertSessionDocUpdateShape } from '../event-validation.js'
import { encodeSseChunk, SseStreamController } from '../sse-stream.js'
import { DEFAULT_KEEPALIVE_MS, DEFAULT_MAX_PENDING_BYTES, MAX_PENDING_EVENTS } from './constants.js'

/** Initial frame for a session-doc subscription: {seq, doc}; read atomically via synchronous HTTP provider. */
interface SessionDocSnapshot {
  seq: number
  doc: PublicPluginSessionDoc
}

interface SessionDocStreamEntry {
  targets: ReadonlyArray<{ pluginId: string; name: string; conversationId: number }>
  stop: () => void
}

/** Pending frame buffered during snapshot collection (retains seq so flush emits only frames with seq > snapshot.seq). */
interface SessionDocQueuedFrame {
  seq: number
  chunk: Uint8Array
}

interface SessionDocMultiplexQueuedFrame {
  key: string
  seq: number
  chunk: Uint8Array
}

/**
 * SessionDocEventHub: dedicated event stream for conversation documents.
 *
 * plugin.session_doc.updated never enters global /api/events (prevents write amplification and cross-conversation leaks);
 * this hub dispatches updates for a (pluginId, name, conversationId) tuple exclusively to streams subscribed to that tuple.
 * Frame shape matches the global stream (HelmxEventFrame {seq, event}), while seq uses its own monotonic counter;
 * the initial snapshot frame is fetched via response's synchronous provider (e.g., kernel.plugins.getPublicSessionDoc) right after
 * subscribing, guaranteeing an atomic window without dropped or duplicated frames between snapshot and first delta.
 *
 * Lifecycle: response registers each stream as (targets, stop); hub.close() shuts down all streams (closing ReadableStream
 * and unsubscribing); closeForPlugin / closeForConversation are driven by runtime listeners on core events
 * (plugin.changed enabled=false / conversation.deleted), purely event-driven with zero polling overhead.
 */
export class SessionDocEventHub {
  private seqValue = 0
  private readonly subscribers = new Map<string, Set<(frame: HelmxEventFrame, getSingleChunk: () => Uint8Array) => void>>()
  /** Close handles for each dedicated stream (used by close()/set-close; multiple connections to the same tuple register independently). */
  private readonly streams = new Set<SessionDocStreamEntry>()
  /** Max pending frames buffered between subscription setup and snapshot flush (overflow closes stream to reconnect). */
  private readonly maxPending = MAX_PENDING_EVENTS
  /** Unread byte cap during streaming (default 1 MiB; slow clients are closed explicitly rather than queued unboundedly). */
  private readonly maxPendingBytes: number
  /** SSE idle heartbeat interval (ms); defaults to 15s, <= 0 disables (for deterministic tests). */
  private readonly keepaliveMs: number
  private redactFn: (text: string) => string = (t) => t

  constructor(options: { maxPendingBytes?: number; keepaliveMs?: number } = {}) {
    this.maxPendingBytes = options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES
    this.keepaliveMs = options.keepaliveMs ?? DEFAULT_KEEPALIVE_MS
  }

  set redact(fn: (text: string) => string) {
    this.redactFn = fn
  }

  get seq(): number {
    return this.seqValue
  }

  private static keyOf(doc: { pluginId: string; name: string; conversationId: number }): string {
    return `${doc.pluginId}\0${doc.name}\0${doc.conversationId}`
  }

  /** Number of currently active subscribers (actual listener count, for diagnostics and tests). */
  get subscriberCount(): number {
    let total = 0
    for (const set of this.subscribers.values()) total += set.size
    return total
  }

  /** Truly close all dedicated streams and clear subscribers (called on kernel.close to eliminate leaks). */
  close(): void {
    this.closeStreams(() => true)
    this.subscribers.clear()
  }

  /** Close all dedicated streams for a plugin (plugin disable/uninstall: plugin.changed enabled=false). */
  closeForPlugin(pluginId: string): void {
    this.closeStreams((entry) => entry.targets.some((t) => t.pluginId === pluginId))
  }

  /** Close all dedicated streams for a conversation (conversation deleted: conversation.deleted). */
  closeForConversation(conversationId: number): void {
    this.closeStreams((entry) => entry.targets.some((t) => t.conversationId === conversationId))
  }

  private closeStreams(match: (entry: SessionDocStreamEntry) => boolean): void {
    for (const entry of [...this.streams]) {
      if (match(entry)) entry.stop()
    }
  }

  /**
   * Publish a session document update: dispatches only to listeners subscribed to that tuple.
   * Validates shape (pure helper in event-validation.ts) + applies JSON redaction at boundary (same discipline as
   * EventHub.buildEvent); invalid payloads throw HelmxError explicitly without advancing seq or falling back silently.
   */
  dispatch(payload: unknown): void {
    const clean = redactJsonValue(assertSessionDocUpdateShape(payload), (t) => this.redactFn(t)) as PublicPluginSessionDoc
    this.seqValue += 1
    const key = SessionDocEventHub.keyOf(clean)
    const subs = this.subscribers.get(key)
    if (subs === undefined || subs.size === 0) return
    const frame: HelmxEventFrame = {
      seq: this.seqValue,
      event: { type: 'plugin.session_doc.updated', doc: clean },
    }
    let cachedChunk: Uint8Array | undefined
    const getSingleChunk = (): Uint8Array => {
      cachedChunk ??= encodeSseChunk('plugin.session_doc.updated', frame)
      return cachedChunk
    }
    for (const deliver of [...subs]) {
      try {
        deliver(frame, getSingleChunk)
      } catch {
        // Isolate subscriber callback throws without affecting other subscribers.
      }
    }
  }

  private subscribeWithChunk(
    doc: { pluginId: string; name: string; conversationId: number },
    listener: (frame: HelmxEventFrame, getSingleChunk: () => Uint8Array) => void,
  ): () => void {
    const key = SessionDocEventHub.keyOf(doc)
    let set = this.subscribers.get(key)
    if (set === undefined) {
      set = new Set()
      this.subscribers.set(key, set)
    }
    set.add(listener)
    return () => {
      const cur = this.subscribers.get(key)
      if (cur === undefined) return
      cur.delete(listener)
      if (cur.size === 0) this.subscribers.delete(key)
    }
  }

  /**
   * Subscribe to incremental frames for a specific tuple; returns an unsubscribe function.
   * Matches EventHub.subscribe semantics: HTTP layer subscribes+buffers first, then captures a synchronous snapshot.
   */
  subscribe(
    doc: { pluginId: string; name: string; conversationId: number },
    listener: (frame: HelmxEventFrame) => void,
  ): () => void {
    return this.subscribeWithChunk(doc, (frame) => listener(frame))
  }

  /**
   * Dedicated SSE response: initial `event: snapshot` (PluginSessionDocSnapshot {seq, doc}),
   * followed by incremental `event: plugin.session_doc.updated` + HelmxEventFrame.
   *
   * Atomic window: registers buffered subscription first, then invokes synchronous options.snapshot provider
   * (provider also checks plugin/conversation existence; failures throw synchronously to HTTP), emits snapshot,
   * and flushes only buffered frames with seq > snapshot.seq—zero dropped or duplicated frames.
   * If provider fails or request is already aborted, unsubscribes synchronously without creating a stream.
   *
   * Backpressure & cleanup: buffered phase is bounded by MAX_PENDING_EVENTS, streaming phase by byte cap
   * (shared sse-stream primitive); overflowing closes the stream explicitly and unsubscribes (no unbounded queuing);
   * abort / cancel / hub close also shut down the stream cleanly. Reconnecting re-subscribes and resets snapshot (no cross-connection state).
   */
  response(
    request: Request,
    options: {
      /** Synchronous snapshot provider invoked after subscribing; returns {seq, doc} or throws synchronously. */
      snapshot: () => SessionDocSnapshot
      target: { pluginId: string; name: string; conversationId: number }
    },
  ): Response {
    /** Buffered frames arriving before snapshot flush completes (switches to byte backpressure afterward). */
    let pending: SessionDocQueuedFrame[] = []
    let streaming = false
    let unsubscribe: (() => void) | undefined
    /** Stream handle registered on shutdown; undefined during provider phase (delete is idempotent). */
    let streamEntry: SessionDocStreamEntry | undefined

    const stream = new SseStreamController({
      request,
      maxPendingBytes: this.maxPendingBytes,
      keepaliveMs: this.keepaliveMs,
      onClose: () => {
        unsubscribe?.()
        unsubscribe = undefined
        if (streamEntry !== undefined) this.streams.delete(streamEntry)
        pending = []
      },
    })

    // Subscribe+buffer first (same sync window as snapshot read so no frames are lost; buffered frames keep seq for deduplication).
    unsubscribe = this.subscribeWithChunk(options.target, (frame, getSingleChunk) => {
      if (stream.closed) return
      const chunk = getSingleChunk()
      if (streaming) {
        if (!stream.write(chunk)) stream.close()
        return
      }
      if (pending.length >= this.maxPending) {
        // Backlog exceeded before snapshot flushed (only possible on synchronous burst in provider): close stream explicitly.
        stream.close()
        return
      }
      pending.push({ seq: frame.seq, chunk })
    })

    // Synchronous snapshot fetch (if provider fails or request aborted: unsubscribe synchronously without creating a stream or faking a snapshot).
    let snap: SessionDocSnapshot
    try {
      if (request.signal.aborted) throw new HelmxError('aborted', 'request aborted before subscription was established', 499)
      snap = options.snapshot()
    } catch (error) {
      stream.close()
      throw error
    }
    const snapshotChunk = encodeSseChunk('snapshot', snap)
    streamEntry = { targets: [options.target], stop: () => stream.close() }
    if (!stream.closed) this.streams.add(streamEntry)

    return stream.toResponse(() => {
      // Buffered subscription and snapshot are ready: emit snapshot first, then flush newer buffered frames
      // (frames with seq <= snapshot.seq are already reflected in the snapshot and skipped to avoid duplicates).
      if (!stream.write(snapshotChunk)) {
        stream.close()
        return
      }
      streaming = true
      for (const frame of pending) {
        if (frame.seq <= snap.seq) continue
        if (!stream.write(frame.chunk)) {
          stream.close()
          return
        }
      }
      pending = []
      stream.startKeepalive()
    })
  }

  /**
   * Multiplexed SessionDoc SSE response: subscribes to a validated non-empty list
   * of `(pluginId, name, conversationId)` tuples over one SSE connection.
   *
   * - Subscribes to all targets first so concurrent dispatches during snapshot
   *   collection are buffered and deduplicated per tuple via `seq <= snapshot.seq`.
   * - Validates every tuple via `options.snapshot(sub)` before opening the stream
   *   (failing fast with `shutdown()` + rethrow when any target is disabled/unregistered/missing).
   * - Emits initial `SessionDocMultiplexFrame` (`action: 'snapshot'`) per target,
   *   followed by `'updated'` or `'deleted'` frames only for subscribed tuples,
   *   plus periodic `: keepalive` heartbeats (`keepaliveMs`, default 15s).
   */
  multiplexResponse(
    subs: readonly SessionDocSubscription[],
    request: Request,
    options: {
      snapshot: (sub: SessionDocSubscription) => SessionDocSnapshot
    },
  ): Response {
    if (!Array.isArray(subs) || subs.length === 0) {
      throw new HelmxError('validation_error', 'session doc multiplex subscription requires at least one target', 400)
    }
    const seen = new Set<string>()
    const targets: SessionDocSubscription[] = []
    for (const sub of subs) {
      const canonical = encodeSessionDocSubParam(sub)
      if (seen.has(canonical)) {
        throw new HelmxError('validation_error', `duplicate session doc subscription: ${canonical}`, 400)
      }
      seen.add(canonical)
      targets.push({ pluginId: sub.pluginId, name: sub.name, conversationId: sub.conversationId })
    }

    let pending: SessionDocMultiplexQueuedFrame[] = []
    let streaming = false
    const unsubscribes: Array<() => void> = []
    let streamEntry: SessionDocStreamEntry | undefined

    const stream = new SseStreamController({
      request,
      maxPendingBytes: this.maxPendingBytes,
      keepaliveMs: this.keepaliveMs,
      onClose: () => {
        while (unsubscribes.length > 0) {
          const unsub = unsubscribes.pop()
          unsub?.()
        }
        if (streamEntry !== undefined) this.streams.delete(streamEntry)
        pending = []
      },
    })

    for (const target of targets) {
      const key = SessionDocEventHub.keyOf(target)
      const unsub = this.subscribe(target, (frame) => {
        if (stream.closed) return
        const doc = (frame.event as { doc: PublicPluginSessionDoc }).doc
        const action: SessionDocMultiplexAction = doc.deleted === true ? 'deleted' : 'updated'
        const multiplexFrame: SessionDocMultiplexFrame = {
          action,
          pluginId: target.pluginId,
          name: target.name,
          conversationId: target.conversationId,
          seq: frame.seq,
          doc,
        }
        const chunk = encodeSseChunk('session_doc', multiplexFrame)
        if (streaming) {
          if (!stream.write(chunk)) stream.close()
          return
        }
        if (pending.length >= this.maxPending) {
          stream.close()
          return
        }
        pending.push({ key, seq: frame.seq, chunk })
      })
      unsubscribes.push(unsub)
    }

    const snapshotSeqs = new Map<string, number>()
    const snapshotChunks: Uint8Array[] = []
    try {
      if (request.signal.aborted) {
        throw new HelmxError('aborted', 'request aborted before subscription was established', 499)
      }
      for (const target of targets) {
        const key = SessionDocEventHub.keyOf(target)
        const snap = options.snapshot(target)
        snapshotSeqs.set(key, snap.seq)
        const multiplexFrame: SessionDocMultiplexFrame = {
          action: 'snapshot',
          pluginId: target.pluginId,
          name: target.name,
          conversationId: target.conversationId,
          seq: snap.seq,
          doc: snap.doc,
        }
        snapshotChunks.push(encodeSseChunk('session_doc', multiplexFrame))
      }
    } catch (error) {
      stream.close()
      throw error
    }

    streamEntry = { targets, stop: () => stream.close() }
    if (!stream.closed) this.streams.add(streamEntry)

    return stream.toResponse(() => {
      for (const chunk of snapshotChunks) {
        if (!stream.write(chunk)) {
          stream.close()
          return
        }
      }
      streaming = true
      for (const item of pending) {
        const snapSeq = snapshotSeqs.get(item.key) ?? -1
        if (item.seq <= snapSeq) continue
        if (!stream.write(item.chunk)) {
          stream.close()
          return
        }
      }
      pending = []
      stream.startKeepalive()
    })
  }
}
