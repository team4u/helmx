/**
 * Pure state, validation, navigation, and classification helpers for AskDock
 * (zero React/DOM dependencies; Fast Refresh compliant).
 */
import type {
  AskAnswers,
  AskFieldSpec,
  AskKind,
  AskSpec,
} from '@helmx/protocol/browser'

export interface TerminalSnapshot {
  source: 'context' | 'description'
  text: string
  prefix?: string
}

function lastLines(text: string, max: number): string {
  const lines = text.replace(/\s+$/, '').split('\n')
  return lines.length <= max ? lines.join('\n') : lines.slice(-max).join('\n')
}

/**
 * Extract the terminal snapshot (last 40 lines) from the ask extension field
 * `terminalSnapshot` or from a fenced block in resolved `descriptionText`.
 */
export function extractTerminalSnapshot(ask: AskSpec, descriptionText: string): TerminalSnapshot | undefined {
  const extra = ask as AskSpec & { context?: { terminalSnapshot?: unknown } }
  const fromContext = extra.context?.terminalSnapshot
  if (typeof fromContext === 'string' && fromContext.trim() !== '') {
    return { source: 'context', text: lastLines(fromContext, 40) }
  }
  const marker = descriptionText.indexOf('```')
  if (marker !== -1) {
    const prefix = descriptionText.slice(0, marker).trim()
    let body = descriptionText.slice(marker + 3)
    const firstNewline = body.indexOf('\n')
    if (firstNewline !== -1) {
      body = body.slice(firstNewline + 1)
    }
    const closing = body.lastIndexOf('```')
    if (closing !== -1) {
      body = body.slice(0, closing)
    }
    if (body.trim() !== '') {
      return { source: 'description', text: lastLines(body, 40), ...(prefix !== '' ? { prefix } : {}) }
    }
  }
  return undefined
}

export function resolveAskKind(ask: Pick<AskSpec, 'kind'>): AskKind {
  return ask.kind === 'question' ? 'question' : 'approval'
}

export function isMultiChoiceField(field: AskFieldSpec): boolean {
  return field.type === 'choice' && field.multiple === true
}

export function shouldUseQuestionStepper(ask: Pick<AskSpec, 'kind' | 'fields'>): boolean {
  return resolveAskKind(ask) === 'question' && ask.fields.length >= 2
}

export function initialAskAnswers(fields: ReadonlyArray<AskFieldSpec>): AskAnswers {
  const initial: AskAnswers = {}
  for (const field of fields) {
    if (isMultiChoiceField(field)) {
      if (Array.isArray(field.defaultValue) && field.defaultValue.length > 0) {
        initial[field.name] = [...field.defaultValue]
      }
    } else if (typeof field.defaultValue === 'string' && field.defaultValue !== '') {
      initial[field.name] = field.defaultValue
    }
  }
  return initial
}

export function isFieldAnswered(field: AskFieldSpec, answers: AskAnswers): boolean {
  const val = answers[field.name]
  if (isMultiChoiceField(field)) {
    return Array.isArray(val) && val.some((item) => item.trim() !== '')
  }
  return typeof val === 'string' && val.trim() !== ''
}

export function missingRequiredFields(ask: Pick<AskSpec, 'fields'>, answers: AskAnswers): AskFieldSpec[] {
  return ask.fields.filter((f) => f.required === true && !isFieldAnswered(f, answers))
}

/** Find the next unanswered step index after `fromIndex` (wrapping around), or `-1` if all steps are answered. */
export function findNextUnansweredStep(
  ask: Pick<AskSpec, 'fields'>,
  answers: AskAnswers,
  fromIndex: number,
): number {
  const total = ask.fields.length
  if (total === 0) return -1
  for (let offset = 1; offset < total; offset++) {
    const idx = (fromIndex + offset) % total
    const field = ask.fields[idx]
    if (field !== undefined && !isFieldAnswered(field, answers)) {
      return idx
    }
  }
  return -1
}

export function isSingleRequiredConfirm(ask: Pick<AskSpec, 'fields'>): boolean {
  return ask.fields.length === 1 && ask.fields[0]?.type === 'confirm' && ask.fields[0].required !== false
}

/** Single-question, single-select `question` prompts submit immediately on option click. */
export function isSingleQuickChoiceQuestion(ask: Pick<AskSpec, 'kind' | 'fields'>): boolean {
  return (
    resolveAskKind(ask) === 'question' &&
    ask.fields.length === 1 &&
    ask.fields[0]?.type === 'choice' &&
    ask.fields[0].multiple !== true
  )
}

/** Promote the sole question text directly into the card header when the title is generic or identical. */
export function shouldPromoteFieldLabelToHeader(
  ask: Pick<AskSpec, 'kind' | 'fields'>,
  titleText: string,
  firstFieldLabel: string,
): boolean {
  if (resolveAskKind(ask) !== 'question' || ask.fields.length !== 1) return false
  const trimmedTitle = titleText.trim()
  return (
    trimmedTitle === '' ||
    trimmedTitle === 'Clarifying Questions' ||
    trimmedTitle === '问题确认' ||
    trimmedTitle === firstFieldLabel.trim()
  )
}

export function resolveAskKeyboardChoiceTarget(
  ask: Pick<AskSpec, 'fields'>,
  isStepper: boolean,
  activeStep: number,
): { field: AskFieldSpec; fieldIndex: number } | undefined {
  if (isStepper) {
    const active = ask.fields[activeStep]
    return active?.type === 'choice' ? { field: active, fieldIndex: activeStep } : undefined
  }
  const choiceIndices = ask.fields
    .map((field, index) => (field.type === 'choice' ? index : -1))
    .filter((index) => index >= 0)
  if (choiceIndices.length !== 1) return undefined
  const idx = choiceIndices[0]!
  const field = ask.fields[idx]
  return field !== undefined ? { field, fieldIndex: idx } : undefined
}

/**
 * Only auto-focus a newly opened AskDock when focus is neutral (`null` / `body` / `html`),
 * already inside `formEl`, or sitting inside an empty `.composer-textarea` (never hijack
 * non-empty drafts, search boxes, popovers, or modals).
 */
export function shouldAutoFocusAskDock(activeElement: Element | null, formEl: HTMLElement | null): boolean {
  if (formEl === null) return false
  if (activeElement === null) return true
  if (formEl.contains(activeElement)) return true
  const tag = activeElement.tagName
  if (tag === 'BODY' || tag === 'HTML') return true
  if (
    tag === 'TEXTAREA' &&
    activeElement.classList.contains('composer-textarea') &&
    (activeElement as HTMLTextAreaElement).value === ''
  ) {
    return true
  }
  return false
}

export function isPresetOptionValue(field: AskFieldSpec, value: string): boolean {
  return (field.options ?? []).some((o) => o.value === value)
}

/** Build the ordered multi-select array from preset selections and an optional custom text entry. */
export function composeMultiChoiceValues(
  field: AskFieldSpec,
  selectedPresets: ReadonlyArray<string>,
  customText: string | undefined,
): string[] {
  const presetOrder = new Set<string>()
  const out: string[] = []
  for (const val of selectedPresets) {
    if (isPresetOptionValue(field, val) && !presetOrder.has(val)) {
      presetOrder.add(val)
      out.push(val)
    }
  }
  const trimmedCustom = customText?.trim() ?? ''
  if (trimmedCustom !== '' && !presetOrder.has(trimmedCustom)) {
    out.push(trimmedCustom)
  }
  return out
}
