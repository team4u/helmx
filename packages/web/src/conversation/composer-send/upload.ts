/**
 * Attachment upload of the composer send pipeline: per-file upload with explicit failure
 * notices. After every await the live draft is used, so the stale text / anchor of the render
 * snapshot that started the upload never flows back into the draft.
 */
import { useCallback } from 'react'
import type { WebMessageTranslator } from '../../i18n/catalog.js'
import { conversationsApi } from '../../lib/api.js'
import type { PendingAttachment } from '../composer-model.js'
import type { ComposerSendCore } from './core.js'
import type { ComposerNotices } from './notices.js'

export interface ComposerUpload {
  /** Number of attachment uploads in flight. */
  readonly uploading: number
  /** Upload attachments file by file (images and plain files share the path;
   * failures notify explicitly). */
  readonly uploadFiles: (files: ReadonlyArray<File>) => Promise<void>
}

export function useComposerUpload(
  core: ComposerSendCore,
  notices: ComposerNotices,
  t: WebMessageTranslator,
): ComposerUpload {
  const {
    conversationId,
    uploading,
    setUploading,
    uploadingRef,
    setAttachments,
    liveDraftRef,
    isActiveConversation,
    isActiveMountedConversation,
    publishHiddenDirty,
  } = core
  const { notifyErrorFor } = notices

  const uploadFiles = useCallback(
    async (files: ReadonlyArray<File>): Promise<void> => {
      const targetConversationId = conversationId
      uploadingRef.current += files.length
      setUploading(uploadingRef.current)
      for (const file of files) {
        try {
          if (file.size > 15 * 1024 * 1024) throw new Error(t('composer.attach.tooLarge'))
          const meta = await conversationsApi.uploadArtifact(targetConversationId, file)
          if (!isActiveConversation(targetConversationId)) continue
          const uploaded: PendingAttachment = { artifactId: meta.id, name: meta.name, size: meta.size, mimeType: meta.mimeType }
          liveDraftRef.current = {
            ...liveDraftRef.current,
            attachments: [...liveDraftRef.current.attachments, meta.id],
          }
          setAttachments((prev) => [...prev, uploaded])
        } catch (err) {
          if (isActiveMountedConversation(targetConversationId)) {
            notifyErrorFor(targetConversationId, t('composer.attach.uploadFailedTitle', { name: file.name }), err)
          }
        } finally {
          uploadingRef.current--
          if (isActiveConversation(targetConversationId)) {
            setUploading(uploadingRef.current)
            publishHiddenDirty()
          }
        }
      }
    },
    [conversationId, isActiveConversation, isActiveMountedConversation, notifyErrorFor, publishHiddenDirty, t],
  )

  return { uploading, uploadFiles }
}
