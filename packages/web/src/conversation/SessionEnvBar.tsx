import { useEffect, useRef, useState } from 'react'
import type { ConversationSummary } from '@helmx/protocol/browser'
import { Button, ErrorText } from '@helmx/plugin-client'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { conversationsApi } from '../lib/api.js'
import { useNodes, useStoreActions } from '../lib/store-context.js'
import { ComposerEnvFields } from './ComposerEnvFields.js'
import {
  envDraftError,
  envDraftOnNodeChange,
  type EnvDraft,
  type SessionEnvBlocker,
  ENV_BLOCKER_CLEAR,
} from './composer-model.js'

/** Shown for empty conversations (or after /reset with no new messages): a
 * draft-style configuration of the starting execution node and working
 * directory. */
export function SessionEnvBar({
  conversation,
  sendBlocked,
  onBlockerChange,
}: {
  conversation: ConversationSummary
  sendBlocked: boolean
  onBlockerChange: (blocker: SessionEnvBlocker) => void
}) {
  const nodes = useNodes()
  const { pushNotice } = useStoreActions()
  const { t } = useWebLocale()
  const [draft, setDraft] = useState<EnvDraft>(() => ({
    nodeId: conversation.nodeId || 'local',
    cwd: conversation.cwd,
  }))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const currentNodeId = conversation.nodeId || 'local'
  const draftNode = nodes.find((n) => n.id === draft.nodeId)
  const [confirmed, setConfirmed] = useState<EnvDraft>(() => ({ nodeId: currentNodeId, cwd: conversation.cwd }))
  const lastCoordinatesRef = useRef<EnvDraft>({ nodeId: currentNodeId, cwd: conversation.cwd })
  const unchanged = draft.nodeId === confirmed.nodeId && draft.cwd === confirmed.cwd
  const validationError = envDraftError(draft, t)
  const dirty = !unchanged
  const blocked = saving || dirty
  const blocker: SessionEnvBlocker = blocked
    ? { blocked: true, reason: saving ? t('composer.env.blockerSaving') : t('composer.env.saveOrCancelFirst') }
    : ENV_BLOCKER_CLEAR

  useEffect(() => {
    onBlockerChange(blocker)
  }, [blocker.blocked, blocker.reason, onBlockerChange])

  useEffect(() => {
    const previous = lastCoordinatesRef.current
    if (previous.nodeId === currentNodeId && previous.cwd === conversation.cwd) return
    const next = { nodeId: currentNodeId, cwd: conversation.cwd }
    lastCoordinatesRef.current = next
    setConfirmed(next)
    if (dirty) return
    setDraft(next)
  }, [currentNodeId, conversation.cwd, dirty])

  const save = async (): Promise<void> => {
    if (saving || sendBlocked) return
    const err = envDraftError(draft, t)
    if (err !== null) {
      setError(err)
      return
    }
    if (unchanged) return
    setSaving(true)
    setError(null)
    try {
      const saved = await conversationsApi.patch(conversation.id, { nodeId: draft.nodeId, cwd: draft.cwd.trim() })
      const nextConfirmed: EnvDraft = { nodeId: saved.nodeId || 'local', cwd: saved.cwd }
      setConfirmed(nextConfirmed)
      setDraft(nextConfirmed)
      pushNotice({
        type: 'notification',
        level: 'info',
        title: t('composer.env.savedTitle'),
        body: `#${conversation.id} -> ${saved.nodeId || 'local'}:${saved.cwd}`,
        target: { kind: 'conversation', conversationId: conversation.id },
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setError(message)
      pushNotice({
        type: 'notification',
        level: 'error',
        title: t('composer.env.saveFailed'),
        body: message,
        target: { kind: 'conversation', conversationId: conversation.id },
      })
    } finally {
      setSaving(false)
    }
  }

  const cancel = (): void => {
    if (saving) return
    setDraft(confirmed)
    setError(null)
  }

  return (
    <div className="composer-env-bar" data-dirty={dirty ? 'true' : undefined}>
      <ComposerEnvFields
        nodeId={draft.nodeId}
        cwd={draft.cwd}
        disabled={saving || sendBlocked}
        nodeAriaLabel={t('composer.env.nodeAria')}
        cwdAriaLabel={t('composer.env.cwdAria')}
        cwdPlaceholder={draft.nodeId === currentNodeId ? t('composer.env.cwdPlaceholderSameNode') : t('composer.env.cwdPlaceholder')}
        cwdInvalid={error !== null}
        onNodeChange={(nextNodeId) => {
          setError(null)
          setDraft((prev) => envDraftOnNodeChange(prev, nextNodeId))
        }}
        onCwdChange={(nextCwd) => {
          setError(null)
          setDraft((prev) => ({ ...prev, cwd: nextCwd }))
        }}
        onCwdKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            void save()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            cancel()
          }
        }}
      />
      {blocked ? (
        <span className="composer-env-actions">
          <Button
            variant="primary"
            size="sm"
            icon="check"
            pending={saving}
            disabled={validationError !== null}
            onClick={() => void save()}
          >
            {t('common.save')}
          </Button>
          <Button size="sm" disabled={saving} onClick={cancel}>
            {t('common.cancel')}
          </Button>
        </span>
      ) : null}
      {error !== null ? (
        <ErrorText live className="composer-env-error" title={error}>{error}</ErrorText>
      ) : draftNode !== undefined && !draftNode.online && draft.nodeId !== 'local' ? (
        <span className="composer-env-warn">{t('composer.env.nodeOfflineAfterSave')}</span>
      ) : null}
      <span className="composer-env-hint">{t('composer.env.lockedHint')}</span>
    </div>
  )
}
