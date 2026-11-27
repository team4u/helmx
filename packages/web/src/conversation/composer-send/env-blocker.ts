/**
 * Environment block of the send pipeline: SessionEnvBar reports an unsaved / saving starting
 * environment here; the send-time gate reads the ref (never a stale render snapshot).
 */
import { useEffect } from 'react'
import { ENV_BLOCKER_CLEAR, type SessionEnvBlocker } from '../composer-model.js'
import { useStableCallback } from '../../lib/use-stable-callback.js'
import type { ComposerSendCore } from './core.js'

export interface ComposerEnvBlocker {
  readonly envBlocker: SessionEnvBlocker
  /** SessionEnvBar block report (stable identity, for its blocker effect deps). */
  readonly handleEnvBlocker: (blocker: SessionEnvBlocker) => void
}

export function useComposerEnvBlocker(core: ComposerSendCore, envConfigurable: boolean): ComposerEnvBlocker {
  const { envBlockedRef, setEnvBlocker, envBlocker } = core

  const handleEnvBlocker = (blocker: SessionEnvBlocker): void => {
    envBlockedRef.current = blocker.blocked
    setEnvBlocker(blocker)
  }
  // SessionEnvBar's blocker effect depends on this callback's identity: a
  // plain function would re-run it every render (looping while blocked).
  const handleEnvBlockerStable = useStableCallback(handleEnvBlocker)
  // Reset the block when the env bar unmounts (locked by the chat starting /
  // status change), so a leftover never blocks later sends.
  useEffect(() => {
    if (envConfigurable) return
    envBlockedRef.current = false
    setEnvBlocker(ENV_BLOCKER_CLEAR)
  }, [envConfigurable])

  return { envBlocker, handleEnvBlocker: handleEnvBlockerStable }
}
