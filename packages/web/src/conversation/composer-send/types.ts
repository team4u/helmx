/**
 * Public contract of the composer send pipeline (`useComposerSend`), re-exported from
 * `composer-send.ts`. It lives in its own module so the concern hooks under `composer-send/`
 * can depend on the contract without importing the composition root (cycle-free).
 */
import type { ComposerCommandRegistry } from '@helmx/plugin-client'
import type {
  ConversationAttachmentRef,
  ConversationSummary,
  QueuedConversationInput,
  WhenBusy,
} from '@helmx/protocol/browser'
import type { QualifiedCommand } from '../../lib/commands-model.js'
import type { PendingAttachment, SessionEnvBlocker } from '../composer-model.js'
import type { ConversationDirtySink } from '../conversation-window-model.js'
import type { EditRequestTarget } from '../timeline-model.js'

/** Prefill request (timeline "edit and resend"); the incrementing tick makes
 * the same text trigger again. */
export interface ComposerPrefill {
  text: string
  entryId?: number
  attachments?: ConversationAttachmentRef[]
  tick: number
  /** When true, prefill only if the draft is fully idle (no text/attachments/
   * edit anchor/in-flight operation); otherwise warn and refuse. */
  onlyIfEmpty?: boolean
}

export interface ComposerSendInput {
  conversation: ConversationSummary
  /** Edit-and-resend prefill request (null means none). */
  prefill: ComposerPrefill | null
  /** Notify the parent when a real send request starts/ends (in-flight
   * feedback; slash commands do not trigger it). */
  onSendingChange?: (sending: boolean) => void
  /** /new new-topic entry (navigates to this agent's standby pane); when not
   * provided an explicit notice is shown. */
  onNewThread?: () => void
  /** textarea ref (focus after prefill/insert; auto-grow is the component's job). */
  textareaRef: { current: HTMLTextAreaElement | null }
  /** Plugin slash commands available in the current conversation scope (exact
   * first-token hits execute). */
  slashPluginCommands: ReadonlyArray<QualifiedCommand>
  /** Whether the conversation still allows configuring the starting
   * environment (false resets the environment block sentinel). */
  envConfigurable: boolean
  /** Whether the conversation is busy (the sole basis for the send's whenBusy policy). */
  working: boolean
  /** Reporting key for the version auto-refresh pending check (unique per
   * component instance, e.g. useId()); omitted means no reporting. */
  dirtyKey?: string
  /** Keep-alive window dirty sink: when provided (conversation windows live inside an
   * <Activity>), the latest snapshot is also written here so the owning window frame can
   * re-publish it while hidden — Activity hide destroys this effect (clearing the report)
   * while the draft itself survives in component state. */
  dirtySink?: ConversationDirtySink | null
  /** Panel-local command handler registry: claims interactive slash commands before falling back to action RPC. */
  commandRegistry?: ComposerCommandRegistry
}

export interface ComposerSendApi {
  text: string
  attachments: PendingAttachment[]
  editingEntryId: number | null
  sending: boolean
  uploading: number
  /** Active in-flight plugin slash command (null when idle). */
  runningCommand: QualifiedCommand | null
  /** Environment block state (send button disable + hint). */
  envBlocker: SessionEnvBlocker
  /** Send, upload, or plugin command in flight (shared by the env bar's sendBlocked and button disable). */
  sendInFlight: boolean
  /** Replace the whole draft text (advances the live draft version like user
   * typing; anchor/attachments untouched). */
  setDraftState: (text: string) => void
  /** Insert a fragment at the caret (focusWithCaret restores the caret). */
  insertTextState: (fragment: string) => void
  /** Live draft text (for render-time reads such as the controller). */
  readLiveDraft: () => string
  /** Exit history-edit mode and clear the draft. */
  cancelEdit: () => void
  /** Upload attachments file by file (images and plain files share the path;
   * failures notify explicitly). */
  uploadFiles: (files: ReadonlyArray<File>) => Promise<void>
  /** Remove one pending attachment (synchronously advances the live draft version). */
  removeAttachment: (artifactId: string) => void
  /** ↑ history edit: wholesale replacement of text / anchor / attachments
   * (an empty attachment list clears the old draft). */
  applyHistoryEdit: (target: EditRequestTarget) => void
  /** ↑ queued-withdraw re-edit: withdraws the newest human queued input from
   * queuedInputs and prefills the draft (no history-rollback banner). */
  withdrawQueuedInput: (queued: QueuedConversationInput) => Promise<void>
  /** Host's real send flow (optimistic clear + rollback by live draft version
   * on failure + whenBusy policy). */
  send: (busyMode?: WhenBusy, strict?: boolean) => Promise<void>
  /** Submit explicit text (consumes no draft / edit anchor / attachments;
   * rejects honestly on failure). */
  sendExplicit: (raw: string, whenBusy?: WhenBusy) => Promise<void>
  /** Execute a plugin command from the slash menu (optimistic trigger cleanup
   * with rollback on untouched failure; stable identity). */
  runPluginCommand: (cmd: QualifiedCommand) => void
  /** Execute a plugin command triggered outside the text draft (e.g. unified + menu)
   * without stripping any draft token; stable identity. */
  runPluginCommandDirect: (cmd: QualifiedCommand) => void
  /** SessionEnvBar block report (stable identity, for its blocker effect deps). */
  handleEnvBlocker: (blocker: SessionEnvBlocker) => void
  /** Unified error-notice outlet (shared by component-side actions like aborting a turn). */
  notifyError: (title: string, err: unknown) => void
}
