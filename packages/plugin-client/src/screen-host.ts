/**
 * Host-provided screen shell context (types + context only, Fast Refresh friendly).
 *
 * Provided solely by the host ScreenHost around mounted full-screen plugin views
 * so `<Screen>` knows a top bar (`.pane-topbar`) is already rendered by the host
 * and omits its duplicate `.screen-title` (and collapses `.screen-header` when no
 * subtitle or actions remain) structurally rather than via CSS `:has()` hiding.
 * The host may additionally expose its top bar `.pane-actions` DOM slot so a
 * hosted `<Screen actions>` cluster lands in the top bar next to the host split
 * controls (same place the Web centers put their header actions) instead of an
 * extra row below it.
 */
import { createContext, useContext } from 'react'

export interface ScreenHostState {
  readonly hosted: boolean
  /**
   * DOM node of the host top bar actions slot. A hosted `<Screen actions>` portals
   * its action cluster here (the React tree stays inside the plugin, so plugin
   * context and scoped CSS keep working). `undefined`/`null` → inline header.
   */
  readonly headerActionsSlot?: HTMLElement | null
}

const DEFAULT_SCREEN_HOST_STATE: ScreenHostState = Object.freeze({ hosted: false })

/** Provided by the host ScreenHost only (never part of plugin-facing PLUGIN_CLIENT_SHARED_EXPORTS). */
export const ScreenHostContext = createContext<ScreenHostState>(DEFAULT_SCREEN_HOST_STATE)

/** Read the host screen shell state (hosted flag + optional top bar actions slot). */
export function useScreenHost(): ScreenHostState {
  return useContext(ScreenHostContext)
}
