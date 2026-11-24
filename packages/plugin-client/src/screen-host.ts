/**
 * Host-provided screen shell context (types + context only, Fast Refresh friendly).
 *
 * Provided solely by the host ScreenHost around mounted full-screen plugin views
 * so `<Screen>` knows a top bar (`.pane-topbar`) is already rendered by the host
 * and omits its duplicate `.screen-title` (and collapses `.screen-header` when no
 * subtitle or actions remain) structurally rather than via CSS `:has()` hiding.
 */
import { createContext, useContext } from 'react'

export interface ScreenHostState {
  readonly hosted: boolean
}

const DEFAULT_SCREEN_HOST_STATE: ScreenHostState = Object.freeze({ hosted: false })

/** Provided by the host ScreenHost only (never part of plugin-facing PLUGIN_CLIENT_SHARED_EXPORTS). */
export const ScreenHostContext = createContext<ScreenHostState>(DEFAULT_SCREEN_HOST_STATE)

/** Read whether the current subtree is hosted inside the host ScreenHost shell. */
export function useScreenHost(): ScreenHostState {
  return useContext(ScreenHostContext)
}
