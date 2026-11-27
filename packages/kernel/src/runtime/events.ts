/**
 * Facade for the kernel event hubs (implementation split under `./events/`):
 * `EventHub` (global persisted-seq bus + SSE) and `SessionDocEventHub` (per-tuple conversation doc streams).
 * Kept as the stable import path for the runtime, HTTP routes, and tests; exports are unchanged.
 */
export { EventHub, type HostDispatchedEvent, type SseFrame, type SnapshotProvider } from './events/event-hub.js'
export { SessionDocEventHub } from './events/session-doc-event-hub.js'
