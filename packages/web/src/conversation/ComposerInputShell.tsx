/**
 * Shared composer shell (.composer-shell / .composer-box / attachment chips /
 * auto-growing textarea / CommandPopover / CompletionPopover / toolbar / status row)
 * consumed by both active-conversation Composer and AgentStandbyPane.
 */
import { useCallback, useRef, useState } from 'react'
import type * as React from 'react'
import {
  Badge,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRoot,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  HelmxIcon,
  IconButton,
  Tooltip,
  resolveLocalizedText,
  type BadgeTone,
} from '@helmx/plugin-client'
import { useWebLocale } from '../i18n/use-web-locale.js'
import type { QualifiedCommand, SlashMenuItem } from '../lib/commands-model.js'
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
    tone?: BadgeTone
    className?: string
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
  plusMenuDisabled?: boolean
  onOpenFilePicker: () => void
  onFileInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  /** Plugin items mounted inside the unified `+` menu (`COMPOSER_MENU_SLOT`). */
  renderMenuSlot?: (closeMenu: () => void) => React.ReactNode
  /** Eligible plugin slash commands not already contributing to `COMPOSER_MENU_SLOT`. */
  menuCommands?: ReadonlyArray<QualifiedCommand>
  menuCommandsDisabled?: boolean
  onRunMenuCommand?: (cmd: QualifiedCommand) => void
  /** Persisted-conversation session management actions rendered in the `+` menu. */
  onCompactContext?: () => void
  compactDisabled?: boolean
  onClearContext?: () => void
  onNewTopic?: () => void
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
  /** Compact interactive controls mounted inside `.composer-toolbar-left` after `modelPicker`. */
  toolbarSlot?: React.ReactNode
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
  plusMenuDisabled = false,
  onOpenFilePicker,
  onFileInputChange,
  renderMenuSlot,
  menuCommands,
  menuCommandsDisabled = false,
  onRunMenuCommand,
  onCompactContext,
  compactDisabled = false,
  onClearContext,
  onNewTopic,
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
  toolbarSlot,
  sendControls,
  statusRow,
}: ComposerInputShellProps): React.JSX.Element {
  const { locale, t } = useWebLocale()
  const composerBoxRef = useRef<HTMLDivElement | null>(null)
  const navPickedRef = useRef(false)
  const [plusMenuOpen, setPlusMenuOpen] = useState(false)
  const closePlusMenu = useCallback(() => setPlusMenuOpen(false), [])
  const hasToolsSection =
    renderMenuSlot !== undefined || (menuCommands !== undefined && menuCommands.length > 0)
  const hasSessionSection =
    onCompactContext !== undefined || onClearContext !== undefined || onNewTopic !== undefined

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
                <span key={att.key} className="attachment-chip" title={att.name}>
                  <HelmxIcon name={att.icon} size={11} />
                  <span className="attachment-chip-name">{att.name}</span>
                  <span className="attachment-chip-size mono tabular-nums">{formatBytes(att.size)}</span>
                  {att.badge !== undefined ? (
                    <Badge tone={att.badge.tone ?? 'neutral'} className={att.badge.className}>
                      {att.badge.label}
                    </Badge>
                  ) : null}
                  <Tooltip content={t('composer.standby.removeAttachmentTitle', { name: att.name })} side="top">
                    <IconButton
                      icon={<HelmxIcon name="x" size={10} />}
                      variant="ghost"
                      size="xs"
                      aria-label={t('composer.standby.removeAttachmentTitle', { name: att.name })}
                      disabled={att.removeDisabled}
                      onClick={att.onRemove}
                    />
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
              inputRef={textareaRef}
            />
          ) : null}
          <CompletionPopover
            open={completionOpen}
            trigger={completionTrigger}
            snapshot={completionSnapshot}
            onPick={onPickCompletion}
            onClose={onCloseCompletion}
            anchorRef={composerBoxRef}
            inputRef={textareaRef}
          />
          <div className="composer-toolbar">
            <div className="composer-toolbar-left">
              <DropdownMenuRoot
                open={plusMenuOpen}
                onOpenChange={(open) => {
                  if (open) navPickedRef.current = false
                  setPlusMenuOpen(open)
                }}
              >
                <DropdownMenuTrigger asChild>
                  <IconButton
                    icon={<HelmxIcon name="plus" size={18} />}
                    variant="ghost"
                    size="sm"
                    className="composer-icon-button composer-plus-trigger"
                    aria-label={t('composer.plusMenu.aria')}
                    title={t('composer.plusMenu.title')}
                    disabled={plusMenuDisabled}
                  />
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  portalled
                  align="start"
                  side="top"
                  sideOffset={8}
                  className="composer-plus-menu"
                  onCloseAutoFocus={(e) => {
                    if (navPickedRef.current) {
                      navPickedRef.current = false
                      e.preventDefault()
                    }
                  }}
                >
                  <DropdownMenuItem
                    className="composer-plus-menu-item"
                    disabled={uploadDisabled}
                    onSelect={onOpenFilePicker}
                  >
                    <HelmxIcon name="paperclip" size={14} className="composer-plus-menu-icon" />
                    <span className="composer-plus-menu-label">{uploadButtonLabel}</span>
                  </DropdownMenuItem>
                  {hasToolsSection ? (
                    <div className="composer-plus-menu-group">
                      <DropdownMenuSeparator />
                      {renderMenuSlot?.(closePlusMenu)}
                      {menuCommands?.map((cmd) => (
                        <DropdownMenuItem
                          key={`cmd:${cmd.pluginId}/${cmd.spec.id}`}
                          className="composer-plus-menu-item"
                          disabled={menuCommandsDisabled}
                          onSelect={() => onRunMenuCommand?.(cmd)}
                        >
                          <HelmxIcon
                            name={cmd.spec.icon ?? 'terminal'}
                            size={14}
                            className="composer-plus-menu-icon"
                          />
                          <span className="composer-plus-menu-label">
                            {resolveLocalizedText(cmd.spec.title, locale)}
                          </span>
                          {cmd.spec.slash !== undefined ? (
                            <span className="composer-plus-menu-hint mono">{`/${cmd.spec.slash}`}</span>
                          ) : null}
                        </DropdownMenuItem>
                      ))}
                    </div>
                  ) : null}
                  {hasSessionSection ? (
                    <div className="composer-plus-menu-group">
                      <DropdownMenuSeparator />
                      {onCompactContext !== undefined ? (
                        <DropdownMenuItem
                          className="composer-plus-menu-item"
                          disabled={compactDisabled}
                          onSelect={onCompactContext}
                        >
                          <HelmxIcon name="minimize-2" size={14} className="composer-plus-menu-icon" />
                          <span className="composer-plus-menu-label">{t('composer.plusMenu.compact')}</span>
                          <span className="composer-plus-menu-hint mono">/compact</span>
                        </DropdownMenuItem>
                      ) : null}
                      {onClearContext !== undefined ? (
                        <DropdownMenuItem
                          className="composer-plus-menu-item"
                          onSelect={onClearContext}
                        >
                          <HelmxIcon name="rotate-ccw" size={14} className="composer-plus-menu-icon" />
                          <span className="composer-plus-menu-label">{t('composer.plusMenu.clear')}</span>
                          <span className="composer-plus-menu-hint mono">/clear</span>
                        </DropdownMenuItem>
                      ) : null}
                      {onNewTopic !== undefined ? (
                        <DropdownMenuItem
                          className="composer-plus-menu-item"
                          onSelect={() => {
                            navPickedRef.current = true
                            onNewTopic()
                          }}
                        >
                          <HelmxIcon name="message-square" size={14} className="composer-plus-menu-icon" />
                          <span className="composer-plus-menu-label">{t('composer.plusMenu.newTopic')}</span>
                          <span className="composer-plus-menu-hint mono">/new</span>
                        </DropdownMenuItem>
                      ) : null}
                    </div>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenuRoot>
              {modelPicker}
              {toolbarSlot}
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
