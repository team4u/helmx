/**
 * Standby target navigation: resetting the draft environment to the agent default and
 * switching to another agent both move the unsent draft along (or warn when the target
 * already holds one) and navigate with `replace` — the standby page is a stable entry, not
 * a history step.
 */
import { useCallback } from 'react'
import type { WebMessageTranslator } from '../../i18n/catalog.js'
import { useStoreActions } from '../../lib/store-context.js'
import type { HelmxStoreActions } from '../../lib/store/types.js'
import { openStandbyWithFocus } from '../standby-focus.js'
import {
  resetEnvStandbyDraft,
  standbyDraftKey,
  transferStandbyDraftOnProfileSwitch,
  type StandbyDraftState,
} from '../standby-model.js'

export interface StandbyProfileNavigation {
  /** Reset the draft environment to the agent default (the draft moves along, or a warning
   * is shown when the default already holds one). */
  readonly resetEnvToDefault: () => void
  /** Switch the standby target to another agent (the draft travels along unless the target
   * is occupied) and focus its composer. */
  readonly switchProfile: (nextProfileId: string, closePicker?: () => void) => void
}

export function useStandbyProfileNavigation(input: {
  draftKey: string
  draft: StandbyDraftState
  panel: 'primary' | 'split'
  profileId: string
  isSplit?: boolean
  pushNotice: HelmxStoreActions['pushNotice']
  t: WebMessageTranslator
}): StandbyProfileNavigation {
  const { draftKey, draft, panel, profileId, isSplit, pushNotice, t } = input
  const { openTarget } = useStoreActions()

  const resetEnvToDefault = useCallback((): void => {
    if (draft.sending || draft.conversationId !== undefined) return
    const toKey = standbyDraftKey({ panel, profileId })
    if (toKey === draftKey) {
      resetEnvStandbyDraft(draftKey, toKey)
      return
    }
    const moved = resetEnvStandbyDraft(draftKey, toKey)
    if (!moved) {
      pushNotice({
        type: 'notification',
        level: 'warning',
        title: t('composer.standby.defaultEnvHasDraftTitle'),
        body: t('composer.standby.defaultEnvHasDraftBody'),
      })
    }
    openTarget({ kind: 'agent', profileId }, isSplit ? { split: true } : undefined)
  }, [draft.sending, draft.conversationId, draftKey, isSplit, openTarget, panel, profileId, pushNotice, t])

  const switchProfile = useCallback(
    (nextProfileId: string, closePicker?: () => void): void => {
      if (nextProfileId === profileId) {
        closePicker?.()
        return
      }
      if (draft.sending || draft.conversationId !== undefined) return
      const toKey = standbyDraftKey({ panel, profileId: nextProfileId })
      const result = transferStandbyDraftOnProfileSwitch(draftKey, toKey)
      if (result === 'target-occupied') {
        pushNotice({
          type: 'notification',
          level: 'warning',
          title: t('composer.standby.switchProfileTargetOccupiedTitle'),
          body: t('composer.standby.switchProfileTargetOccupiedBody'),
        })
      }
      openStandbyWithFocus({ panel, profileId: nextProfileId }, () => {
        closePicker?.()
        openTarget(
          { kind: 'agent', profileId: nextProfileId },
          { history: 'replace', ...(isSplit ? { split: true } : {}) },
        )
      })
    },
    [draft.sending, draft.conversationId, draftKey, isSplit, openTarget, panel, profileId, pushNotice, t],
  )

  return { resetEnvToDefault, switchProfile }
}
