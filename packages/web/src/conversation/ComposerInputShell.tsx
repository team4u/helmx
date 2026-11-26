/**
 * Shared composer shell (.composer-shell / .composer-box / attachment chips /
 * auto-growing textarea / CommandPopover / CompletionPopover / toolbar / status row)
 * consumed by both active-conversation Composer and AgentStandbyPane.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
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
import type { HelmxShortcutDetail } from '../shell/shortcuts-model.js'
import { isElementVisibleInDocument } from '../shell/version-watch-model.js'
import { CommandPopover } from './CommandPopover.js'
import { CompletionPopover } from './CompletionPopover.js'
import type { MergedCompletionItem } from './composer-completion-model.js'
import { COMPOSER_SHORTCUTS } from './keybindings-model.js'
import type { CompletionSourceSnapshot } from './use-composer-completion.js'

const HELMX_SHORTCUT_EVENT = 'helmx:shortcut' as const

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
  /** Owning shortcut panel scope (`primary` | `split` | `drawer`). */
  shortcutPanel?: 'primary' | 'split' | 'drawer'
  /** Conversation ID when mounted inside a conversation drawer. */
  shortcutDrawerConversationId?: number
  /** False when the owning pane/drawer frame is hidden in Activity keep-alive. */
  shortcutActive?: boolean
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
  shortcutPanel = 'primary',
  shortcutDrawerConversationId,
  shortcutActive = true,
}: ComposerInputShellProps): React.JSX.Element {
  const { locale, t } = useWebLocale()
  const composerBoxRef = useRef<HTMLDivElement | null>(null)
  const plusTriggerRef = useRef<HTMLButtonElement | null>(null)
  const plusMenuContentRef = useRef<HTMLDivElement | null>(null)
  const [plusMenuOpen, setPlusMenuOpen] = useState(false)
  const plusMenuOpenRef = useRef(plusMenuOpen)
  plusMenuOpenRef.current = plusMenuOpen
  const plusMenuClosedByActionRef = useRef(false)
  const plusMenuOpenedByKeyboardRef = useRef(false)
  const plusMenuCloseFocusTextareaRef = useRef(false)
  const closePlusMenu = useCallback(() => {
    plusMenuOpenedByKeyboardRef.current = false
    plusMenuCloseFocusTextareaRef.current = false
    plusMenuClosedByActionRef.current = true
    setPlusMenuOpen(false)
  }, [])

  useEffect(() => {
    if (!shortcutActive || typeof window === 'undefined') return
    const onShortcut = (event: Event): void => {
      const detail = (event as CustomEvent<Partial<HelmxShortcutDetail> | undefined>).detail
      if (detail === undefined || detail === null || detail.action !== 'toggle-plus-menu') return
      if (detail.drawerConversationId !== shortcutDrawerConversationId) return
      const triggerEl = plusTriggerRef.current
      if (triggerEl === null || !triggerEl.isConnected) return
      if (plusMenuDisabled || triggerEl.disabled) return
      if (!isElementVisibleInDocument(triggerEl) || triggerEl.closest('[inert], [aria-hidden="true"]') !== null) {
        return
      }
      if (shortcutPanel === 'drawer') {
        if (detail.panel !== 'drawer') return
      } else {
        if (triggerEl.closest('.conversation-drawer') !== null && triggerEl.closest('[data-helmx-panel]') === null) {
          return
        }
        const ownerAttr = triggerEl.closest('[data-helmx-panel]')?.getAttribute('data-helmx-panel')
        const resolvedPanel = ownerAttr === 'primary' || ownerAttr === 'split' ? ownerAttr : shortcutPanel
        if (detail.panel !== resolvedPanel) return
      }

      if (plusMenuOpenRef.current) {
        plusMenuOpenedByKeyboardRef.current = false
        plusMenuClosedByActionRef.current = true
        plusMenuCloseFocusTextareaRef.current = true
        setPlusMenuOpen(false)
        const ta = textareaRef.current
        if (ta !== null && ta.isConnected && !ta.disabled) {
          ta.focus({ preventScroll: true })
        }
      } else {
        plusMenuClosedByActionRef.current = false
        plusMenuCloseFocusTextareaRef.current = false
        plusMenuOpenedByKeyboardRef.current = true
        setPlusMenuOpen(true)
      }
    }
    window.addEventListener(HELMX_SHORTCUT_EVENT, onShortcut)
    return () => window.removeEventListener(HELMX_SHORTCUT_EVENT, onShortcut)
  }, [shortcutActive, shortcutPanel, shortcutDrawerConversationId, plusMenuDisabled, textareaRef])

  useEffect(() => {
    if (!plusMenuOpen || !plusMenuOpenedByKeyboardRef.current) return
    plusMenuOpenedByKeyboardRef.current = false
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') return
    const rafId = window.requestAnimationFrame(() => {
      const content = plusMenuContentRef.current
      if (content === null) return
      const firstItem = content.querySelector<HTMLElement>(
        '[role="menuitem"]:not([data-disabled]):not([aria-disabled="true"])',
      )
      const target = firstItem ?? content
      if (document.activeElement !== target) {
        target.focus({ preventScroll: true })
      }
    })
    return () => window.cancelAnimationFrame(rafId)
  }, [plusMenuOpen])
  const hasToolsSection =
    renderMenuSlot !== undefined || (menuCommands !== undefined && menuCommands.length > 0)

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
                onOpenChange={(next) => {
                  if (next) {
                    plusMenuClosedByActionRef.current = false
                    plusMenuCloseFocusTextareaRef.current = false
                  } else {
                    plusMenuOpenedByKeyboardRef.current = false
                  }
                  setPlusMenuOpen(next)
                }}
              >
                <DropdownMenuTrigger asChild>
                  <IconButton
                    ref={plusTriggerRef}
                    icon={<HelmxIcon name="plus" size={18} />}
                    variant="ghost"
                    size="sm"
                    className="composer-icon-button composer-plus-trigger"
                    aria-label={t('composer.plusMenu.aria')}
                    title={t('composer.plusMenu.title', { shortcut: COMPOSER_SHORTCUTS.togglePlusMenu })}
                    disabled={plusMenuDisabled}
                  />
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  ref={plusMenuContentRef}
                  portalled
                  align="start"
                  side="top"
                  sideOffset={8}
                  className="composer-plus-menu"
                  onEscapeKeyDown={() => {
                    plusMenuClosedByActionRef.current = false
                    plusMenuCloseFocusTextareaRef.current = false
                  }}
                  onCloseAutoFocus={(event) => {
                    const closeFocusTextarea = plusMenuCloseFocusTextareaRef.current
                    const closedByAction = plusMenuClosedByActionRef.current
                    plusMenuCloseFocusTextareaRef.current = false
                    plusMenuClosedByActionRef.current = false
                    if (closeFocusTextarea) {
                      event.preventDefault()
                      const ta = textareaRef.current
                      if (ta !== null && ta.isConnected && !ta.disabled) {
                        ta.focus({ preventScroll: true })
                      }
                      return
                    }
                    const active = document.activeElement
                    const anotherTargetFocused =
                      active !== null && active !== document.body && active !== document.documentElement
                    if (closedByAction || anotherTargetFocused) {
                      event.preventDefault()
                    }
                  }}
                >
                  <DropdownMenuItem
                    className="composer-plus-menu-item"
                    disabled={uploadDisabled}
                    onSelect={() => {
                      plusMenuClosedByActionRef.current = true
                      onOpenFilePicker()
                    }}
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
                          onSelect={() => {
                            plusMenuClosedByActionRef.current = true
                            onRunMenuCommand?.(cmd)
                          }}
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
