/**
 * Composer send-pipeline hook (composition root; business logic lives in the concern hooks
 * under `composer-send/`):
 * - `core`: single owner of the draft triple (text / edit anchor / attachments), the live
 *   draft version (liveDraftRef) and the in-flight sentinels;
 * - `draft`: prefill consumption and every draft mutation;
 * - `env-blocker`: the empty-conversation starting-environment block (SessionEnvBar);
 * - `upload`: per-file attachment upload with explicit failure notices;
 * - `slash-commands`: exact plugin slash-command hits and session management commands
 *   (/new /clear /compact) executed on the spot;
 * - `send-pipeline`: real send (optimistic clear + rollback against the frozen draft version
 *   by live draft version on failure), explicit text submission (sendExplicit: consumes no
 *   draft / edit anchor / attachments and rejects honestly on failure) and queued-withdraw;
 * - `dirty-report`: version auto-refresh pending check (local draft dirtiness).
 * The concern hooks compose in a fixed order so the hook sequence (state slots, effect
 * phases and order, stable-callback identities) is exactly the one the former single-body
 * hook had. This module exports only hooks and pure types (no components), honoring the
 * .ts Fast Refresh rule.
 */
import type { WebMessageTranslator } from '../i18n/catalog.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { useOptionalLocale, useStoreActions } from '../lib/store-context.js'
import { DEFAULT_HELMX_LOCALE } from '@helmx/protocol/browser'
import { useComposerSendCore } from './composer-send/core.js'
import { useComposerDirtyReport } from './composer-send/dirty-report.js'
import { useComposerDraft } from './composer-send/draft.js'
import { useComposerEnvBlocker } from './composer-send/env-blocker.js'
import { useComposerNotices } from './composer-send/notices.js'
import { useComposerSendPipeline } from './composer-send/send-pipeline.js'
import { useComposerSlashCommands } from './composer-send/slash-commands.js'
import type { ComposerSendApi, ComposerSendInput } from './composer-send/types.js'
import { useComposerUpload } from './composer-send/upload.js'

export type { ComposerPrefill, ComposerSendApi, ComposerSendInput } from './composer-send/types.js'

export function useComposerSend(input: ComposerSendInput, tOverride?: WebMessageTranslator): ComposerSendApi {
  const { invokePluginAction, pushNotice } = useStoreActions()
  const { t: localeT } = useWebLocale()
  const t = tOverride ?? localeT
  const locale = useOptionalLocale() ?? DEFAULT_HELMX_LOCALE

  const core = useComposerSendCore(input)
  const env = useComposerEnvBlocker(core, input.envConfigurable)
  const draft = useComposerDraft(core, input, t, pushNotice)
  const notices = useComposerNotices(pushNotice, core.conversationId)
  const { uploading, uploadFiles } = useComposerUpload(core, notices, t)
  const commands = useComposerSlashCommands(core, input, { t, locale, invokePluginAction, pushNotice, notices })
  const { sending, send, sendExplicit, withdrawQueuedInput } = useComposerSendPipeline(core, input, {
    t,
    pushNotice,
    notices,
    env,
    commands,
    draft,
  })
  useComposerDirtyReport(core, input)

  return {
    text: draft.text,
    attachments: draft.attachments,
    editingEntryId: draft.editingEntryId,
    sending,
    uploading,
    runningCommand: commands.runningCommand,
    envBlocker: env.envBlocker,
    sendInFlight: sending || uploading > 0 || commands.runningCommand !== null,
    setDraftState: draft.setDraftState,
    insertTextState: draft.insertTextState,
    readLiveDraft: draft.readLiveDraft,
    cancelEdit: draft.cancelEdit,
    uploadFiles,
    removeAttachment: draft.removeAttachment,
    applyHistoryEdit: draft.applyHistoryEdit,
    withdrawQueuedInput,
    send,
    sendExplicit,
    runPluginCommand: commands.runPluginCommand,
    runPluginCommandDirect: commands.runPluginCommandDirect,
    handleEnvBlocker: env.handleEnvBlocker,
    notifyError: notices.notifyError,
  }
}
