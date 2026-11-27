/**
 * Radix-free pure sub-entry of `@helmx/ui`.
 *
 * Pure model modules (e.g. timing/status models imported in test helpers before
 * happy-dom registration) consume this sub-entry without evaluating React DOM
 * or the Radix dependency graph.
 */
export {
  STATUS_LIGHT_TONES,
  normalizeStatusLightTone,
  isKnownStatusLightStatus,
} from './primitives/status-light-model.js'
export type { StatusLightTone } from './primitives/status-light-model.js'
export {
  formatDurationMs,
  formatStopwatchMs,
  formatOffsetMs,
  resolveConversationTiming,
} from './format.js'
export type { ConversationTimingInput, ConversationTimingSnapshot } from './format.js'
