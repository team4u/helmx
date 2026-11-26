/**
 * Standby textarea focus discipline:
 * - explicit New Topic focus requests commit synchronously inside the tap / keydown gesture
 *   so mobile browsers open the soft keyboard; a request that can never be served (profile
 *   not human-selectable once assets loaded) is cleared instead of lingering;
 * - implicit auto-focus waits for the next animation frame, only when this pane is the
 *   focused panel and no overlay (modal, drawer stack, open dialog) owns focus, and never
 *   while a send is in flight. Each standby identity auto-focuses once.
 */
import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { useActiveModal, useDrawerStack, useLocationTargets } from '../../lib/store-context.js'
import { useFocusComposerShortcut } from '../composer-controller.js'
import { useIsMobile } from '../composer-model.js'
import {
  clearStandbyFocusRequest,
  getStandbyFocusRequest,
  shouldAutoFocusStandbyTextarea,
  useStandbyFocusRequest,
  type StandbyFocusRequest,
} from '../standby-model.js'
import { useIsomorphicLayoutEffect } from './use-isomorphic-layout-effect.js'

export interface StandbyFocusInput {
  panel: 'primary' | 'split'
  profileId: string
  /** Stable identity of this standby surface (panel + draft key): auto-focus once per identity. */
  standbyIdentity: string
  standbyReady: boolean
  assetsLoaded: boolean
  humanSelectable: boolean
  sending: boolean
  textareaRef: RefObject<HTMLTextAreaElement | null>
  paneRef: RefObject<HTMLDivElement | null>
}

export function useStandbyFocus(input: StandbyFocusInput): void {
  const { panel, profileId, standbyIdentity, standbyReady, assetsLoaded, humanSelectable, sending, textareaRef, paneRef } = input
  const { focusedPanel, splitTarget } = useLocationTargets()
  const activeModal = useActiveModal()
  const drawerStack = useDrawerStack()
  const isMobile = useIsMobile(680)

  useFocusComposerShortcut({ textareaRef, panel })

  const autoFocusedKeyRef = useRef<string | null>(null)
  const focusRequest = useStandbyFocusRequest()
  const matchingFocusRequest =
    focusRequest !== null && focusRequest.panel === panel && focusRequest.profileId === profileId
      ? focusRequest
      : null
  const matchingFocusSeq = matchingFocusRequest?.seq ?? null
  const consumedFocusSeqRef = useRef<number | null>(null)

  const autoFocusContextRef = useRef({
    panel,
    focusedPanel,
    splitTarget,
    activeModal,
    drawerStackLength: drawerStack.length,
    isMobile,
    sending,
  })
  autoFocusContextRef.current = {
    panel,
    focusedPanel,
    splitTarget,
    activeModal,
    drawerStackLength: drawerStack.length,
    isMobile,
    sending,
  }

  const tryFocusTextarea = useCallback(
    (explicitReq: StandbyFocusRequest | null): boolean => {
      const el = textareaRef.current
      if (el === null || !el.isConnected) return false
      const ctx = autoFocusContextRef.current
      if (ctx.sending) return false
      const isExplicit = explicitReq !== null && explicitReq.explicit
      if (
        !shouldAutoFocusStandbyTextarea({
          panel: ctx.panel,
          focusedPanel: ctx.focusedPanel,
          splitTarget: ctx.splitTarget,
          activeModal: ctx.activeModal,
          drawerStackLength: ctx.drawerStackLength,
          isMobile: ctx.isMobile,
          explicitFocus: isExplicit,
          textarea: el,
          paneEl: paneRef.current,
        })
      ) {
        return false
      }
      el.focus({ preventScroll: true })
      const focused = typeof document === 'undefined' || document.activeElement === el
      if (!focused) return false
      autoFocusedKeyRef.current = standbyIdentity
      if (explicitReq !== null) {
        consumedFocusSeqRef.current = explicitReq.seq
        clearStandbyFocusRequest(explicitReq.seq)
      }
      return true
    },
    [standbyIdentity],
  )

  // Synchronously commit explicit New Topic focus inside the tap/keydown gesture so mobile browsers open the soft keyboard.
  useIsomorphicLayoutEffect(() => {
    if (matchingFocusRequest === null || matchingFocusRequest.seq === consumedFocusSeqRef.current) return
    if (!standbyReady) {
      if (assetsLoaded && !humanSelectable) {
        clearStandbyFocusRequest(matchingFocusRequest.seq)
      }
      return
    }
    tryFocusTextarea(matchingFocusRequest)
  }, [
    standbyIdentity,
    standbyReady,
    assetsLoaded,
    humanSelectable,
    activeModal,
    drawerStack.length,
    matchingFocusSeq,
    tryFocusTextarea,
  ])

  useEffect(() => {
    if (!standbyReady) return
    const pendingReq =
      matchingFocusRequest !== null && matchingFocusRequest.seq !== consumedFocusSeqRef.current
        ? matchingFocusRequest
        : null
    if (pendingReq === null && autoFocusedKeyRef.current === standbyIdentity) return
    const focusFromEffect = (): void => {
      const rawLive = getStandbyFocusRequest()
      const liveReq =
        rawLive !== null &&
        rawLive.panel === panel &&
        rawLive.profileId === profileId &&
        rawLive.seq !== consumedFocusSeqRef.current
          ? rawLive
          : null
      if (liveReq === null && autoFocusedKeyRef.current === standbyIdentity) return
      tryFocusTextarea(liveReq)
    }
    if (typeof requestAnimationFrame !== 'function') {
      focusFromEffect()
      return
    }
    const rafId = requestAnimationFrame(focusFromEffect)
    return () => cancelAnimationFrame(rafId)
  }, [
    standbyIdentity,
    standbyReady,
    activeModal,
    drawerStack.length,
    matchingFocusSeq,
    panel,
    profileId,
    tryFocusTextarea,
  ])
}
