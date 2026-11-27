/** Backpressure and heartbeat defaults shared by `EventHub` and `SessionDocEventHub` (both stream through `../sse-stream.js`). */

/** Max pending frames buffered between subscription setup and snapshot flush (overflow flags slow client and closes stream to reconnect). */
export const MAX_PENDING_EVENTS = 512

/** Max unread bytes during streaming phase (default 1 MiB, overridable via maxPendingBytes, e.g. small values in tests). */
export const DEFAULT_MAX_PENDING_BYTES = 1024 * 1024

/** SSE idle heartbeat interval (default 15s; comment lines go through unified byte backpressure; overridable via keepaliveMs in tests). */
export const DEFAULT_KEEPALIVE_MS = 15_000
