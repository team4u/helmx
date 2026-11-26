/**
 * Shared internal SSE stream lifecycle controller and primitives (reused by `EventHub.response`,
 * `SessionDocEventHub.response`, and `SessionDocEventHub.multiplexResponse`).
 *
 * - `encodeSseChunk`: unified encoder along the publish/subscribe path (exact same bytes enter the ring and all subscribers);
 * - `SseStreamController`: single internal SSE lifecycle controller owning byte-bounded backpressure (`hwm=0`,
 *   `desiredSize = -queuedBytes`), optional pull-paced replay flushing (replay entries carry `liveBytes = 0` so ring memory
 *   is not double-counted while mid-flush live frames stay byte-bounded), idle `: keepalive` heartbeat timer (started once
 *   flush drains and routed through the unified byte budget), `Request.signal` abort binding, `ReadableStream.cancel`, and
 *   idempotent shutdown/cleanup.
 */

/** SSE chunk encoder (single instance; publish, ring, replay, and all subscribers share the exact same bytes). */
const SSE_ENCODER = new TextEncoder()

export function encodeSseChunk(name: string, data: unknown): Uint8Array {
  return SSE_ENCODER.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
}

/** Idle keepalive comment line (pre-encoded shared buffer; ignored by SSE parsers and never fabricates business events). */
export const KEEPALIVE_CHUNK: Uint8Array = SSE_ENCODER.encode(': keepalive\n\n')

/** SSE response headers (identical across all SSE event streams). */
const SSE_RESPONSE_HEADERS: Record<string, string> = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
}

/** Flush queue item: either a replay reference (`liveBytes = 0`) or a live frame arriving mid-flush (`liveBytes = byteLength`). */
interface OutboundEntry {
  chunk: Uint8Array
  liveBytes: number
}

export interface SseStreamControllerOptions {
  /**
   * Originating HTTP Request (retained until `close()`): in Node/undici, `request.signal` is linked to
   * its upstream `AbortSignal` through the `Request` wrapper, so holding only `request.signal` allows GC
   * of a temporary `Request` to sever upstream abort propagation.
   */
  readonly request: Request
  readonly maxPendingBytes: number
  readonly keepaliveMs: number
  /** Cleanup callback invoked at most once on stream shutdown (before closing the ReadableStream controller). */
  readonly onClose: () => void
}

/**
 * Unified internal SSE stream lifecycle controller shared across global `/api/events` and dedicated/multiplexed
 * session-doc SSE streams.
 */
export class SseStreamController {
  private request: Request | undefined
  private readonly signal: AbortSignal
  private readonly maxPendingBytes: number
  private readonly keepaliveMs: number
  private readonly onClose: () => void
  private readonly onAbort = (): void => {
    this.close()
  }

  private isClosed = false
  private isFlushing = false
  private outbound: OutboundEntry[] = []
  private outboundHead = 0
  private outboundLiveBytes = 0
  private controller: ReadableStreamDefaultController<Uint8Array> | undefined
  private keepaliveTimer: ReturnType<typeof setInterval> | undefined

  constructor(options: SseStreamControllerOptions) {
    this.request = options.request
    this.signal = options.request.signal
    this.maxPendingBytes = options.maxPendingBytes
    this.keepaliveMs = options.keepaliveMs
    this.onClose = options.onClose
  }

  get closed(): boolean {
    return this.isClosed
  }

  get flushing(): boolean {
    return this.isFlushing
  }

  /**
   * Byte-bounded direct write onto the underlying ReadableStream controller:
   * returns `false` when closed/unattached, when `queuedBytes + chunk.byteLength > maxPendingBytes`
   * (under `hwm=0`, `desiredSize === -queuedBytes`), or when `enqueue` throws.
   */
  write(chunk: Uint8Array): boolean {
    const controller = this.controller
    if (controller === undefined || this.isClosed) return false
    const queuedBytes = controller.desiredSize === null ? 0 : -controller.desiredSize
    if (queuedBytes + chunk.byteLength > this.maxPendingBytes) return false
    try {
      controller.enqueue(chunk)
      return true
    } catch {
      return false
    }
  }

