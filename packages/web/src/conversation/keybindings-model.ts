/**
 * Pure keyboard-flow logic for the Composer / standby pane (single-key muscle
 * memory, zero multi-key aliases). The Ctrl+L model-picker toggle bridge
 * (helmx:shortcut panel events) lives in @helmx/plugin-client's shared
 * model-picker module together with ModelPickerControl.
 *
 * Strictly one function per shortcut:
 * - ↑: with an empty draft on the first line, prefer withdrawing the newest
 *   human queued input of this conversation; only fall back to history editing
 *   when the queue is empty (no Alt+Up alias);
 * - Enter / Mod+Enter / Shift+Enter: idle send / busy steer / busy followUp /
 *   newline (no Alt+Enter alias);
 * - Esc: close input-area popovers (stopPropagation prevents an outer double-Esc
 *   from aborting by accident) -> cancel history-edit mode -> let the outer
 *   double-Esc abort.
 *
 * This module exports only pure constants and pure functions (no components),
 * honoring the .tsx Fast Refresh rule.
 */
import type { QueuedConversationInput } from '@helmx/protocol/browser'

/** Display labels for the one-shortcut-per-function map (for desktop .kbd-hint
 * and tooltips; multi-key aliases are forbidden). */
export const COMPOSER_SHORTCUTS = {
  toggleModelPicker: 'Ctrl+L',
  togglePlusMenu: 'Ctrl+;',
  togglePlanMode: 'Ctrl+.',
  recallQueuedOrHistory: '↑',
  sendOrSteer: 'Enter',
  followUpWhenBusy: '⌘/Ctrl+Enter',
  newline: 'Shift+Enter',
  dismissOrCancelEdit: 'Esc',
} as const

export interface KeyModifiersShape {
  key: string
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}

/** Strictly match the plain ↑ key (no Shift/Ctrl/Meta/Alt); Alt+Up and other
 * multi-key aliases are forbidden. */
export function isPlainArrowUpEvent(e: KeyModifiersShape): boolean {
  return e.key === 'ArrowUp' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey
}

/** Match the submitting Enter / Mod+Enter (excluding Shift+Enter newline and
 * the illegal Alt+Enter alias). */
export function isComposerSubmitEnterEvent(e: Pick<KeyModifiersShape, 'key' | 'shiftKey' | 'altKey'>): boolean {
  return e.key === 'Enter' && !e.shiftKey && !e.altKey
}

/** Whether the caret sits on the text's first line (no preceding newline). */
export function isCaretAtFirstLine(value: string, selectionStart: number | null): boolean {
  const pos = Math.max(0, Math.min(value.length, selectionStart ?? 0))
  return !value.slice(0, pos).includes('\n')
}

/** Allow ↑ to trigger queued recall / history-edit prefill only when the draft
 * is empty and the caret is on the first line. */
export function canRecallOnArrowUp(value: string, selectionStart: number | null): boolean {
  return value === '' && isCaretAtFirstLine(value, selectionStart)
}

/**
 * Pick the newest human (origin === 'human') queued input from the current
 * conversation's live.queuedInputs.
 * - Entries from non-human origins (agent / trigger) or without a valid
 *   submissionId are always skipped;
 * - The newest is selected by the greatest createdAt; ties take the queue tail
 *   (last occurrence).
 */
export function latestHumanQueuedInput(
  queuedInputs: ReadonlyArray<QueuedConversationInput> | undefined,
): QueuedConversationInput | undefined {
  if (!Array.isArray(queuedInputs) || queuedInputs.length === 0) return undefined
  let latest: QueuedConversationInput | undefined
  for (const item of queuedInputs) {
    if (
      item === null ||
      item === undefined ||
      item.origin !== 'human' ||
      typeof item.submissionId !== 'string' ||
      item.submissionId === '' ||
      typeof item.text !== 'string'
    ) {
      continue
    }
    if (latest === undefined) {
      latest = item
      continue
    }
    const itemTs = typeof item.createdAt === 'number' && Number.isFinite(item.createdAt) ? item.createdAt : 0
    const latestTs = typeof latest.createdAt === 'number' && Number.isFinite(latest.createdAt) ? latest.createdAt : 0
    if (itemTs >= latestTs) {
      latest = item
    }
  }
  return latest
}
