/**
 * Attachment chips of the standby composer: local files wait for the first send (neutral
 * "pending" badge), uploaded artifacts already belong to the anchored conversation.
 */
import type { WebMessageTranslator } from '../../i18n/catalog.js'
import type { ComposerAttachmentItem } from '../ComposerInputShell.js'
import { updateStandbyDraft, type StandbyDraftState } from '../standby-model.js'

export function buildStandbyAttachmentItems(
  draft: StandbyDraftState,
  draftKey: string,
  busy: boolean,
  t: WebMessageTranslator,
): ComposerAttachmentItem[] {
  return [
    ...draft.localFiles.map((att): ComposerAttachmentItem => ({
      key: att.key,
      name: att.name,
      size: att.size,
      icon: 'file',
      badge: {
        label: t('composer.standby.attachmentPending'),
        tone: 'neutral',
        className: 'agent-standby-attachment-state',
      },
      removeDisabled: busy,
      onRemove: () => updateStandbyDraft(draftKey, { localFiles: draft.localFiles.filter((item) => item.key !== att.key) }),
    })),
    ...draft.uploaded.map((att): ComposerAttachmentItem => ({
      key: att.artifactId,
      name: att.name,
      size: att.size,
      icon: 'paperclip',
      badge: {
        label: t('composer.standby.attachmentUploaded'),
        tone: 'ok',
        className: 'agent-standby-attachment-state',
      },
      removeDisabled: busy,
      onRemove: () => updateStandbyDraft(draftKey, { uploaded: draft.uploaded.filter((item) => item.artifactId !== att.artifactId) }),
    })),
  ]
}
