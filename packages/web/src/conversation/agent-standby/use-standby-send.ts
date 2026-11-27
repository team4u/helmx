/**
 * Send path of the standby pane: the real first send (create → upload → submit → navigate,
 * owned by `executeStandbySend`) and the submit decision in front of it — an exact plugin
 * slash-command hit executes, a session management command answers with a notice, anything
 * else sends. The "still viewing" guard (committed in the layout phase) lets a send that
 * completes after the user navigated away notify in the background instead of pulling them
 * back.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from 'react'
import type { WebMessageTranslator } from '../../i18n/catalog.js'
import { conversationsApi } from '../../lib/api.js'
import { matchExactPluginSlash, type QualifiedCommand } from '../../lib/commands-model.js'
import { errorText } from '../../lib/error-text.js'
import { useLocationTargets, useStoreActions } from '../../lib/store-context.js'
import type { HelmxStoreActions } from '../../lib/store/types.js'
import { isSameResolvedTarget, type ResolvedTarget } from '../../lib/types.js'
import {
  executeStandbySend,
  getStandbyDraft,
  standbyManageAction,
  updateStandbyDraft,
  type StandbySendResult,
} from '../standby-model.js'

export interface StandbySendActions {
  /** Submit decision: plugin command → execute; management command → notice; else real send. */
  readonly submitDraft: () => void
}

export function useStandbySend(input: {
  draftKey: string
  profileId: string
  inheritedNodeId: string | undefined
  inheritedCwd: string | undefined
  isSplit?: boolean
  commandPendingRef: RefObject<boolean>
  executeStandbyPluginCommand: (cmd: QualifiedCommand, mode: 'token' | 'clear') => void
  slashPluginCommands: ReadonlyArray<QualifiedCommand>
  pushNotice: HelmxStoreActions['pushNotice']
  t: WebMessageTranslator
}): StandbySendActions {
  const {
    draftKey,
    profileId,
    inheritedNodeId,
    inheritedCwd,
    isSplit,
    commandPendingRef,
    executeStandbyPluginCommand,
    slashPluginCommands,
    pushNotice,
    t,
  } = input
  const { openTarget } = useStoreActions()
  const { primaryTarget, splitTarget } = useLocationTargets()

  const coordinateTarget = useMemo<ResolvedTarget>(
    () => ({
      kind: 'agent',
      profileId,
      ...(inheritedNodeId !== undefined ? { nodeId: inheritedNodeId } : {}),
      ...(inheritedCwd !== undefined ? { cwd: inheritedCwd } : {}),
    }),
    [profileId, inheritedNodeId, inheritedCwd],
  )
  const viewingRef = useRef(false)
  const isViewingTarget = isSplit
    ? isSameResolvedTarget(splitTarget, coordinateTarget)
    : isSameResolvedTarget(primaryTarget, coordinateTarget)
  useLayoutEffect(() => {
    viewingRef.current = isViewingTarget
  }, [isViewingTarget])
  useEffect(() => {
    return () => { viewingRef.current = false }
  }, [])

  // The real first send; only reachable through the submit decision below (retry re-runs it too).
  const send = useCallback((): Promise<StandbySendResult> =>
    executeStandbySend(draftKey, profileId, {
      create: (init) => conversationsApi.create(init),
      patchThinkingLevel: (id, thinkingLevel) => conversationsApi.patch(id, { thinkingLevel }).then(() => undefined),
      upload: (id, file) => conversationsApi.uploadArtifact(id, file),
      submit: (id, payload) => conversationsApi.submitInput(id, payload).then(() => undefined),
      notifyError: (title, err, conversationId) => {
        pushNotice({
          type: 'notification',
          level: 'error',
          title,
          body: errorText(err),
          ...(conversationId !== undefined ? { target: { kind: 'conversation', conversationId } } : {}),
        })
      },
      notifySentInBackground: (conversationId) => {
        pushNotice({
          type: 'notification',
          level: 'info',
          title: t('composer.standby.sentInBackgroundTitle'),
          body: t('composer.standby.sentInBackgroundBody', { id: conversationId }),
          target: { kind: 'conversation', conversationId },
        })
      },
      navigateToConversation: (conversationId) => {
        openTarget(
          { kind: 'conversation', conversationId },
          { history: 'replace', ...(isSplit ? { split: true } : {}) },
        )
      },
      isStillViewing: () => viewingRef.current,
    }, t), [draftKey, profileId, isSplit, openTarget, pushNotice, t])

  const submitDraft = useCallback((): void => {
    const record = getStandbyDraft(draftKey)
    if (commandPendingRef.current || record.sending) return
    const pluginCmd = matchExactPluginSlash(record.text.trim(), slashPluginCommands)
    if (pluginCmd !== undefined) {
      executeStandbyPluginCommand(pluginCmd, 'clear')
      return
    }
    const action = standbyManageAction(record.text)
    if (action !== null) {
      if (action.kind === 'clear-draft') {
        updateStandbyDraft(draftKey, { text: '', localFiles: [], uploaded: [], inputMeta: undefined, error: null })
        pushNotice({ type: 'notification', level: 'info', title: t('composer.standby.newDraftStartedTitle'), body: t('composer.standby.newDraftStartedBody') })
      } else {
        pushNotice({
          type: 'notification',
          level: 'warning',
          title: t('composer.standby.needsConversationTitle', { command: action.command }),
          body: t('composer.standby.needsConversationBody'),
        })
      }
      return
    }
    void send()
  }, [draftKey, executeStandbyPluginCommand, pushNotice, send, slashPluginCommands, t])

  return { submitDraft }
}
