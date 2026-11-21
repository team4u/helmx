/**
 * Screen params host bridge (types + context only, Fast Refresh friendly):
 * the host ScreenHost establishes the URL-hash-backed params scope around the
 * mounted full-screen plugin view; useScreenParams() lets nested components
 * read params / setParams without prop drilling while the screen root keeps
 * receiving the protocol ScreenProps. Returns null outside a full-screen
 * screen (e.g. a component reused inside settings.panel) — honest absence,
 * never a fabricated no-op scope.
 */
import { createContext, useContext } from 'react'
import type { ScreenParamsScope } from '@helmx/protocol/browser'

/** Provided by the host ScreenHost only (never by plugin code). */
export const ScreenParamsContext = createContext<ScreenParamsScope | null>(null)

/**
 * Params scope of the full-screen pane this component tree is mounted in
 * (main / split each bound to their own sp.* / ssp.* target; setParams is the
 * same implementation ScreenProps carries — the URL hash stays the single
 * source of truth). null when not inside a host-rendered full-screen screen.
 */
export function useScreenParams(): ScreenParamsScope | null {
  return useContext(ScreenParamsContext)
}
