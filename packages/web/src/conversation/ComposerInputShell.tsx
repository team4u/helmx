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
} from '@helmx/ui'
import { useWebLocale } from '../i18n/use-web-locale.js'
import type { QualifiedCommand, SlashMenuItem } from '../lib/commands-model.js'
import { isElementVisibleInDocument } from '../lib/dom-visibility.js'
import { formatBytes } from '../lib/format.js'
import type { HelmxShortcutDetail } from '../shell/shortcuts-model.js'
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

export interface ComposerDraftGroupProps {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  ariaLabel: string
  value: string
  placeholder: string
  readOnly?: boolean
  onTextChange: (value: string, caret: number) => void
  onKeyUp: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onClick: (e: React.MouseEvent<HTMLTextAreaElement>) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onPaste: (e: React.ClipboardEvent) => void
}

export interface ComposerDndGroupProps {
  dragging: boolean
  onDragEnter: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onDragLeave: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
}

export interface ComposerPlusMenuGroupProps {
  fileInputRef: React.RefObject<HTMLInputElement | null>
  uploadButtonLabel: string
  uploadDisabled?: boolean
  disabled?: boolean
  onOpenFilePicker: () => void
  onFileInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  renderSlot?: (closeMenu: () => void) => React.ReactNode
  commands?: ReadonlyArray<QualifiedCommand>
  commandsDisabled?: boolean
  onRunCommand?: (cmd: QualifiedCommand) => void
}

export interface ComposerCompletionGroupProps {
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
}

export interface ComposerSlotsProps {
  aboveBox?: React.ReactNode
  boxBanner?: React.ReactNode
  modelPicker: React.ReactNode
  toolbar?: React.ReactNode
  sendControls: React.ReactNode
  statusRow?: React.ReactNode
}

export interface ComposerShortcutScopeProps {
  panel?: 'primary' | 'split' | 'drawer'
  drawerConversationId?: number
  active?: boolean
}

export interface ComposerInputShellProps {
  attachments: ReadonlyArray<ComposerAttachmentItem>
  draft: ComposerDraftGroupProps
  dnd: ComposerDndGroupProps
  plusMenu: ComposerPlusMenuGroupProps
  completions: ComposerCompletionGroupProps
  slots: ComposerSlotsProps
  shortcuts?: ComposerShortcutScopeProps
}

export function ComposerInputShell({
  attachments,
  draft,
  dnd,
  plusMenu,
  completions,
  slots,
  shortcuts,
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

  const shortcutPanel = shortcuts?.panel ?? 'primary'
  const shortcutDrawerConversationId = shortcuts?.drawerConversationId
  const shortcutActive = shortcuts?.active ?? true
  const plusMenuDisabled = plusMenu.disabled ?? false
  const uploadDisabled = plusMenu.uploadDisabled ?? false
  const menuCommandsDisabled = plusMenu.commandsDisabled ?? false
  const { textareaRef } = draft

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
    plusMenu.renderSlot !== undefined || (plusMenu.commands !== undefined && plusMenu.commands.length > 0)

  return (
    <div className="composer-shell">
      <div className="composer-inner">
        {slots.aboveBox}
        <div
          className="composer-box"
          ref={composerBoxRef}
          data-dragging={dnd.dragging ? 'true' : undefined}
          onDragEnter={dnd.onDragEnter}
          onDragOver={dnd.onDragOver}
          onDragLeave={dnd.onDragLeave}
          onDrop={dnd.onDrop}
        >
          {slots.boxBanner}
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
            aria-label={draft.ariaLabel}
            ref={textareaRef}
            className="composer-textarea selectable"
            data-composer-draft-managed="true"
            value={draft.value}
            rows={1}
            readOnly={draft.readOnly ?? false}
            placeholder={draft.placeholder}
            onChange={(e) => draft.onTextChange(e.target.value, e.target.selectionStart ?? e.target.value.length)}
            onKeyUp={draft.onKeyUp}
            onClick={draft.onClick}
            onKeyDown={draft.onKeyDown}
            onPaste={draft.onPaste}
            enterKeyHint="send"
            spellCheck={false}
          />
          {completions.slashOpen ? (
            <CommandPopover
              query={completions.popoverQuery}
              slashItems={completions.slashMenuItems}
              onPick={completions.onPickSlash}
              onClose={completions.onCloseSlash}
              anchorRef={composerBoxRef}
              inputRef={textareaRef}
            />
          ) : null}
          <CompletionPopover
            open={completions.completionOpen}
            trigger={completions.completionTrigger}
            snapshot={completions.completionSnapshot}
            onPick={completions.onPickCompletion}
            onClose={completions.onCloseCompletion}
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
                    icon="paperclip"
                    disabled={uploadDisabled}
                    onSelect={() => {
                      plusMenuClosedByActionRef.current = true
                      plusMenu.onOpenFilePicker()
                    }}
                  >
                    {plusMenu.uploadButtonLabel}
                  </DropdownMenuItem>
                  {hasToolsSection ? (
                    <div className="composer-plus-menu-group">
                      <DropdownMenuSeparator />
                      {plusMenu.renderSlot?.(closePlusMenu)}
                      {plusMenu.commands?.map((cmd) => (
                        <DropdownMenuItem
                          key={`cmd:${cmd.pluginId}/${cmd.spec.id}`}
                          icon={cmd.spec.icon ?? 'terminal'}
                          shortcut={cmd.spec.slash !== undefined ? `/${cmd.spec.slash}` : undefined}
                          disabled={menuCommandsDisabled}
                          onSelect={() => {
                            plusMenuClosedByActionRef.current = true
                            plusMenu.onRunCommand?.(cmd)
                          }}
                        >
                          {resolveLocalizedText(cmd.spec.title, locale)}
                        </DropdownMenuItem>
                      ))}
                    </div>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenuRoot>
              {slots.modelPicker}
              {slots.toolbar}
              <input
                ref={plusMenu.fileInputRef}
                type="file"
                multiple
                className="composer-file-input"
                disabled={uploadDisabled}
                onChange={plusMenu.onFileInputChange}
              />
            </div>
            {slots.sendControls}
          </div>
        </div>
        {slots.statusRow !== undefined ? <div className="composer-status-row">{slots.statusRow}</div> : null}
      </div>
    </div>
  )
}
