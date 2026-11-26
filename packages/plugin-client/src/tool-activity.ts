import { createContext, useContext, useEffect } from 'react'

export interface ToolActivityRegistry {
  activeToolCallIds: ReadonlySet<string>
  /** Each mounted source gets an independent registration; the returned value only releases this source, not other sources of the same callId. */
  registerActivity(callId: string): () => void
}

export const ToolActivityContext = createContext<ToolActivityRegistry | undefined>(undefined)

/**
 * Reports real background tool activity to the containing timeline turn.
 * While the turn still has registered activity, the host withholds only the
 * history-rewriting "regenerate" affordance of that turn; copy and fork stay
 * available because they are read-only. When callId is missing, or the
 * component is not inside the timeline Provider, nothing is registered
 * and no global state is created. Changes of state or callId and unmounting
 * release this source automatically; components inside the workbench do not
 * affect the timeline.
 */
export function useToolActivity(callId: string | undefined, active: boolean): void {
  const register = useContext(ToolActivityContext)?.registerActivity
  useEffect(() => {
    if (register === undefined || callId === undefined || callId === '' || !active) return
    return register(callId)
  }, [register, callId, active])
}
