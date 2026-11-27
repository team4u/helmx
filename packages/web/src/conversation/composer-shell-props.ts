/**
 * Pure prop-group builders for `ComposerInputShell`, shared by the active-conversation `Composer`
 * and the standby `StandbyComposer`. Why: the two inputs differ only in where the draft lives and in
 * labels / disabled flags / menu contents; the textarea completion wiring, the drag-and-drop attributes,
 * the plus-menu file binding and the popover state mapping are identical and must never fork.
 * Exports only functions / TS types (no components), honoring the .ts Fast Refresh rule.
 */
import type * as React from 'react'
import type {
  ComposerCompletionGroupProps,
  ComposerDndGroupProps,
  ComposerDraftGroupProps,
  ComposerPlusMenuGroupProps,
} from './ComposerInputShell.js'
import type { UseComposerAttachmentsResult } from './use-composer-attachments.js'
import type { UseComposerCompletionsResult } from './use-composer-completions.js'

/** The attachment-hook surface the plus menu binds: the hidden file input plus its picker / change handlers. */
export type PlusMenuFileHandlers = Pick<
  UseComposerAttachmentsResult,
  'fileInputRef' | 'openFilePicker' | 'onFileInputChange'
>

/** Caller-specific plus-menu content; the file binding is always supplied by the attachment hook. */
export type PlusMenuContent = Omit<
  ComposerPlusMenuGroupProps,
  'fileInputRef' | 'onOpenFilePicker' | 'onFileInputChange'
>

export interface ComposerDraftGroupOptions {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  ariaLabel: string
  value: string
  placeholder: string
  readOnly?: boolean
  /** Persist the new draft text; the two inputs write to different draft stores. */
  onDraftTextChange: (nextValue: string) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  completions: UseComposerCompletionsResult
  fileHandlers: Pick<UseComposerAttachmentsResult, 'onPaste'>
}

/** Textarea group: text changes persist first and then re-detect trigger popovers; keyup / click feed the completion hook. */
export function buildComposerDraftGroup(options: ComposerDraftGroupOptions): ComposerDraftGroupProps {
  const { textareaRef, ariaLabel, value, placeholder, readOnly, onDraftTextChange, onKeyDown, completions, fileHandlers } = options
  return {
    textareaRef,
    ariaLabel,
    value,
    ...(readOnly !== undefined ? { readOnly } : {}),
    placeholder,
    onTextChange: (nextValue, caret) => {
      onDraftTextChange(nextValue)
      completions.detectPopover(nextValue, caret)
    },
    onKeyUp: completions.handleTextareaKeyUp,
    onClick: completions.handleTextareaClick,
    onKeyDown,
    onPaste: fileHandlers.onPaste,
  }
}

/** Drag-and-drop group: the attachment hook's handlers are passed through unchanged (same identities). */
export function buildComposerDndGroup(fileHandlers: UseComposerAttachmentsResult): ComposerDndGroupProps {
  const { dragging, onDragEnter, onDragOver, onDragLeave, onDrop } = fileHandlers
  return { dragging, onDragEnter, onDragOver, onDragLeave, onDrop }
}

/** Plus menu: file input binding from the attachment hook, everything else from the caller. */
export function buildComposerPlusMenuGroup(fileHandlers: PlusMenuFileHandlers, menu: PlusMenuContent): ComposerPlusMenuGroupProps {
  const { uploadButtonLabel, ...content } = menu
  return {
    fileInputRef: fileHandlers.fileInputRef,
    uploadButtonLabel,
    onOpenFilePicker: fileHandlers.openFilePicker,
    onFileInputChange: fileHandlers.onFileInputChange,
    ...content,
  }
}

/** Popover state mapping: the completion hook's state and pick / close actions under the shell's prop names. */
export function buildComposerCompletionGroup(completions: UseComposerCompletionsResult): ComposerCompletionGroupProps {
  return {
    slashOpen: completions.slashOpen,
    popoverQuery: completions.popoverQuery,
    slashMenuItems: completions.slashMenuItems,
    onPickSlash: completions.applySlashPick,
    onCloseSlash: completions.closeSlashPopover,
    completionOpen: completions.completionOpen,
    completionTrigger: completions.completionTrigger,
    completionSnapshot: completions.completionSnapshot,
    onPickCompletion: completions.applyCompletionPick,
    onCloseCompletion: completions.closeCompletionPopover,
  }
}
