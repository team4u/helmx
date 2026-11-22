/**
 * Attachment image thumbnail and non-image chip rendering for timeline rows.
 */
import { useEffect, useState } from 'react'
import type { ConversationAttachmentRef } from '@helmx/protocol/browser'
import { HelmxIcon } from '@helmx/plugin-client'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { artifactsApi } from '../lib/api.js'
import { formatBytes } from '../lib/format.js'
import { useStoreActions } from '../lib/store-context.js'
import { LazyMount } from '../ui/LazyMount.js'

function AttachmentImage({ att, conversationId }: { att: ConversationAttachmentRef; conversationId: number }) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const { setActiveModal } = useStoreActions()
  const { t } = useWebLocale()

  useEffect(() => {
    let active = true
    let objectUrl: string | null = null
    void artifactsApi
      .fetchBlob(att.id)
      .then((blob) => {
        if (!active) return
        objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
      })
      .catch((err: unknown) => setFailed(err instanceof Error ? err.message : String(err)))
    return () => {
      active = false
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl)
    }
  }, [att.id])

  if (failed !== null) {
    return (
      <span className="attachment-chip" title={t('conv.attachment.imageFailed', { reason: failed ?? '' })}>
        <HelmxIcon name="alert-triangle" size={11} />
        {att.name}
      </span>
    )
  }
  if (url === null) {
    return (
      <span className="attachment-chip">
        <HelmxIcon name="loader" size={11} />
        {att.name}
      </span>
    )
  }
  return (
    <button
      type="button"
      className="attachment-image-thumb"
      title={t('conv.attachment.clickToEnlarge', { name: att.name })}
      onClick={() =>
        setActiveModal({ kind: 'artifact-preview', artifactId: att.id, conversationId })
      }
    >
      <img src={url} alt={att.name} loading="lazy" />
    </button>
  )
}

export function AttachmentChips({
  attachments,
  conversationId,
}: {
  attachments: ConversationAttachmentRef[]
  conversationId: number
}) {
  const { setActiveModal } = useStoreActions()
  const { t } = useWebLocale()
  return (
    <span className="msg-attachments-wrap">
      {attachments.map((att) =>
        att.mimeType.startsWith('image/') ? (
          <LazyMount
            key={att.id}
            inline
            fallback={
              <span className="attachment-chip">
                <HelmxIcon name="file-text" size={11} />
                {att.name}
              </span>
            }
          >
            <AttachmentImage att={att} conversationId={conversationId} />
          </LazyMount>
        ) : (
          <button
            key={att.id}
            type="button"
            className="attachment-chip"
            title={t('conv.attachment.previewName', { name: att.name })}
            onClick={() =>
              setActiveModal({ kind: 'artifact-preview', artifactId: att.id, conversationId })
            }
          >
            <HelmxIcon name="file-text" size={11} />
            <span>{att.name}</span>
            <span className="mono tabular-nums">{formatBytes(att.size)}</span>
          </button>
        ),
      )}
    </span>
  )
}
