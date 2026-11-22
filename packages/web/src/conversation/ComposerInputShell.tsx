/**
 * Shared composer shell (.composer-shell / .composer-box / attachment chips /
 * auto-growing textarea / CommandPopover / CompletionPopover / toolbar / status row)
 * consumed by both active-conversation Composer and AgentStandbyPane.
 */
import { useRef } from 'react'
import type * as React from 'react'
import { HelmxIcon, Tooltip } from '@helmx/plugin-client'
import { useWebLocale } from '../i18n/use-web-locale.js'
import type { SlashMenuItem } from '../lib/commands-model.js'
import { formatBytes } from '../lib/format.js'
import { CommandPopover } from './CommandPopover.js'
import { CompletionPopover } from './CompletionPopover.js'
import type { MergedCompletionItem } from './composer-completion-model.js'
import type { CompletionSourceSnapshot } from './use-composer-completion.js'

export interface ComposerAttachmentItem {
  key: string
  name: string
  size: number
  icon: string
  badge?: {
    label: string
    className: string
  }
  removeDisabled?: boolean
  onRemove: () => void
}

export interface ComposerInputShellProps {
  /** Content mounted above `.composer-box` (PluginSlot / AskDock / EnvBar / anchored/error callouts). */
  aboveBox?: React.ReactNode
  /** Optional inline banner inside `.composer-box` above attachments (e.g. history-edit notice). */
  boxBanner?: React.ReactNode
  attachments: ReadonlyArray<ComposerAttachmentItem>
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  textareaAriaLabel: string
  value: string
  placeholder: string
  readOnly?: boolean
  onTextChange: (value: string, caret: number) => void
  onKeyUp: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onClick: (e: React.MouseEvent<HTMLTextAreaElement>) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onPaste: (e: React.ClipboardEvent) => void
  dragging: boolean
  onDragEnter: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onDragLeave: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
  fileInputRef: React.RefObject<HTMLInputElement | null>
  uploadButtonLabel: string
  uploadDisabled?: boolean
  onOpenFilePicker: () => void
  onFileInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  slashOpen: boolean
  popoverQuery: string
  slashMenuItems: SlashMenuItem[]
  onPickSlash: (apply: string) => void
  onCloseSlash: () => void
  completionOpen: boolean
  completionTrigger: '@' | '#' | ':'
  completionSnapshot: CompletionSourceSnapshot
  onPickCompletion: (entry: MergedCompletionItem) => void
  onCloseCompletion: () => void
  modelPicker: React.ReactNode
  sendControls: React.ReactNode
  statusRow?: React.ReactNode
}

export function ComposerInputShell({
  aboveBox,
  boxBanner,
  attachments,
  textareaRef,
  textareaAriaLabel,
  value,
  placeholder,
  readOnly = false,
  onTextChange,
  onKeyUp,
  onClick,
  onKeyDown,
  onPaste,
  dragging,
  onDragEnter,
  onDragOver,
  onDragLeave,
  onDrop,
  fileInputRef,
  uploadButtonLabel,
  uploadDisabled = false,
  onOpenFilePicker,
  onFileInputChange,
  slashOpen,
  popoverQuery,
  slashMenuItems,
  onPickSlash,
  onCloseSlash,
  completionOpen,
  completionTrigger,
  completionSnapshot,
  onPickCompletion,
  onCloseCompletion,
  modelPicker,
  sendControls,
  statusRow,
}: ComposerInputShellProps): React.JSX.Element {
  const { t } = useWebLocale()
  const composerBoxRef = useRef<HTMLDivElement | null>(null)

  return (
    <div className="composer-shell">
      <div className="composer-inner">
        {aboveBox}
        <div
          className="composer-box"
          ref={composerBoxRef}
          data-dragging={dragging ? 'true' : undefined}
          onDragEnter={onDragEnter}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        >
          {boxBanner}
          {attachments.length > 0 ? (
            <div className="composer-attachments">
              {attachments.map((att) => (
                <span key={att.key} className="attachment-chip">
                  <HelmxIcon name={att.icon} size={11} />
                  <span>{att.name}</span>
                  <span className="mono tabular-nums">{formatBytes(att.size)}</span>
                  {att.badge !== undefined ? (
                    <span className={att.badge.className}>{att.badge.label}</span>
                  ) : null}
                  <Tooltip content={t('composer.standby.removeAttachmentTitle', { name: att.name })} side="top">
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon-xs"
                      title={t('composer.standby.removeAttachment')}
                      aria-label={t('composer.standby.removeAttachmentTitle', { name: att.name })}
                      disabled={att.removeDisabled}
                      onClick={att.onRemove}
                    >
                      <HelmxIcon name="x" size={10} />
                    </button>
                  </Tooltip>
                </span>
              ))}
            </div>
          ) : null}
          <textarea
            aria-label={textareaAriaLabel}
            ref={textareaRef}
            className="composer-textarea selectable"
            data-composer-draft-managed="true"
            value={value}
            rows={1}
            readOnly={readOnly}
            placeholder={placeholder}
            onChange={(e) => onTextChange(e.target.value, e.target.selectionStart ?? e.target.value.length)}
            onKeyUp={onKeyUp}
            onClick={onClick}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            spellCheck={false}
          />
          {slashOpen ? (
            <CommandPopover
              query={popoverQuery}
              slashItems={slashMenuItems}
              onPick={onPickSlash}
              onClose={onCloseSlash}
              anchorRef={composerBoxRef}
            />
          ) : null}
          <CompletionPopover
            open={completionOpen}
            trigger={completionTrigger}
            snapshot={completionSnapshot}
            onPick={onPickCompletion}
            onClose={onCloseCompletion}
            anchorRef={composerBoxRef}
          />
          <div className="composer-toolbar">
            <div className="composer-toolbar-left">
              <Tooltip content={uploadButtonLabel} side="top">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm composer-icon-button"
                  title={uploadButtonLabel}
                  aria-label={uploadButtonLabel}
                  disabled={uploadDisabled}
                  onClick={onOpenFilePicker}
                >
                  <HelmxIcon name="plus" size={19} />
                </button>
              </Tooltip>
              {modelPicker}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                style={{ display: 'none' }}
                disabled={uploadDisabled}
                onChange={onFileInputChange}
              />
            </div>
            {sendControls}
          </div>
        </div>
        {statusRow !== undefined ? <div className="composer-status-row">{statusRow}</div> : null}
      </div>
    </div>
  )
}
