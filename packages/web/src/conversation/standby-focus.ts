/**
 * Synchronously commit explicit New Topic navigation and carry a focus ticket
 * into `AgentStandbyPane`'s layout effect while the native click/keydown user
 * gesture is still active (required by mobile browsers to focus & raise IME).
 *
 * Callers running inside Radix `DropdownMenuItem` `onSelect` MUST pass
 * `{ flush: false }` because Radix already wraps `ITEM_SELECT` inside
 * `ReactDOM.flushSync` via `dispatchDiscreteCustomEvent`.
 */
import { flushSync } from 'react-dom'
import { requestStandbyFocus } from './standby-model.js'

export interface OpenStandbyFocusTarget {
  panel: 'primary' | 'split'
  profileId: string
}

export interface OpenStandbyFocusOptions {
  /** Wrap navigation in `ReactDOM.flushSync` (default true). Pass false inside Radix `onSelect`. */
  flush?: boolean
}

/** Issue an explicit standby focus request and commit navigation so `.focus()` lands within the user gesture. */
export function openStandbyWithFocus(
  target: OpenStandbyFocusTarget,
  navigate: () => void,
  opts?: OpenStandbyFocusOptions,
): void {
  requestStandbyFocus({
    panel: target.panel,
    profileId: target.profileId,
    explicit: true,
  })
  if (opts?.flush === false || typeof document === 'undefined') {
    navigate()
    return
  }
  flushSync(navigate)
}
