/**
 * Draft edits of the standby pane: admitting files (per-file rejections notify explicitly)
 * and starter prompts (only fill an idle, empty draft; otherwise warn and leave it alone).
 */
import { useCallback, type RefObject } from 'react'
import type { WebMessageTranslator } from '../../i18n/catalog.js'
import type { HelmxStoreActions } from '../../lib/store/types.js'
import { admitStandbyFiles, getStandbyDraft, updateStandbyDraft } from '../standby-model.js'

export interface StandbyDraftActions {
  /** Admit pasted / dropped files into the draft (rejects with an explicit notice per file). */
  readonly addFiles: (files: ReadonlyArray<File>) => void
  /** Starter prompt: fills an idle empty draft and focuses the textarea. */
  readonly applyStarter: (prompt: string) => void
}

export function useStandbyDraftActions(input: {
  draftKey: string
  textareaRef: RefObject<HTMLTextAreaElement | null>
  pushNotice: HelmxStoreActions['pushNotice']
  t: WebMessageTranslator
}): StandbyDraftActions {
  const { draftKey, textareaRef, pushNotice, t } = input

  const addFiles = useCallback((files: ReadonlyArray<File>): void => {
    if (files.length === 0 || getStandbyDraft(draftKey).sending) return
    const { draft: patch, rejected } = admitStandbyFiles(getStandbyDraft(draftKey), files, t)
    updateStandbyDraft(draftKey, patch)
    for (const item of rejected) {
      pushNotice({
        type: 'notification',
        level: 'error',
        title: t('composer.standby.attachmentRejectedTitle', { name: item.file.name || t('composer.standby.unnamedFile') }),
        body: item.reason,
      })
    }
  }, [draftKey, pushNotice, t])

  const applyStarter = useCallback((prompt: string): void => {
    const record = getStandbyDraft(draftKey)
    if (record.sending) return
    if (record.text.trim() !== '' || record.localFiles.length > 0 || record.uploaded.length > 0) {
      pushNotice({ type: 'notification', level: 'warning', title: t('composer.draft.handleBeforeStarter') })
      return
    }
    updateStandbyDraft(draftKey, { text: prompt })
    requestAnimationFrame(() => textareaRef.current?.focus())
  }, [draftKey, pushNotice, t])

  return { addFiles, applyStarter }
}