  /**
   * Deliver a live chunk: tails onto the pull-paced flush queue while replaying (charging `maxPendingBytes`),
   * otherwise writes directly with byte backpressure. Returns `false` on closed stream or slow-consumer overflow.
   */
  send(chunk: Uint8Array): boolean {
    if (this.isClosed) return false
    if (this.isFlushing) {
      if (this.outboundLiveBytes + chunk.byteLength > this.maxPendingBytes) return false
      this.outboundLiveBytes += chunk.byteLength
      this.outbound.push({ chunk, liveBytes: chunk.byteLength })
      return true
    }
    return this.write(chunk)
  }

  /** Stage ring-replay chunks (`liveBytes = 0`) for pull-paced draining at consumer speed. */
  beginReplayFlush(replayChunks: ReadonlyArray<Uint8Array>): void {
    if (this.isClosed || replayChunks.length === 0) return
    this.outbound = replayChunks.map((chunk) => ({ chunk, liveBytes: 0 }))
    this.outboundHead = 0
    this.outboundLiveBytes = 0
    this.isFlushing = true
  }

  /** Start the idle `: keepalive` comment timer (idempotent; no-op when closed or `keepaliveMs <= 0`). */
  startKeepalive(): void {
    if (this.keepaliveTimer !== undefined || this.isClosed || this.keepaliveMs <= 0) return
    this.keepaliveTimer = setInterval(() => {
      if (!this.write(KEEPALIVE_CHUNK)) this.close()
    }, this.keepaliveMs)
    this.keepaliveTimer.unref?.()
  }

  /** Idempotently stop keepalive timer, detach abort listener, invoke `onClose`, and close the stream controller. */
  close(): void {
    if (this.isClosed) return
    this.isClosed = true
    this.isFlushing = false
    this.outbound = []
    this.outboundHead = 0
    this.outboundLiveBytes = 0
    if (this.keepaliveTimer !== undefined) {
      clearInterval(this.keepaliveTimer)
      this.keepaliveTimer = undefined
    }
    this.signal.removeEventListener('abort', this.onAbort)
    this.request = undefined
    try {
      this.onClose()
    } finally {
      const controller = this.controller
      this.controller = undefined
      closeControllerQuietly(controller)
    }
  }

  /** Build the SSE `Response` (`hwm=0` + `byteLength` sizing + standard SSE headers). */
  toResponse(onStart: () => void): Response {
    const stream = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          this.controller = controller as ReadableStreamDefaultController<Uint8Array>
          if (this.isClosed) {
            closeControllerQuietly(this.controller)
            this.controller = undefined
            return
          }
          if (this.signal.aborted) {
            this.close()
            return
          }
          this.signal.addEventListener('abort', this.onAbort)
          onStart()
        },
        pull: () => {
          if (this.isClosed || !this.isFlushing) return
          if (this.outboundHead >= this.outbound.length) return
          const entry = this.outbound[this.outboundHead]!
          // Drop reference immediately while advancing head index (O(1) dequeue).
          this.outbound[this.outboundHead] = undefined as never
          this.outboundHead += 1
          this.outboundLiveBytes -= entry.liveBytes
          const controller = this.controller
          if (controller === undefined) return
          // pull semantics: consumer already has a pending read, so enqueue satisfies it immediately without unread backlog.
          try {
            controller.enqueue(entry.chunk)
          } catch {
            this.close()
            return
          }
          if (this.outboundHead >= this.outbound.length) {
            this.outbound = []
            this.outboundHead = 0
            this.isFlushing = false
            this.startKeepalive()
          }
        },
        cancel: () => {
          this.close()
        },
      },
      { highWaterMark: 0, size: (c) => c.byteLength } satisfies QueuingStrategy<Uint8Array>,
    )
    return new Response(stream, { headers: SSE_RESPONSE_HEADERS })
  }
}

/** Idempotently close a stream controller (closing an already-closed controller does not throw). */
function closeControllerQuietly(controller: ReadableStreamDefaultController<Uint8Array> | undefined): void {
  try {
    controller?.close()
  } catch {
    // Already closed: idempotent.
  }
}
